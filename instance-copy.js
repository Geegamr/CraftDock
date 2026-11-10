// Copy an instance folder while proving that every regular file arrived with
// the same SHA-256 digest as the source. The destination is created fresh; the
// caller copies into a staging folder and only registers it after this returns.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const COPY_CANCELLED = 'ECOPY_CANCELLED';

function cancelledError() {
  const error = new Error('Copy cancelled');
  error.code = COPY_CANCELLED;
  return error;
}

async function hashFile(filePath, options = {}) {
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : null;
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), new Transform({
    transform(chunk, _encoding, callback) {
      if (isCancelled?.()) return callback(cancelledError());
      hash.update(chunk);
      callback(null, chunk);
    },
  }), new Transform({
    transform(_chunk, _encoding, callback) { callback(); },
  }));
  return hash.digest('hex');
}

// One read of the source feeds both the copy and the source digest. The copy's
// own digest is then read back. A source that changed while it was being read
// fails the size/mtime check and is retried once.
async function copyFileVerified(from, to, options = {}) {
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (isCancelled?.()) throw cancelledError();
      const before = await fsp.stat(from);
      if (!before.isFile()) throw new Error('source is not a regular file');
      await fsp.rm(to, { force: true });

      const hash = crypto.createHash('sha256');
      const hasher = new Transform({
        transform(chunk, _encoding, callback) {
          if (isCancelled?.()) return callback(cancelledError());
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        fs.createReadStream(from),
        hasher,
        fs.createWriteStream(to, { flags: 'wx' }),
      );

      const sourceHash = hash.digest('hex');
      if (isCancelled?.()) throw cancelledError();
      const target = await fsp.stat(to);
      const targetHash = await hashFile(to, { isCancelled });
      const after = await fsp.stat(from);
      if (target.size !== before.size) throw new Error('copied size does not match');
      if (targetHash !== sourceHash) throw new Error('copied SHA-256 does not match');
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new Error('source changed while it was copied');
      }

      // Content is what matters for the digest; keep the timestamps too so a
      // clone looks like the instance it came from.
      await fsp.utimes(to, before.atime, before.mtime).catch(() => {});
      await fsp.chmod(to, before.mode & 0o777).catch(() => {});
      return { bytes: before.size, sha256: targetHash };
    } catch (error) {
      if (error?.code === COPY_CANCELLED) throw error;
      lastError = error;
      try { await fsp.rm(to, { force: true }); } catch (_) {}
    }
  }
  throw new Error(`Could not verify ${path.basename(from)}: ${lastError?.message || 'copy failed'}`);
}

async function countTree(dir, state, checkpoint) {
  if (checkpoint) await checkpoint();
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (checkpoint) await checkpoint();
    const full = path.join(dir, entry.name);
    const stat = await fsp.lstat(full);
    if (stat.isDirectory()) {
      await countTree(full, state, checkpoint);
    } else if (stat.isFile()) {
      state.files += 1;
      state.bytes += stat.size;
    } else if (stat.isSymbolicLink()) {
      state.links += 1;
    } else {
      throw new Error(`Unsupported file type in instance: ${full}`);
    }
  }
}

async function copyTree(src, dest, state, onProgress, checkpoint, isCancelled) {
  if (checkpoint) await checkpoint();
  const stat = await fsp.lstat(src);
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    if (checkpoint) await checkpoint();
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    const entryStat = await fsp.lstat(from);

    if (entryStat.isSymbolicLink()) {
      const target = await fsp.readlink(from);
      let type = 'file';
      try {
        if ((await fsp.stat(from)).isDirectory()) {
          type = process.platform === 'win32' ? 'junction' : 'dir';
        }
      } catch (_) {}
      await fsp.symlink(target, to, type);
      const copiedTarget = await fsp.readlink(to);
      if (copiedTarget !== target) throw new Error(`Link target mismatch for ${entry.name}`);
      state.copiedLinks += 1;
    } else if (entryStat.isDirectory()) {
      await copyTree(from, to, state, onProgress, checkpoint, isCancelled);
    } else if (entryStat.isFile()) {
      const result = await copyFileVerified(from, to, { isCancelled });
      state.copiedFiles += 1;
      state.copiedBytes += result.bytes;
    } else {
      throw new Error(`Unsupported file type in instance: ${from}`);
    }

    onProgress?.({
      copiedFiles: state.copiedFiles,
      totalFiles: state.totalFiles,
      copiedBytes: state.copiedBytes,
      totalBytes: state.totalBytes,
      copiedLinks: state.copiedLinks,
      totalLinks: state.totalLinks,
    });
  }

  await fsp.utimes(dest, stat.atime, stat.mtime).catch(() => {});
}

// Remove a copied tree without following junctions/symlinks. Used when a copy
// fails before it is registered; unlinking the link leaves shared folders alone.
async function removeTree(target) {
  let stat;
  try { stat = await fsp.lstat(target); } catch (_) { return; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    await fsp.rm(target, { force: true }).catch(() => {});
    return;
  }
  let entries = [];
  try { entries = await fsp.readdir(target, { withFileTypes: true }); } catch (_) {}
  for (const entry of entries) {
    await removeTree(path.join(target, entry.name));
  }
  await fsp.rmdir(target).catch(() => {});
}

async function copyInstanceDirectory(srcDir, destDir, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const checkpoint = typeof options.onCheckpoint === 'function' ? options.onCheckpoint : null;
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : null;
  const totals = { files: 0, bytes: 0, links: 0 };
  await countTree(srcDir, totals, checkpoint);
  if (checkpoint) await checkpoint();

  // Do not delete or overwrite anything here: a caller that points at an
  // existing folder should fail, not lose it.
  await fsp.mkdir(destDir);
  const state = {
    copiedFiles: 0,
    copiedBytes: 0,
    copiedLinks: 0,
    totalFiles: totals.files,
    totalBytes: totals.bytes,
    totalLinks: totals.links,
  };
  onProgress?.({
    copiedFiles: 0,
    totalFiles: state.totalFiles,
    copiedBytes: 0,
    totalBytes: state.totalBytes,
    copiedLinks: 0,
    totalLinks: state.totalLinks,
  });
  try {
    await copyTree(srcDir, destDir, state, onProgress, checkpoint, isCancelled);
    if (checkpoint) await checkpoint();
    if (state.copiedFiles !== totals.files || state.copiedLinks !== totals.links) {
      throw new Error('Not every file was copied');
    }
  } catch (error) {
    await removeTree(destDir);
    throw error;
  }

  return {
    files: state.copiedFiles,
    bytes: state.copiedBytes,
    links: state.copiedLinks,
  };
}

module.exports = {
  copyInstanceDirectory,
  copyFileVerified,
  hashFile,
  removeTree,
};
