// Cleanup for Minecraft files that no instance or server still uses.
//
// Only client-cache/<version>/ and client-cache/loaders/* entries that cannot
// belong to an active Minecraft version are removed. Shared libraries, assets,
// and the private Java runtimes are never touched: deciding they are unused
// needs a full classpath/asset-index reference count, and deleting the wrong
// file would break every instance.
const fs = require('node:fs');
const path = require('node:path');

const SHARED_CACHE_DIRECTORIES = new Set(['assets', 'libraries', 'loaders']);
const MAX_SCAN_ENTRIES = 20000;

function activeVersionSet(versions) {
  return new Set((Array.isArray(versions) ? versions : [])
    .map(value => String(value || '').trim())
    .filter(Boolean));
}

function entryCouldBelongToVersion(name, activeVersions) {
  const value = String(name || '');
  if (!value) return true;
  if (activeVersions.has(value)) return true;
  for (const version of activeVersions) {
    if (value.includes(version)) return true;
  }
  return false;
}

async function measureEntry(entryPath) {
  let files = 0;
  let bytes = 0;
  let entries = 0;
  async function visit(current) {
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      files += 1;
      bytes += stat.size;
      entries += 1;
      if (entries > MAX_SCAN_ENTRIES) throw new Error('Cache entry is too large to scan safely');
      return;
    }
    if (!stat.isDirectory()) return;
    const children = await fs.promises.readdir(current, { withFileTypes: true });
    for (const child of children) {
      entries += 1;
      if (entries > MAX_SCAN_ENTRIES) throw new Error('Cache entry is too large to scan safely');
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        await visit(path.join(current, child.name));
      } else if (child.isFile()) {
        const childStat = await fs.promises.stat(path.join(current, child.name));
        files += 1;
        bytes += childStat.size;
      }
    }
  }
  await visit(entryPath);
  return { files, bytes };
}

function safeCacheEntry(cacheRoot, relative) {
  const normalized = String(relative || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new Error('Unsafe cache path');
  }
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe cache path');
  }
  const resolvedRoot = path.resolve(cacheRoot);
  const resolved = path.resolve(cacheRoot, ...parts);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('Unsafe cache path');
  return resolved;
}

async function collectUnusedEntries(dataRoot, activeVersions) {
  const cacheRoot = path.join(path.resolve(String(dataRoot || '')), 'client-cache');
  if (!fs.existsSync(cacheRoot)) return { entries: [], activeVersions: [...activeVersions] };
  const active = activeVersionSet(activeVersions);
  const candidates = [];

  for (const item of await fs.promises.readdir(cacheRoot, { withFileTypes: true })) {
    if (!item.isDirectory() || item.isSymbolicLink()) continue;
    if (SHARED_CACHE_DIRECTORIES.has(item.name)) continue;
    if (entryCouldBelongToVersion(item.name, active)) continue;
    candidates.push({ relative: item.name, kind: 'version' });
  }

  const loadersRoot = path.join(cacheRoot, 'loaders');
  if (fs.existsSync(loadersRoot)) {
    for (const item of await fs.promises.readdir(loadersRoot, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      if (entryCouldBelongToVersion(item.name, active)) continue;
      candidates.push({
        relative: path.posix.join('loaders', item.name),
        kind: item.isDirectory() ? 'loader' : 'loader-file',
      });
    }
  }

  const entries = [];
  for (const candidate of candidates) {
    const fullPath = safeCacheEntry(cacheRoot, candidate.relative);
    if (!fs.existsSync(fullPath)) continue;
    const measured = await measureEntry(fullPath);
    entries.push({ ...candidate, ...measured, path: fullPath });
  }
  entries.sort((left, right) => right.bytes - left.bytes || left.relative.localeCompare(right.relative));
  return { entries, activeVersions: [...active].sort() };
}

async function scanUnusedGameFiles(dataRoot, activeVersions) {
  try {
    if (!dataRoot || !fs.existsSync(dataRoot)) throw new Error('CraftDock data folder was not found');
    const collected = await collectUnusedEntries(dataRoot, activeVersions);
    return {
      success: true,
      entries: collected.entries.map(({ path: ignored, ...entry }) => entry),
      count: collected.entries.length,
      files: collected.entries.reduce((sum, entry) => sum + entry.files, 0),
      bytes: collected.entries.reduce((sum, entry) => sum + entry.bytes, 0),
      activeVersions: collected.activeVersions,
    };
  } catch (error) {
    return { success: false, error: error.message || 'Could not scan the Minecraft cache' };
  }
}

async function cleanUnusedGameFiles(dataRoot, activeVersions) {
  try {
    if (!dataRoot || !fs.existsSync(dataRoot)) throw new Error('CraftDock data folder was not found');
    const cacheRoot = path.join(path.resolve(String(dataRoot)), 'client-cache');
    const collected = await collectUnusedEntries(dataRoot, activeVersions);
    const removed = [];
    const failed = [];
    let files = 0;
    let bytes = 0;

    for (const entry of collected.entries) {
      try {
        const target = safeCacheEntry(cacheRoot, entry.relative);
        await fs.promises.rm(target, { recursive: true, force: true });
        removed.push(entry.relative);
        files += entry.files;
        bytes += entry.bytes;
      } catch (error) {
        failed.push({ relative: entry.relative, error: error.message });
      }
    }

    return {
      success: failed.length === 0,
      removed,
      failed,
      count: removed.length,
      files,
      bytes,
      error: failed.length ? 'Some unused files could not be removed' : undefined,
    };
  } catch (error) {
    return { success: false, removed: [], failed: [], count: 0, files: 0, bytes: 0, error: error.message };
  }
}

module.exports = {
  SHARED_CACHE_DIRECTORIES,
  scanUnusedGameFiles,
  cleanUnusedGameFiles,
};
