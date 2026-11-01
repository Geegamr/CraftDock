// Shared, bounded on-disk cache for browse results.
//
// Every browse surface (the Browse tab and the per-instance "Add Mod" window,
// plus the resource/shader browsers) keeps its last *results* here so a panel
// can paint instantly and then refresh in the background. Installs and file
// downloads are never cached — only the metadata rows the list renders.
//
// The cache is deliberately small: at most `maxEntries` queries, at most
// `maxItemsPerEntry` rows per query, and a hard byte budget. Least-recently
// used queries are evicted first, and entries expire after `ttlMs`.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  maxEntries: 60,
  maxItemsPerEntry: 40,
  maxBytes: 256 * 1024,
  maxEntryBytes: 128 * 1024,
  ttlMs: 24 * 60 * 60 * 1000,
};

// Keys come from the renderer, so keep them short, ASCII and case-insensitive —
// both mod browsers build the same key for the same filters.
function normalizeKey(key) {
  if (typeof key !== 'string') return '';
  return key.trim().toLowerCase().replace(/[^\x20-\x7e]/g, '').slice(0, 240);
}

// Only plain, JSON-serializable rows survive; anything a JSON round-trip drops
// (functions, undefined) is skipped so the on-disk file always reloads cleanly.
function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  const clean = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    try {
      const parsed = JSON.parse(JSON.stringify(item));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) clean.push(parsed);
    } catch (_) { /* unrepresentable row — skip it */ }
  }
  return clean;
}

const byteSize = value => Buffer.byteLength(JSON.stringify(value));

function createBrowseCacheStore(options = {}) {
  const filePath = options.filePath;
  const now = options.now || Date.now;
  const limits = {
    maxEntries: options.maxEntries || DEFAULTS.maxEntries,
    maxItemsPerEntry: options.maxItemsPerEntry || DEFAULTS.maxItemsPerEntry,
    maxBytes: options.maxBytes || DEFAULTS.maxBytes,
    maxEntryBytes: options.maxEntryBytes || DEFAULTS.maxEntryBytes,
    ttlMs: options.ttlMs || DEFAULTS.ttlMs,
  };

  let loaded = false;
  let entries = Object.create(null);

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') return;
      for (const [key, entry] of Object.entries(parsed.entries)) {
        const normalized = normalizeKey(key);
        if (!normalized || !entry || !Array.isArray(entry.items)) continue;
        entries[normalized] = {
          items: sanitizeItems(entry.items),
          total: Number(entry.total) || 0,
          savedAt: Number(entry.savedAt) || 0,
          lastUsed: Number(entry.lastUsed) || 0,
        };
      }
    } catch (_) {
      entries = Object.create(null);
    }
  }

  const snapshot = () => ({ version: 1, entries });
  const size = () => byteSize(snapshot());

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot()));
      fs.renameSync(tmp, filePath);
      return true;
    } catch (_) {
      return false;
    }
  }

  function dropExpired() {
    const at = now();
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.savedAt && at - entry.savedAt > limits.ttlMs) delete entries[key];
    }
  }

  function read(key) {
    load();
    const normalized = normalizeKey(key);
    if (!normalized) return null;
    const entry = entries[normalized];
    if (!entry) return null;
    if (entry.savedAt && now() - entry.savedAt > limits.ttlMs) {
      delete entries[normalized];
      return null;
    }
    entry.lastUsed = now();
    return {
      items: entry.items.map(item => ({ ...item })),
      total: entry.total,
      savedAt: entry.savedAt,
      cached: true,
    };
  }

  function evictToFit(keepKey) {
    const oldestFirst = () => Object.keys(entries)
      .filter(key => key !== keepKey)
      .sort((a, b) => (entries[a].lastUsed || entries[a].savedAt) - (entries[b].lastUsed || entries[b].savedAt));

    while (Object.keys(entries).length > limits.maxEntries) {
      const victim = oldestFirst()[0];
      if (!victim) break;
      delete entries[victim];
    }
    while (size() > limits.maxBytes) {
      const victim = oldestFirst()[0];
      if (!victim) break;
      delete entries[victim];
    }
    // A single oversized query never gets to blow the budget: shrink it.
    if (size() > limits.maxBytes && entries[keepKey]) {
      const entry = entries[keepKey];
      while (entry.items.length > 1 && size() > limits.maxBytes) entry.items.pop();
    }
  }

  function write(key, payload = {}) {
    load();
    const normalized = normalizeKey(key);
    if (!normalized) return { success: false, error: 'Invalid cache key' };
    let items = sanitizeItems(payload.items).slice(0, limits.maxItemsPerEntry);
    if (!items.length) return { success: false, error: 'Nothing to cache' };

    while (items.length > 1 && byteSize(items) > limits.maxEntryBytes) items = items.slice(0, -1);

    const savedAt = now();
    const declaredTotal = Number(payload.total);
    entries[normalized] = {
      items,
      total: Number.isFinite(declaredTotal) ? Math.max(declaredTotal, items.length) : items.length,
      savedAt,
      lastUsed: savedAt,
    };
    dropExpired();
    evictToFit(normalized);
    const persisted = save();
    return { success: persisted, entries: Object.keys(entries).length, bytes: size() };
  }

  function clear() {
    loaded = true;
    entries = Object.create(null);
    save();
    return { success: true, entries: 0, bytes: size() };
  }

  function stats() {
    load();
    const keys = Object.keys(entries);
    return {
      entries: keys.length,
      items: keys.reduce((sum, key) => sum + entries[key].items.length, 0),
      bytes: size(),
      maxEntries: limits.maxEntries,
      maxItemsPerEntry: limits.maxItemsPerEntry,
      maxBytes: limits.maxBytes,
      ttlMs: limits.ttlMs,
    };
  }

  return { read, write, clear, stats, filePath };
}

module.exports = { createBrowseCacheStore, normalizeKey, DEFAULTS };
