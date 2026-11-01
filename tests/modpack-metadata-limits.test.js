// A deflate stream can declare far more data than the archive carrying it: a
// 15 KB .zip can hold a 16 MB manifest whose JSON tree costs ~590 MB and ~1 s.
// The native inspector bounds inflation by the compressed entry's own size and
// rejects the impossible case with exit code 3; the wrapper must surface that
// rejection instead of silently re-parsing the same archive in JavaScript.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createModpackMetadataReader } = require('../modpack-metadata');
const { projectRoot } = require('./helpers/electron-app');

const readMetadata = createModpackMetadataReader({
  isPackaged: false,
  appDir: projectRoot,
  resourcesPath: projectRoot,
  platform: process.platform,
});

function zipWithDeflatedEntry(name, payload) {
  const compressed = zlib.deflateRawSync(payload);
  const nameBytes = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const localRecord = Buffer.concat([local, nameBytes, compressed]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); // deflate
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const centralRecord = Buffer.concat([central, nameBytes]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(localRecord.length, 16);

  return Buffer.concat([localRecord, centralRecord, eocd]);
}

// A valid JSON array of empty objects: the cheapest way to spend JSON-tree
// memory per input byte.
function denseArray(bytes) {
  const objects = Math.floor((bytes - 1) / 3);
  const body = Array.from({ length: objects }, () => '{}').join(',');
  const text = `[${body}]`;
  return Buffer.from(text.padEnd(bytes, ' '), 'utf8');
}

async function withTempArchive(buffer, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-manifest-'));
  const archive = path.join(directory, 'pack.zip');
  fs.writeFileSync(archive, buffer);
  try {
    return await callback(archive);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('a tiny archive declaring 16 MB of manifest is rejected, not re-parsed', async () => {
  const manifest = denseArray(16 * 1024 * 1024);
  const archive = zipWithDeflatedEntry('manifest.json', manifest);
  assert.ok(archive.length < 64 * 1024, `the bomb fixture is ${archive.length} bytes on disk`);

  await withTempArchive(archive, async archivePath => {
    // The fallback would look for manifest.json in these entries and fail with a
    // different message, so a rejection here proves the native path is surfaced.
    const started = Date.now();
    await assert.rejects(
      readMetadata(archivePath, 'cf', new Map()),
      /inflates past|expands past/i,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `the hostile manifest took ${elapsed}ms to reject`);
  });
});

test('just over the inflation bound is rejected too', async () => {
  const archive = zipWithDeflatedEntry('manifest.json', denseArray(2 * 1024 * 1024 + 1));
  assert.ok(archive.length < 64 * 1024);

  await withTempArchive(archive, async archivePath => {
    await assert.rejects(readMetadata(archivePath, 'cf', new Map()), /inflates past/i);
  });
});

test('a legitimate manifest at the bound still parses', async () => {
  const archive = zipWithDeflatedEntry('manifest.json', denseArray(2 * 1024 * 1024));
  assert.ok(archive.length < 64 * 1024, 'a legitimate dense manifest compresses well');

  await withTempArchive(archive, async archivePath => {
    const metadata = await readMetadata(archivePath, 'cf', new Map());
    assert.equal(metadata.packName, 'pack');
    assert.equal(metadata.mcVersion, '1.21.4');
    assert.equal(metadata.loader, '');
    assert.deepEqual(metadata.mods, []);
  });
});

test('an ordinary modpack manifest is unaffected', async () => {
  const manifest = {
    name: 'Probe Pack',
    minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.1.0', primary: true }] },
    files: Array.from({ length: 200 }, (_, index) => ({ projectID: index, fileID: index * 2 })),
  };
  const archive = zipWithDeflatedEntry('manifest.json', Buffer.from(JSON.stringify(manifest)));

  await withTempArchive(archive, async archivePath => {
    const metadata = await readMetadata(archivePath, 'cf', new Map());
    assert.equal(metadata.packName, 'Probe Pack');
    assert.equal(metadata.mcVersion, '1.20.1');
    assert.equal(metadata.loader, 'forge');
    assert.equal(metadata.loaderVersion, '47.1.0');
    assert.equal(metadata.mods.length, 200);
  });
});
