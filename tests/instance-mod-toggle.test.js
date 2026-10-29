const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const {
  createInstanceModAccess,
  isValidModFilename,
  toggleInstanceModFallback,
} = require('../instance-mod-toggle');

const projectRoot = path.resolve(__dirname, '..');
const packageConfig = require('../package.json');
const binaryName = process.platform === 'win32' ? 'craftdock-instance-mod-toggle.exe' : 'craftdock-instance-mod-toggle';
const binaryPath = path.join(projectRoot, 'rust', 'target', 'debug', binaryName);

async function withTempRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-instance-mod-toggle-'));
  try { await callback(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function access(root, isPackaged = false, runNative) {
  return createInstanceModAccess({
    isPackaged,
    appDir: root,
    resourcesPath: path.join(root, 'resources'),
    platform: process.platform,
    runNative,
  });
}

function buildRustBinary() {
  const result = spawnSync('cargo', [
    'build', '--manifest-path', 'rust/Cargo.toml', '--locked', '--bin', 'craftdock-instance-mod-toggle',
  ], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, `Rust instance mod toggle build failed:\n${result.stderr}`);
  assert.ok(fs.existsSync(binaryPath), `Rust executable not found: ${binaryPath}`);
}

function loadProductionIpc(tempRoot, handlers, modToggleModule = require('../instance-mod-toggle')) {
  const exposed = {};
  const app = {
    isPackaged: false, setAppUserModelId() {}, setName() {}, on() {},
    whenReady: () => ({ then() {} }),
  };
  const electronMain = {
    app, BrowserWindow: class {},
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    dialog: {}, shell: {}, Tray: class {}, Menu: {}, nativeImage: {},
  };
  const mockMainRequire = name => {
    if (name === 'electron') return electronMain;
    if (name === './servers-dat') return require('../servers-dat');
    if (name === './server-jar-list') return require('../server-jar-list');
    if (name === './screenshot-list') return require('../screenshot-list');
    if (name === './config-file-list') return require('../config-file-list');
    if (name === './server-properties') return require('../server-properties');
    if (name === './instance-mod-toggle') return modToggleModule;
    if (name === './modpack-metadata') return { createModpackMetadataReader: () => async () => ({}) };
    if (name === './package.json') return packageConfig;
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8'), {
    Buffer, __dirname: tempRoot, console: { log() {}, warn() {}, error() {} }, fetch,
    module: { exports: {} }, process: { ...process, resourcesPath: path.join(tempRoot, 'resources') },
    require: mockMainRequire, setInterval: () => 0, clearInterval() {},
  }, { filename: 'main.js' });

  const invocations = [];
  const electronPreload = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      invoke: (channel, ...args) => {
        invocations.push([channel, ...args]);
        const handler = handlers.get(channel);
        assert.ok(handler, `No main handler registered for ${channel}`);
        return Promise.resolve(handler({ sender: 'preload-test' }, ...args));
      },
      send() {}, on() {},
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf8'), {
    require: name => name === 'electron' ? electronPreload : require(name),
  }, { filename: 'preload.js' });
  return { exposed, invocations };
}

function setupInstance(root) {
  const modsPath = path.join(root, 'craftdock-data', 'instances', 'toggle-fixture', 'mods');
  fs.mkdirSync(modsPath, { recursive: true });
  return modsPath;
}

function assertListed(handler, filename, enabled) {
  const mods = handler({ sender: 'test' }, 'toggle-fixture');
  assert.equal(mods.find(mod => mod.name === filename)?.enabled, enabled);
}

test('fallback preserves bytes and handles already-desired, missing, and unsafe filenames', async () => {
  await withTempRoot(async root => {
    const mods = path.join(root, 'mods');
    fs.mkdirSync(mods);
    fs.writeFileSync(path.join(mods, 'keep.jar'), Buffer.from([0, 1, 2, 255]));
    assert.deepEqual(toggleInstanceModFallback(mods, 'keep.jar', false), { success: true });
    assert.deepEqual(fs.readFileSync(path.join(mods, 'keep.jar.disabled')), Buffer.from([0, 1, 2, 255]));
    assert.deepEqual(toggleInstanceModFallback(mods, 'keep.jar.disabled', true), { success: true });
    assert.deepEqual(fs.readFileSync(path.join(mods, 'keep.jar')), Buffer.from([0, 1, 2, 255]));
    assert.deepEqual(toggleInstanceModFallback(mods, 'already.jar', true), { success: true });
    assert.deepEqual(toggleInstanceModFallback(mods, 'already.jar.disabled', false), { success: true });

    const missing = toggleInstanceModFallback(mods, 'missing.jar', false);
    assert.equal(missing.success, false);
    assert.equal(typeof missing.error, 'string');
    for (const filename of ['../outside.jar', 'subdir/mod.jar', '..\\outside.jar', 'no-extension', '.jar', '...jar']) {
      assert.equal(isValidModFilename(filename), false, `expected unsafe or unsupported name to fail: ${filename}`);
      assert.equal(toggleInstanceModFallback(mods, filename, false).success, false);
    }
    assert.equal(isValidModFilename('space and 🌍.jar'), true);
    assert.deepEqual(fs.readdirSync(mods).sort(), ['keep.jar']);
  });
});

test('Rust CLI and JavaScript fallback produce the same rename and error results', async () => {
  buildRustBinary();
  await withTempRoot(async root => {
    const nativeMods = path.join(root, 'native-mods');
    const fallbackMods = path.join(root, 'fallback-mods');
    fs.mkdirSync(nativeMods);
    fs.mkdirSync(fallbackMods);
    const bytes = Buffer.from('exact mod bytes\0🌍');
    fs.writeFileSync(path.join(nativeMods, 'parity.jar'), bytes);
    fs.writeFileSync(path.join(fallbackMods, 'parity.jar'), bytes);

    assert.deepEqual(await access(projectRoot).toggle(nativeMods, 'parity.jar', false), { success: true });
    assert.deepEqual(toggleInstanceModFallback(fallbackMods, 'parity.jar', false), { success: true });
    assert.deepEqual(fs.readFileSync(path.join(nativeMods, 'parity.jar.disabled')), bytes);
    assert.deepEqual(fs.readFileSync(path.join(fallbackMods, 'parity.jar.disabled')), bytes);
    assert.deepEqual(await access(projectRoot).toggle(nativeMods, 'parity.jar.disabled', true), { success: true });
    assert.deepEqual(toggleInstanceModFallback(fallbackMods, 'parity.jar.disabled', true), { success: true });
    assert.deepEqual(fs.readFileSync(path.join(nativeMods, 'parity.jar')), bytes);
    assert.deepEqual(fs.readFileSync(path.join(fallbackMods, 'parity.jar')), bytes);

    const nativeMissing = await access(projectRoot).toggle(nativeMods, 'missing.jar', false);
    const fallbackMissing = toggleInstanceModFallback(fallbackMods, 'missing.jar', false);
    assert.equal(nativeMissing.success, false);
    assert.equal(fallbackMissing.success, false);
    assert.equal(await access(projectRoot).toggle(nativeMods, 'already.jar', true).then(result => result.success), true);
    assert.equal(await access(projectRoot).toggle(nativeMods, '../outside.jar', false).then(result => result.success), false);
  });
});

test('production preload preserves IPC and runs both Rust and fallback paths with list-state parity', async () => {
  buildRustBinary();
  for (const useRust of [false, true]) {
    await withTempRoot(async root => {
      const modsPath = setupInstance(root);
      const bytes = Buffer.from('production jar bytes\0');
      fs.writeFileSync(path.join(modsPath, 'from-disk.jar'), bytes);
      if (useRust) {
        const devBinary = path.join(root, 'rust', 'target', 'debug', binaryName);
        fs.mkdirSync(path.dirname(devBinary), { recursive: true });
        fs.copyFileSync(binaryPath, devBinary);
      }

      const nativeCalls = [];
      const baseModToggle = require('../instance-mod-toggle');
      const modToggleModule = useRust
        ? {
          ...baseModToggle,
          createInstanceModAccess: options => baseModToggle.createInstanceModAccess({
            ...options,
            runNative: (binary, args) => {
              const result = spawnSync(binary, args, { encoding: 'utf8' });
              nativeCalls.push({ binary, args, status: result.status });
              if (result.error) throw Object.assign(result.error, { failedToStart: true });
              if (result.status !== 0) throw new Error(result.stderr || `Rust process exited with ${result.status}`);
              return result.stdout;
            },
          }),
        }
        : baseModToggle;
      const handlers = new Map();
      const { exposed, invocations } = loadProductionIpc(root, handlers, modToggleModule);
      const result = await exposed.craftdockInstance.toggleMod('toggle-fixture', 'from-disk.jar', false);
      assert.deepEqual(JSON.parse(JSON.stringify(result)), { success: true });
      assert.deepEqual(fs.readFileSync(path.join(modsPath, 'from-disk.jar.disabled')), bytes);
      assertListed(handlers.get('instance-list-mods'), 'from-disk.jar.disabled', false);

      const enabled = await exposed.craftdockInstance.toggleMod('toggle-fixture', 'from-disk.jar.disabled', true);
      assert.deepEqual(JSON.parse(JSON.stringify(enabled)), { success: true });
      assert.deepEqual(fs.readFileSync(path.join(modsPath, 'from-disk.jar')), bytes);
      assertListed(handlers.get('instance-list-mods'), 'from-disk.jar', true);

      const alreadyDesired = await exposed.craftdockInstance.toggleMod('toggle-fixture', 'from-disk.jar', true);
      const missingDesired = await exposed.craftdockInstance.toggleMod('toggle-fixture', 'missing.jar', true);
      const missingSource = await exposed.craftdockInstance.toggleMod('toggle-fixture', 'missing.jar', false);
      const traversal = await exposed.craftdockInstance.toggleMod('toggle-fixture', '../outside.jar', false);
      assert.deepEqual(JSON.parse(JSON.stringify(alreadyDesired)), { success: true });
      assert.deepEqual(JSON.parse(JSON.stringify(missingDesired)), { success: true });
      assert.equal(missingSource.success, false);
      assert.equal(typeof missingSource.error, 'string');
      assert.equal(traversal.success, false);
      assert.deepEqual(fs.readFileSync(path.join(modsPath, 'from-disk.jar')), bytes);
      assert.deepEqual(fs.readdirSync(modsPath), ['from-disk.jar']);
      if (useRust) {
        assert.equal(nativeCalls.length, 5, 'Rust should execute each valid operation, including its no-op state checks');
        assert.deepEqual(nativeCalls.map(({ binary }) => binary), Array(5).fill(path.join(root, 'rust', 'target', 'debug', binaryName)));
        assert.deepEqual(nativeCalls.map(({ status }) => status), [0, 0, 0, 0, 1]);
      }
      assert.deepEqual(JSON.parse(JSON.stringify(invocations)), [
        ['instance-toggle-mod', 'toggle-fixture', 'from-disk.jar', false],
        ['instance-toggle-mod', 'toggle-fixture', 'from-disk.jar.disabled', true],
        ['instance-toggle-mod', 'toggle-fixture', 'from-disk.jar', true],
        ['instance-toggle-mod', 'toggle-fixture', 'missing.jar', true],
        ['instance-toggle-mod', 'toggle-fixture', 'missing.jar', false],
        ['instance-toggle-mod', 'toggle-fixture', '../outside.jar', false],
      ]);
    });
  }
});

test('production preload falls back when the native executable is missing or cannot start', async () => {
  for (const broken of [false, true]) {
    await withTempRoot(async root => {
      const modsPath = setupInstance(root);
      const bytes = Buffer.from('fallback exactly once');
      fs.writeFileSync(path.join(modsPath, 'fallback.jar'), bytes);
      if (broken) {
        const candidate = path.join(root, 'rust', 'target', 'debug', binaryName);
        fs.mkdirSync(path.dirname(candidate), { recursive: true });
        fs.writeFileSync(candidate, 'not an executable');
      }
      const handlers = new Map();
      const { exposed } = loadProductionIpc(root, handlers);
      const result = await exposed.craftdockInstance.toggleMod('toggle-fixture', 'fallback.jar', false);
      assert.deepEqual(JSON.parse(JSON.stringify(result)), { success: true });
      assert.deepEqual(fs.readdirSync(modsPath), ['fallback.jar.disabled']);
      assert.deepEqual(fs.readFileSync(path.join(modsPath, 'fallback.jar.disabled')), bytes);
    });
  }
});
