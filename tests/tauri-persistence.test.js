const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');
const rustEntry = fs.readFileSync(path.join(projectRoot, 'src-tauri', 'src', 'main.rs'), 'utf8');
const preload = fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf8');

function extract(pattern, label) {
  const match = renderer.match(pattern);
  assert.ok(match, `${label} exists in the renderer`);
  return match[0];
}

const bridgeSource = extract(/^function tauriBridge\(\) \{[\s\S]*?\r?\n\}/m, 'tauriBridge()');
const resourceApiSource = extract(/^function resourceApi\(\) \{[\s\S]*?\r?\n\}/m, 'resourceApi()');
const storeSource = extract(/^const Store = \{[\s\S]*?\r?\n\};/m, 'Store');
const modsSearchSource = extract(
  /^async function searchCurseForgeMods\(query, loader, offset = 0\) \{[\s\S]*?\r?\n\}/m,
  'searchCurseForgeMods()',
);

// IPC arguments are recorded across a vm realm, so compare plain copies.
function plainCalls(calls) {
  return calls.map(([command, args]) => [command, args === undefined ? null : JSON.parse(JSON.stringify(args))]);
}

function loadRenderer({ invoke, craftdock } = {}) {
  const stored = new Map();
  const window = {
    ...(invoke ? { __TAURI__: { core: { invoke } } } : {}),
    ...(craftdock ? { craftdock } : {}),
  };
  const context = vm.createContext({
    window,
    console: { error() {} },
    localStorage: {
      getItem: key => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => stored.set(key, value),
      removeItem: key => stored.delete(key),
    },
  });
  vm.runInContext(
    `${bridgeSource}\n${resourceApiSource}\n${storeSource}\nconst MB_PAGE_SIZE = 20;\n${modsSearchSource}`,
    context,
  );
  return context;
}

test('settings and instances persist through the Tauri Rust store', async () => {
  const calls = [];
  const context = loadRenderer({
    invoke: (command, args) => {
      calls.push([command, args]);
      return Promise.resolve(command === 'store_get' ? { defaultMaxRam: 4096 } : undefined);
    },
  });
  const Store = vm.runInContext('Store', context);

  assert.deepEqual(await Store.get('craftdock:appSettings'), { defaultMaxRam: 4096 });
  await Store.set('craftdock:instances', [{ id: 'abc', name: 'Cobblemon' }]);
  await Store.delete('craftdock:instances');

  assert.deepEqual(plainCalls(calls), [
    ['store_get', { key: 'craftdock:appSettings' }],
    ['store_set', { key: 'craftdock:instances', value: [{ id: 'abc', name: 'Cobblemon' }] }],
    ['store_delete', { key: 'craftdock:instances' }],
  ]);
});

test('Electron keeps using its preload store when both bridges exist', async () => {
  const tauriCalls = [];
  const electronCalls = [];
  const context = loadRenderer({
    invoke: (command, args) => { tauriCalls.push([command, args]); return Promise.resolve(null); },
    craftdock: {
      store: {
        get: key => { electronCalls.push(['get', key]); return Promise.resolve({ fromElectron: true }); },
        set: (key, value) => { electronCalls.push(['set', key, value]); return Promise.resolve(); },
        delete: key => { electronCalls.push(['delete', key]); return Promise.resolve(); },
      },
    },
  });
  const Store = vm.runInContext('Store', context);

  assert.deepEqual(await Store.get('craftdock:instances'), { fromElectron: true });
  await Store.set('craftdock:instances', []);
  await Store.delete('craftdock:instances');

  assert.deepEqual(electronCalls, [
    ['get', 'craftdock:instances'],
    ['set', 'craftdock:instances', []],
    ['delete', 'craftdock:instances'],
  ]);
  assert.deepEqual(tauriCalls, []);
});

test('CurseForge calls reach the Rust command with explicit arguments', async () => {
  const calls = [];
  const context = loadRenderer({
    invoke: (command, args) => {
      calls.push([command, args]);
      if (command === 'cf_get_mc_versions') return Promise.resolve({ success: true, data: [{ versionString: '1.21.1' }] });
      return Promise.resolve({ success: true, data: [], pagination: { totalCount: 0 } });
    },
  });

  const api = vm.runInContext('resourceApi()', context);
  assert.equal(await api.getMinecraftVersions().then(result => result.success), true);
  await api.curseforgeSearch('sodium', '1.21.1', '4', 6, 2, 20, 20);
  await api.curseforgeModFiles('238222', '1.21.1', 'fabric');
  await api.curseforgeMod('238222');

  assert.deepEqual(plainCalls(calls), [
    ['cf_get_mc_versions', null],
    ['curseforge_search', {
      query: 'sodium',
      gameVersion: '1.21.1',
      modLoaderType: '4',
      classId: 6,
      sortField: 2,
      index: 20,
      pageSize: 20,
    }],
    ['cf_mod_files', {
      modId: 238222,
      gameVersion: '1.21.1',
      loader: 'fabric',
    }],
    ['cf_mod_details', { modId: 238222 }],
  ]);
});

test('the mods browser asks CurseForge for Minecraft mods, not plugins, and pages by offset', async () => {
  const calls = [];
  const context = loadRenderer({
    invoke: (command, args) => {
      calls.push([command, args]);
      return Promise.resolve({ success: true, data: [], pagination: { totalCount: 144 } });
    },
  });

  const search = vm.runInContext('searchCurseForgeMods', context);
  const result = await search('sodium', 'fabric', 40);

  assert.equal(result.total, 144);
  assert.deepEqual(plainCalls(calls), [['curseforge_search', {
    query: 'sodium',
    gameVersion: '',
    modLoaderType: '4',
    classId: 6,
    sortField: 1,
    index: 40,
    pageSize: 20,
  }]]);
});

test('Electron forwards the same CurseForge pagination and file requests', () => {
  assert.match(preload, /curseforgeSearch: \(query, version, loader, classId, sortField, index, pageSize\)/);
  assert.match(preload, /invoke\('curseforge-search', query, version, loader, classId, sortField, index, pageSize\)/);
  assert.match(preload, /curseforgeModFiles: \(modId, version, loader\)/);
  assert.match(preload, /invoke\('cf-mod-files', modId, version, loader\)/);
  assert.match(preload, /curseforgeMod: \(modId\)/);
  assert.match(preload, /invoke\('cf-mod-details', modId\)/);
});

test('Rust pins Minecraft, injects the API key server-side, and registers the new commands', () => {
  assert.match(rustEntry, /const CF_GAME_ID: u32 = 432;/);
  assert.match(rustEntry, /\("gameId", CF_GAME_ID\.to_string\(\)\)/);
  assert.match(rustEntry, /\.header\("x-api-key", api_key\)/);
  assert.match(rustEntry, /std::env::var\("CF_API_KEY"\)/);
  assert.doesNotMatch(rustEntry, /fn curseforge_search\([^)]*api_key/);

  const handler = rustEntry.match(/generate_handler!\[([\s\S]*?)\]/);
  assert.ok(handler, 'commands are registered');
  for (const command of ['store_get', 'store_set', 'store_delete', 'curseforge_search', 'cf_get_mc_versions', 'cf_mod_files', 'cf_mod_details']) {
    assert.match(handler[1], new RegExp(`\\b${command}\\b`));
  }
});
