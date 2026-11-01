// Shared browse cache: one small, bounded store backs the Browse tab and the
// per-instance browsers so panels paint instantly and refresh afterwards.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createBrowseCacheStore } = require('../browse-cache');
const { loadApp, plain, withTempRoot } = require('./helpers/electron-app');

function withCacheRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-cache-'));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeStore(root, options = {}) {
  return createBrowseCacheStore({ filePath: path.join(root, 'browse-cache.json'), ...options });
}

const KEY = 'modrinth|mod||1.20.1|fabric||downloads|0';

test('cached rows and totals come back for the same filters', () => withCacheRoot(root => {
  const store = makeStore(root);
  const written = store.write(KEY, {
    items: [{ id: 'jei', name: 'JEI', author: 'mezz' }, { id: 'sodium', name: 'Sodium' }],
    total: 1284,
  });

  assert.equal(written.success, true);
  const read = store.read(KEY);
  assert.deepEqual(read.items.map(item => item.name), ['JEI', 'Sodium']);
  assert.equal(read.total, 1284);
  assert.equal(read.cached, true);
  assert.equal(typeof read.savedAt, 'number');

  // Keys are normalized, so a different casing still hits the same entry.
  assert.ok(store.read(KEY.toUpperCase()), 'keys are case-insensitive');
  assert.equal(store.read('curseforge|modpack|||'), null, 'unknown filters miss');
}));

test('an entry keeps only the first page of rows and the metadata each row needs', () => withCacheRoot(root => {
  const store = makeStore(root, { maxItemsPerEntry: 20 });
  const items = Array.from({ length: 60 }, (_, index) => ({
    id: `mod-${index}`,
    name: `Mod ${index}`,
    description: 'x'.repeat(120),
  }));
  store.write(KEY, { items, total: 12000 });

  const read = store.read(KEY);
  assert.equal(read.items.length, 20, 'only one small page is cached');
  assert.equal(read.items[0].name, 'Mod 0');
  assert.equal(read.total, 12000);
}));

test('entries expire so a stale list is never shown forever', () => withCacheRoot(root => {
  let clock = 1_000;
  const store = makeStore(root, { ttlMs: 5_000, now: () => clock });
  store.write(KEY, { items: [{ id: 'jei' }] });

  clock = 5_999;
  assert.ok(store.read(KEY), 'still fresh just before the TTL');

  clock = 6_001;
  assert.equal(store.read(KEY), null, 'served from cache only within the TTL');
}));

test('the oldest queries are evicted as the cache fills up', () => withCacheRoot(root => {
  let clock = 1;
  const store = makeStore(root, { maxEntries: 2, now: () => clock });
  for (const key of ['alpha', 'beta', 'gamma']) {
    store.write(key, { items: [{ id: key }] });
    clock += 10;
  }

  assert.equal(store.stats().entries, 2);
  assert.equal(store.read('alpha'), null, 'the least recently written query is dropped');
  assert.ok(store.read('beta'));
  assert.ok(store.read('gamma'));
}));

test('the byte budget keeps the cache small even with fat result rows', () => withCacheRoot(root => {
  const store = makeStore(root, { maxBytes: 1_500, maxItemsPerEntry: 40 });
  for (let index = 0; index < 8; index++) {
    store.write(`query-${index}`, {
      items: Array.from({ length: 6 }, (_, row) => ({
        id: `${index}-${row}`,
        description: 'y'.repeat(150),
      })),
    });
  }

  const stats = store.stats();
  assert.ok(stats.bytes <= 1_500, `cache stayed inside the byte budget (${stats.bytes} bytes)`);
  assert.ok(store.read('query-7'), 'the newest query is always kept');
}));

test('the cache survives a restart and can be cleared', () => withCacheRoot(root => {
  makeStore(root).write(KEY, { items: [{ id: 'jei', name: 'JEI' }], total: 3 });

  const reloaded = makeStore(root);
  assert.deepEqual(reloaded.read(KEY).items, [{ id: 'jei', name: 'JEI' }]);
  assert.equal(reloaded.read(KEY).total, 3);

  const cleared = reloaded.clear();
  assert.equal(cleared.entries, 0);
  assert.equal(reloaded.read(KEY), null);
  assert.equal(makeStore(root).stats().entries, 0, 'the clear was persisted');
}));

test('unusable payloads are refused and unserializable rows are dropped', () => withCacheRoot(root => {
  const store = makeStore(root);
  assert.equal(store.write('', { items: [{ id: 'a' }] }).success, false);
  assert.equal(store.write(KEY, { items: [] }).success, false);
  assert.equal(store.write(KEY, { items: 'nope' }).success, false);

  store.write(KEY, {
    items: [
      { id: 'jei', name: 'JEI', onClick: () => {} },
      null,
      'not a row',
      [1, 2, 3],
    ],
  });
  assert.deepEqual(store.read(KEY).items, [{ id: 'jei', name: 'JEI' }]);
}));

test('the preload bridge exposes one shared cache persisted under the data folder', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const cache = app.exposed.craftdock.browseCache;
    assert.equal(typeof cache.read, 'function');
    assert.equal(typeof cache.write, 'function');

    const written = plain(await cache.write(KEY, { items: [{ id: 'jei', name: 'JEI' }], total: 42 }));
    assert.equal(written.success, true);
    assert.equal(fs.existsSync(path.join(app.dataDir, 'browse-cache.json')), true);

    const read = plain(await cache.read(KEY));
    assert.deepEqual(read.items, [{ id: 'jei', name: 'JEI' }]);
    assert.equal(read.total, 42);

    const stats = plain(await cache.stats());
    assert.equal(stats.entries, 1);
    assert.ok(stats.bytes <= stats.maxBytes);

    plain(await cache.clear());
    assert.equal(plain(await cache.stats()).entries, 0);
    assert.equal(plain(await cache.read(KEY)), null);
  });
});

test('the shared cache stays bounded across many browsed queries', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const cache = app.exposed.craftdock.browseCache;
    const limits = plain(await cache.stats());

    for (let index = 0; index < limits.maxEntries + 25; index++) {
      await cache.write(`modrinth|modpack|query ${index}|||downloads|0`, {
        items: Array.from({ length: 30 }, (_, row) => ({
          id: `${index}-${row}`,
          name: `Pack ${index}-${row}`,
          description: 'z'.repeat(120),
        })),
        total: 5000,
      });
    }

    const stats = plain(await cache.stats());
    assert.ok(stats.entries <= limits.maxEntries, `entry count capped (${stats.entries})`);
    assert.ok(stats.bytes <= limits.maxBytes, `byte budget capped (${stats.bytes})`);
    assert.ok(plain(await cache.read(`modrinth|modpack|query ${limits.maxEntries + 24}|||downloads|0`)),
      'the most recent browse result is still cached');
  });
});

// ── Renderer wiring ────────────────────────────────────────
const projectRoot = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');

function extract(pattern, label) {
  const match = renderer.match(pattern);
  assert.ok(match, `${label} exists in the renderer`);
  return match[0];
}

const cacheSources = [
  extract(/^function tauriBridge\(\) \{[\s\S]*?\r?\n\}/m, 'tauriBridge()'),
  extract(/^function browseCacheBridge\(\) \{[\s\S]*?\r?\n\}/m, 'browseCacheBridge()'),
  extract(/^function browseCacheKey\(parts = \{\}\) \{[\s\S]*?\r?\n\}/m, 'browseCacheKey()'),
  extract(/^async function browseCacheRead\(parts\) \{[\s\S]*?\r?\n\}/m, 'browseCacheRead()'),
  extract(/^async function browseCacheWrite\(parts, items, total\) \{[\s\S]*?\r?\n\}/m, 'browseCacheWrite()'),
  extract(/^async function mbBrowseCacheParts\(offset\) \{[\s\S]*?\r?\n\}/m, 'mbBrowseCacheParts()'),
].join('\n');

function loadCacheHelpers(craftdock) {
  const context = vm.createContext({ window: craftdock ? { craftdock } : {}, console: { log() {}, error() {} } });
  vm.runInContext(`${cacheSources}
    var document = { getElementById: () => null };
    var activeInstanceId = 'inst_1';
    var InstanceStore = { get: async () => ({ mcVersion: '1.20.1' }) };
    var mbSource = 'modrinth', mbLoader = 'fabric', mbCurrentQuery = '';
    var browseParts = { source: 'modrinth', type: 'mod', query: '', version: '1.20.1',
                        loader: 'fabric', env: '', sort: 'downloads', offset: 0 };
  `, context);
  return context;
}

test('both mod browsers derive the same cache key for the same filters', async () => {
  const context = loadCacheHelpers();
  const mbParts = await vm.runInContext('mbBrowseCacheParts(0)', context);
  context.mbParts = mbParts;

  const [instanceKey, browseKey] = vm.runInContext(
    '[browseCacheKey(mbParts), browseCacheKey(browseParts)]', context);

  assert.equal(instanceKey, KEY);
  assert.equal(instanceKey, browseKey, 'one cache entry serves both windows');
});

test('the cache helpers read and write through the preload bridge', async () => {
  const calls = [];
  const context = loadCacheHelpers({
    browseCache: {
      read: key => { calls.push(['read', key]); return Promise.resolve({ items: [{ id: 'jei' }], total: 7 }); },
      write: (key, entry) => { calls.push(['write', key, entry]); return Promise.resolve({ success: true }); },
    },
  });

  const read = await vm.runInContext('browseCacheRead(browseParts)', context);
  assert.deepEqual(read.items, [{ id: 'jei' }]);
  assert.equal(read.total, 7);
  await vm.runInContext('browseCacheWrite(browseParts, [{ id: "sodium" }], 12)', context);

  assert.deepEqual(plain(calls), [
    ['read', KEY],
    ['write', KEY, { items: [{ id: 'sodium' }], total: 12 }],
  ]);

  // With no bridge at all the helpers degrade to a miss, not an exception.
  const bareContext = loadCacheHelpers(null);
  assert.equal(await vm.runInContext('browseCacheRead(browseParts)', bareContext), null);
  await vm.runInContext('browseCacheWrite(browseParts, [{ id: "x" }], 1)', bareContext);
});

test('the Tauri build maps the shared cache to the Rust commands', async () => {
  const calls = [];
  const context = loadCacheHelpers(null);
  context.window.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        calls.push([command, args]);
        if (command === 'browse_cache_read') {
          return Promise.resolve({ items: [{ id: 'jei' }], total: 3, savedAt: 1, cached: true });
        }
        if (command === 'browse_cache_write') return Promise.resolve({ success: true, entries: 1, bytes: 40 });
        if (command === 'browse_cache_stats') {
          return Promise.resolve({ entries: 1, items: 1, bytes: 40, maxBytes: 262144 });
        }
        return Promise.resolve({ success: true, entries: 0, bytes: 2 });
      },
    },
  };

  const read = await vm.runInContext('browseCacheRead(browseParts)', context);
  assert.deepEqual(plain(read.items), [{ id: 'jei' }]);
  assert.equal(read.total, 3);

  await vm.runInContext('browseCacheWrite(browseParts, [{ id: "sodium" }], 12)', context);
  const stats = await vm.runInContext('browseCacheBridge().stats()', context);
  assert.equal(stats.entries, 1);
  await vm.runInContext('browseCacheBridge().clear()', context);

  assert.deepEqual(plain(calls), [
    ['browse_cache_read', { key: KEY }],
    ['browse_cache_write', { key: KEY, payload: { items: [{ id: 'sodium' }], total: 12 } }],
    ['browse_cache_stats', null],
    ['browse_cache_clear', null],
  ]);

  // Electron's preload still wins when both bridges exist.
  const both = loadCacheHelpers({
    browseCache: { read: key => Promise.resolve({ items: [{ id: key }], total: 1 }), write: () => {} },
  });
  both.window.__TAURI__ = { core: { invoke: () => { throw new Error('Tauri must not be used'); } } };
  assert.deepEqual(plain((await vm.runInContext('browseCacheRead(browseParts)', both)).items), [{ id: KEY }]);
});

test('the Rust cache uses the same limits and is registered as a command', () => {
  const rust = fs.readFileSync(path.join(projectRoot, 'src-tauri', 'src', 'browse_cache.rs'), 'utf8');
  const main = fs.readFileSync(path.join(projectRoot, 'src-tauri', 'src', 'main.rs'), 'utf8');
  const { DEFAULTS } = require('../browse-cache');

  const expected = [
    ['MAX_ENTRIES', 'usize', String(DEFAULTS.maxEntries)],
    ['MAX_ITEMS_PER_ENTRY', 'usize', String(DEFAULTS.maxItemsPerEntry)],
    ['MAX_BYTES', 'usize', `${DEFAULTS.maxBytes / 1024} * 1024`],
    ['MAX_ENTRY_BYTES', 'usize', `${DEFAULTS.maxEntryBytes / 1024} * 1024`],
    ['TTL_MS', 'u64', '24 * 60 * 60 * 1000'],
  ];
  for (const [name, type, literal] of expected) {
    const escaped = literal.replace(/\*/g, '\\*');
    assert.match(rust, new RegExp(`pub const ${name}: ${type} = ${escaped};`),
      `${name} matches the Electron cache`);
  }
  assert.equal(DEFAULTS.ttlMs, 24 * 60 * 60 * 1000);
  assert.match(rust, /fn write_at\(/);
  assert.match(rust, /"browse-cache\.json"/);

  for (const command of ['browse_cache_read', 'browse_cache_write', 'browse_cache_stats', 'browse_cache_clear']) {
    assert.match(main, new RegExp(`fn ${command}\\(`), `${command} is implemented`);
    assert.match(main, new RegExp(`tauri::generate_handler!\\[[\\s\\S]*\\n            ${command},`),
      `${command} is registered with Tauri`);
  }
});

test('every browse surface paints from the cache before refreshing it', () => {
  const fetchBrowsePacks = extract(/^async function fetchBrowsePacks\(query, version, sort, append = false\) \{[\s\S]*?\r?\n\}/m, 'fetchBrowsePacks()');
  const mbSearchMods = extract(/^async function mbSearchMods\(query, append = false\) \{[\s\S]*?\r?\n\}/m, 'mbSearchMods()');
  const resSearchItems = extract(/^async function resSearchItems\(query\) \{[\s\S]*?\r?\n\}/m, 'resSearchItems()');

  for (const [label, source] of [
    ['Browse tab', fetchBrowsePacks],
    ['instance mod browser', mbSearchMods],
    ['resource/shader browser', resSearchItems],
  ]) {
    assert.match(source, /browseCacheRead\(cacheParts\)/, `${label} reads the cache first`);
    assert.match(source, /browseCacheWrite\(cacheParts/, `${label} refreshes the cache`);
  }

  // Only result rows are cached — never installs.
  assert.match(fetchBrowsePacks, /browseCacheWrite\(cacheParts, packs, browseTotalHits\)/);
  assert.match(mbSearchMods, /browseCacheWrite\(cacheParts, result\.mods, result\.total\)/);

  // Cached rows survive a failed refresh instead of being replaced by an error box.
  assert.match(fetchBrowsePacks, /!append && !showingCache/);
  assert.match(mbSearchMods, /!append && !showingCache/);
});

// ── Settings cache indicator ───────────────────────────────
function loadSettingsCacheHelpers(initialStats) {
  const elements = {
    settingsBrowseCacheStats: { textContent: '', style: {} },
    settingsBrowseCacheBar: { style: {} },
  };
  const calls = [];
  let stats = initialStats;
  const context = vm.createContext({
    document: { getElementById: id => elements[id] || null },
    showNotif: (title, message) => calls.push(['notify', title, message]),
    window: {},
  });
  vm.runInContext(`
    function browseCacheBridge() { return window.bridge; }
    ${extract(/^function formatBrowseCacheBytes\(bytes\) \{[\s\S]*?\r?\n\}/m, 'formatBrowseCacheBytes()')}
    ${extract(/^async function settingsRefreshBrowseCache\(\) \{[\s\S]*?\r?\n\}/m, 'settingsRefreshBrowseCache()')}
    ${extract(/^async function settingsClearBrowseCache\(\) \{[\s\S]*?\r?\n\}/m, 'settingsClearBrowseCache()')}
  `, context);
  context.window.bridge = {
    stats: async () => { calls.push(['stats']); return stats; },
    clear: async () => {
      calls.push(['clear']);
      stats = { entries: 0, items: 0, bytes: 2, maxBytes: 262144 };
      return { success: true, entries: 0 };
    },
  };
  return { context, elements, calls };
}

test('settings shows how much the shared browse cache stores and can clear it', async () => {
  const panel = loadSettingsCacheHelpers({ entries: 3, items: 20, bytes: 1_500, maxBytes: 262_144 });

  await vm.runInContext('settingsRefreshBrowseCache()', panel.context);
  assert.equal(panel.elements.settingsBrowseCacheStats.textContent,
    '3 saved searches · 1.5 KB of 256 KB');
  assert.equal(panel.elements.settingsBrowseCacheBar.style.width, '1%');

  await vm.runInContext('settingsClearBrowseCache()', panel.context);
  assert.deepEqual(plain(panel.calls).filter(call => call[0] !== 'stats'), [
    ['clear'],
    ['notify', 'Browse Cache Cleared', 'Browsed results will download again next time'],
  ]);
  assert.equal(panel.elements.settingsBrowseCacheStats.textContent, 'Empty — the first browse fills it');
  assert.equal(panel.elements.settingsBrowseCacheBar.style.width, '0%');
});

test('settings reports an unavailable or failing cache bridge without throwing', async () => {
  const empty = loadSettingsCacheHelpers({ entries: 0, items: 0, bytes: 2, maxBytes: 262_144 });
  await vm.runInContext('settingsRefreshBrowseCache()', empty.context);
  assert.equal(empty.elements.settingsBrowseCacheStats.textContent, 'Empty — the first browse fills it');

  const brokenLabel = { textContent: '' };
  const broken = vm.createContext({
    document: { getElementById: id => (id === 'settingsBrowseCacheStats' ? brokenLabel : null) },
    window: {},
  });
  vm.runInContext(`
    function browseCacheBridge() { return { stats: async () => { throw new Error('disk'); } }; }
    ${extract(/^async function settingsRefreshBrowseCache\(\) \{[\s\S]*?\r?\n\}/m, 'settingsRefreshBrowseCache()')}
  `, broken);
  await vm.runInContext('settingsRefreshBrowseCache()', broken);
  assert.equal(brokenLabel.textContent, 'Could not read cache size');
});

test('the settings panel wires the cache indicator and its clear control', () => {
  assert.match(renderer, /id="settingsBrowseCacheStats"/);
  assert.match(renderer, /id="settingsBrowseCacheBar"/);
  assert.match(renderer, /onclick="settingsClearBrowseCache\(\)"/);
  assert.match(renderer, /settingsRefreshBrowseCache\(\);/);
});
