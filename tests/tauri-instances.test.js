// Focused parity proof for the Tauri instance slice: the renderer has to keep
// Electron's bridge when it is present, and route only the instance/folder
// calls to the Rust commands when running under Tauri.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.join(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

// Objects created inside the vm context have a different prototype, so compare
// plain JSON copies instead of the live cross-realm values.
const plain = value => JSON.parse(JSON.stringify(value));

const renderer = read('src', 'index.html');
const rustEntry = read('src-tauri', 'src', 'main.rs');
const rustInstanceStore = read('src-tauri', 'src', 'instance_store.rs');
const electronMain = read('main.js');

function slice(start, end) {
  const from = renderer.indexOf(start);
  const to = renderer.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `${start} exists in the renderer`);
  assert.notEqual(to, -1, `${end} follows ${start} in the renderer`);
  return renderer.slice(from, to);
}

const bridgeSource = slice('function tauriBridge() {', 'const Store = {');
const instanceSource = slice('const InstanceStore = {', 'const SkinStore = {');
const openFolderMatch = renderer.match(/^async function openActiveInstanceFolder\(sub\) \{[\s\S]*?\r?\n\}/m);
const settingsFolderMatch = renderer.match(/^function settingsOpenDataFolder\(\) \{[\s\S]*?\r?\n\}/m);
assert.ok(openFolderMatch, 'openActiveInstanceFolder() has a closing brace');
assert.ok(settingsFolderMatch, 'settingsOpenDataFolder() has a closing brace');

// Runs the real renderer sources in an isolated context with either bridge.
function loadBridge({ tauri = true, invoke = () => undefined, electron = null } = {}) {
  const calls = [];
  const stored = new Map();
  const notifications = [];
  const rendered = [];
  const window = {};

  if (tauri) {
    window.__TAURI__ = {
      core: {
        invoke: (command, args) => {
          calls.push([command, args]);
          return Promise.resolve(invoke(command, args));
        },
      },
    };
  }
  if (electron) window.craftdockInstance = electron;

  const sandbox = {
    window,
    isCraftDock: Boolean(electron),
    activeInstanceId: 'inst_1',
    console: { error() {}, warn() {}, log() {} },
    Store: {
      async get(key) { return stored.has(key) ? JSON.parse(JSON.stringify(stored.get(key))) : null; },
      async set(key, value) { stored.set(key, JSON.parse(JSON.stringify(value))); },
      async delete(key) { stored.delete(key); },
    },
    showNotif: (...args) => notifications.push(args),
    renderInstanceList: async () => { rendered.push(true); },
  };

  vm.createContext(sandbox);
  vm.runInContext(
    [
      bridgeSource,
      instanceSource,
      openFolderMatch[0],
      settingsFolderMatch[0],
      'globalThis.__api = { InstanceStore, tauriBridge, dataRootBridge, instanceBridge, openActiveInstanceFolder, settingsOpenDataFolder };',
    ].join('\n'),
    sandbox,
  );

  return { api: sandbox.__api, calls, stored, notifications, rendered };
}

test('Rust registers every instance and folder command the renderer uses', () => {
  const handler = rustEntry.match(/generate_handler!\[([\s\S]*?)\]/)?.[1];
  assert.ok(handler, 'generate_handler! lists the commands');

  for (const command of [
    'instance_create',
    'instance_list',
    'instance_get',
    'instance_update',
    'instance_delete',
    'instance_list_worlds',
    'instance_list_mods',
    'instance_open_folder',
    'open_folder',
    'get_data_root',
  ]) {
    assert.match(rustEntry, new RegExp(`fn ${command}\\(`), `${command} is a Rust command`);
    assert.ok(handler.includes(command), `${command} is registered with Tauri`);
  }
});

test('Rust creates the same instance subfolders as Electron', () => {
  const electronList = electronMain.match(/const INST_SUBDIRS = \[([^\]]*)\]/)?.[1];
  const rustList = rustInstanceStore.match(/INSTANCE_SUBDIRS: \[&str; \d+\] = \[([\s\S]*?)\];/)?.[1];
  assert.ok(electronList, 'Electron declares its instance subfolders');
  assert.ok(rustList, 'Rust declares its instance subfolders');

  const names = text => [...text.matchAll(/'([^']+)'|"([^"]+)"/g)].map(match => match[1] || match[2]);
  assert.deepEqual(names(rustList), names(electronList));
});

test('Tauri creates a new instance through the Rust command', async () => {
  const { api, calls, stored, rendered } = loadBridge({ invoke: () => null });

  await api.InstanceStore.save({ id: 'inst_1', name: 'My Pack', mcVersion: '1.21.4' });

  assert.deepEqual(calls.map(([command]) => command), ['instance_get', 'instance_create']);
  assert.deepEqual(plain(calls[1][1]), { meta: { id: 'inst_1', name: 'My Pack', mcVersion: '1.21.4' } });
  // UI-only fields keep using the Rust key/value store.
  assert.deepEqual(stored.get('craftdock:inst-meta'), {
    inst_1: { categoryId: null, color: null, iconUrl: null, notes: null },
  });
  assert.equal(rendered.length, 1, 'the list re-renders after saving');
});

test('Tauri updates an instance that already has a folder', async () => {
  const { api, calls } = loadBridge({
    invoke: command => (command === 'instance_get' ? { id: 'inst_1', name: 'Pack' } : { success: true }),
  });

  await api.InstanceStore.save({ id: 'inst_1', name: 'Pack', notes: 'hello' });

  assert.deepEqual(calls.map(([command]) => command), ['instance_get', 'instance_update']);
  assert.deepEqual(plain(calls[1][1]), { meta: { id: 'inst_1', name: 'Pack', notes: 'hello' } });
});

test('Tauri lists instances from disk and merges the stored UI fields', async () => {
  const { api, stored } = loadBridge({
    invoke: command => (command === 'instance_list' ? [{ id: 'inst_1', name: 'Pack', mcVersion: '1.20.1' }] : null),
  });
  stored.set('craftdock:inst-meta', { inst_1: { color: '#123456', notes: 'from store' } });

  assert.deepEqual(plain(await api.InstanceStore.getAll()), [
    { id: 'inst_1', name: 'Pack', mcVersion: '1.20.1', color: '#123456', notes: 'from store' },
  ]);
});

test('Tauri opens an instance folder through the Rust command', async () => {
  const { api, calls } = loadBridge({});

  await api.openActiveInstanceFolder('saves');
  await api.openActiveInstanceFolder();

  assert.deepEqual(plain(calls), [
    ['instance_open_folder', { id: 'inst_1', sub: 'saves' }],
    ['instance_open_folder', { id: 'inst_1', sub: null }],
  ]);
});

test('Tauri surfaces a refused folder open instead of failing silently', async () => {
  const { api, notifications } = loadBridge({
    invoke: () => ({ success: false, error: 'Only paths inside CraftDock\'s data folder' }),
  });

  await api.openActiveInstanceFolder('mods');

  assert.deepEqual(notifications, [['Open Folder', 'Only paths inside CraftDock\'s data folder']]);
});

test('Tauri opens the data folder through the same bridge', async () => {
  const { api, calls } = loadBridge({
    invoke: command => (command === 'get_data_root' ? 'C:\\Users\\me\\AppData\\com.craftdock.launcher.tauri\\data' : { success: true }),
  });

  api.settingsOpenDataFolder();
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(plain(calls), [
    ['get_data_root', null],
    ['open_folder', { path: 'C:\\Users\\me\\AppData\\com.craftdock.launcher.tauri\\data' }],
  ]);
});

test('Tauri lists worlds and mods through the Rust commands', async () => {
  const worlds = [{ name: 'Survival', path: 'C:\\data\\instances\\Pack\\saves\\Survival', lastPlayed: 1_700_000_000_000 }];
  const mods = [{ name: 'sodium.jar', enabled: true, path: 'C:\\data\\instances\\Pack\\mods\\sodium.jar' }];
  const { api, calls } = loadBridge({
    invoke: command => (command === 'instance_list_worlds' ? worlds : mods),
  });

  const instance = api.tauriBridge().instance;
  assert.deepEqual(plain(await instance.listWorlds('inst_1')), worlds);
  assert.deepEqual(plain(await instance.listMods('inst_1')), mods);
  assert.deepEqual(plain(calls), [
    ['instance_list_worlds', { id: 'inst_1' }],
    ['instance_list_mods', { id: 'inst_1' }],
  ]);
});

test('the worlds panel and mod list read through the bridge, not the Electron global', () => {
  const worldsFn = renderer.match(/^async function loadActiveInstanceWorlds\(\) \{[\s\S]*?\r?\n\}/m)?.[0];
  assert.ok(worldsFn, 'loadActiveInstanceWorlds() has a closing brace');
  assert.match(worldsFn, /const instanceApi = instanceBridge\(\);/);
  assert.match(worldsFn, /instanceApi\.listWorlds\(activeInstanceId\)/);
  assert.doesNotMatch(worldsFn, /window\.craftdockInstance\.listWorlds/);

  // Without a bridge at all the panel still says the desktop app is required.
  assert.match(worldsFn, /World list available in the desktop app/);

  const modsFn = renderer.match(/^async function renderInstalledMods\(inst\) \{[\s\S]*?\r?\n\}/m)?.[0];
  assert.ok(modsFn, 'renderInstalledMods() has a closing brace');
  assert.match(modsFn, /const instanceApi = instanceBridge\(\);/);
  assert.match(modsFn, /if \(instanceApi\?\.listMods\)/);
  assert.match(modsFn, /instanceApi\.listMods\(inst\.id\)/);

  const overviewFn = renderer.match(/^async function loadInstanceOverview\(inst\) \{[\s\S]*?\r?\n\}/m)?.[0];
  assert.ok(overviewFn, 'loadInstanceOverview() has a closing brace');
  assert.match(overviewFn, /modsApi\.listMods\(inst\.id\)/);
});

test('Electron keeps its own world and mod listing', async () => {
  const electronCalls = [];
  const electron = {
    listWorlds: id => { electronCalls.push(['listWorlds', id]); return Promise.resolve([{ name: 'Survival', path: 'p', lastPlayed: null }]); },
    listMods: id => { electronCalls.push(['listMods', id]); return Promise.resolve([{ name: 'sodium.jar', enabled: false, path: 'p' }]); },
  };
  const { api, calls } = loadBridge({ tauri: false, electron });

  const bridge = api.instanceBridge();
  assert.equal(bridge, electron, 'the Electron preload wins when present');
  await bridge.listWorlds('inst_9');
  await bridge.listMods('inst_9');

  assert.deepEqual(calls, [], 'no Rust command runs when Electron preload is present');
  assert.deepEqual(electronCalls, [['listWorlds', 'inst_9'], ['listMods', 'inst_9']]);
});

test('Electron keeps its own instance and folder bridge', async () => {
  const electronCalls = [];
  const electron = {
    get: () => { electronCalls.push(['get']); return Promise.resolve(null); },
    create: meta => { electronCalls.push(['create', meta]); return Promise.resolve({ success: true, id: meta.id }); },
    update: meta => { electronCalls.push(['update', meta]); return Promise.resolve({ success: true }); },
    list: () => Promise.resolve([{ id: 'electron-inst' }]),
    openFolder: (id, sub) => { electronCalls.push(['openFolder', id, sub]); return Promise.resolve({ success: true }); },
  };

  const { api, calls } = loadBridge({ tauri: false, electron });

  await api.InstanceStore.save({ id: 'inst_1', name: 'Pack' });
  await api.openActiveInstanceFolder('mods');
  assert.deepEqual(plain(await api.InstanceStore.getAll()), [{ id: 'electron-inst' }]);

  assert.deepEqual(calls, [], 'no Rust command runs when Electron preload is present');
  assert.deepEqual(electronCalls.map(([name]) => name), ['get', 'create', 'openFolder']);
  assert.deepEqual(electronCalls[2], ['openFolder', 'inst_1', 'mods']);
});

test('the browser fallback still uses the key/value store', async () => {
  const { api, stored, calls } = loadBridge({ tauri: false });

  await api.InstanceStore.save({ id: 'inst_1', name: 'Browser Pack' });

  assert.deepEqual(calls, []);
  assert.deepEqual(stored.get('craftdock:instances'), [{ id: 'inst_1', name: 'Browser Pack' }]);
});
