// App-data backups are plain folder copies: accounts, settings, instances,
// servers, skins, and shared tag folders. Everything here can be read with a
// file manager and restored by copying it back while CraftDock is closed.
//
// Redownloadable runtime data is deliberately skipped: client-cache/ holds
// Minecraft jars, libraries, assets, and loader caches, while data/java holds
// the private Java runtimes. Both can be many gigabytes and are recreated on
// demand.
const fs = require('node:fs');
const path = require('node:path');

const BACKUP_FORMAT = 'craftdock-app-backup';
const BACKUP_VERSION = 1;
const BACKUP_MANIFEST = 'craftdock-backup.json';
const EXCLUDED_PATHS = Object.freeze([
  'client-cache',
  'data/java',
  'data/browse-cache.json',
]);

function normalizeRelative(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function isExcluded(relativePath) {
  const relative = normalizeRelative(relativePath);
  if (!relative) return false;
  return EXCLUDED_PATHS.some(excluded =>
    relative === excluded || relative.startsWith(`${excluded}/`));
}

function timestampForFolder(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function uniqueBackupDirectory(parent, date) {
  const base = `CraftDock Backup ${timestampForFolder(date)}`;
  let candidate = path.join(parent, base);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${base} (${suffix++})`);
  }
  return candidate;
}

async function measureIncludedTree(root) {
  let files = 0;
  let bytes = 0;
  async function visit(directory, relative) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (isExcluded(childRelative)) continue;
      const childPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        files += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await visit(childPath, childRelative);
      } else if (entry.isFile()) {
        const stat = await fs.promises.stat(childPath);
        files += 1;
        bytes += stat.size;
      }
    }
  }
  await visit(root, '');
  return { files, bytes };
}

async function createAppDataBackup({
  dataRoot,
  destinationRoot,
  appVersion = '',
  now = new Date(),
} = {}) {
  let destination = null;
  try {
    const source = path.resolve(String(dataRoot || ''));
    const parent = path.resolve(String(destinationRoot || ''));
    if (!dataRoot || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
      throw new Error('CraftDock data folder was not found');
    }
    if (!destinationRoot || !fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
      throw new Error('Choose an existing folder for the backup');
    }
    const relativeToSource = path.relative(source, parent);
    if (!relativeToSource || (!relativeToSource.startsWith('..') && !path.isAbsolute(relativeToSource))) {
      throw new Error('Choose a folder outside the CraftDock data folder');
    }

    const measured = await measureIncludedTree(source);
    destination = await uniqueBackupDirectory(parent, now);
    await fs.promises.mkdir(destination, { recursive: false });
    const backupDataRoot = path.join(destination, 'craftdock-data');
    await fs.promises.cp(source, backupDataRoot, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
      filter: sourcePath => {
        const relative = path.relative(source, sourcePath);
        return !isExcluded(relative);
      },
    });

    const manifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: now.toISOString(),
      appVersion: String(appVersion || ''),
      files: measured.files,
      bytes: measured.bytes,
      excluded: [...EXCLUDED_PATHS],
    };
    const manifestPath = path.join(destination, BACKUP_MANIFEST);
    const temporary = `${manifestPath}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(manifest, null, 2), 'utf8');
    await fs.promises.rename(temporary, manifestPath);

    return {
      success: true,
      path: destination,
      files: measured.files,
      bytes: measured.bytes,
      createdAt: manifest.createdAt,
    };
  } catch (error) {
    if (destination) {
      try { await fs.promises.rm(destination, { recursive: true, force: true }); } catch {}
    }
    return { success: false, error: error.message || 'Could not create the backup' };
  }
}

module.exports = {
  BACKUP_FORMAT,
  BACKUP_MANIFEST,
  BACKUP_VERSION,
  EXCLUDED_PATHS,
  createAppDataBackup,
  isExcluded,
  timestampForFolder,
  uniqueBackupDirectory,
};
