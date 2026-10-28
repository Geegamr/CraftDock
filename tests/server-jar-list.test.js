const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { createServerJarListReader, listJarFilesFallback } = require('../server-jar-list');

const projectRoot = path.resolve(__dirname, '..');
const binaryName = process.platform === 'win32' ? 'craftdock-server-jar-list.exe' : 'craftdock-server-jar-list';
const binaryPath = path.join(projectRoot, 'rust', 'target', 'debug', binaryName);
const silentLogger = { warn() {} };
const statShape = files => files.map(({ name, size, enabled }) => ({ name, size, enabled }));

function makeDirectory(root, name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'alpha.jar'), Buffer.from('enabled jar'));
  fs.writeFileSync(path.join(directory, 'beta.jar.disabled'), Buffer.from('disabled jar contents'));
  fs.writeFileSync(path.join(directory, 'notes.txt'), 'not a jar');
  fs.mkdirSync(path.join(directory, 'folder.jar'));
  return directory;
}

async function withTempRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-server-jars-'));
  try { await callback(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function loadProductionIpc(tempRoot, handlers) {
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
    if (name === './package.json') return require('../package.json');
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

test('Rust scanner matches JavaScript results for both listing directories', async () => {
  const build = spawnSync('cargo', ['build', '--manifest-path', 'rust/Cargo.toml', '--locked', '--bin', 'craftdock-server-jar-list'], {
    cwd: projectRoot, encoding: 'utf8',
  });
  assert.equal(build.status, 0, `Rust JAR scanner build failed:\n${build.stderr}`);
  assert.ok(fs.existsSync(binaryPath), `Rust scanner executable not found: ${binaryPath}`);

  await withTempRoot(async root => {
    for (const name of ['mods', 'plugins']) {
      const directory = makeDirectory(root, name);
      const expected = listJarFilesFallback(directory);
      const native = spawnSync(binaryPath, [directory], { encoding: 'utf8' });
      assert.equal(native.status, 0, `Rust scanner failed: ${native.stderr}`);
      assert.deepEqual(statShape(JSON.parse(native.stdout)), statShape(expected));
      assert.deepEqual(JSON.parse(native.stdout).map(file => Object.keys(file).sort()),
        expected.map(file => Object.keys(file).sort()));
      for (const file of JSON.parse(native.stdout)) {
        const original = expected.find(candidate => candidate.name === file.name);
        assert.ok(Math.abs(file.mtime - original.mtime) < 2, `${name}/${file.name} mtime differs`);
      }
    }
  });
});

test('reader resolves development and packaged binaries and falls back on native failure', async () => {
  await withTempRoot(async root => {
    const directory = makeDirectory(root, 'plugins');
    const expected = listJarFilesFallback(directory);
    const devReleaseBinary = path.join(root, 'rust', 'target', 'release', binaryName);
    const devDebugBinary = path.join(root, 'rust', 'target', 'debug', binaryName);
    const packagedBinary = path.join(root, 'resources', 'native', binaryName);
    for (const candidate of [devReleaseBinary, devDebugBinary, packagedBinary]) fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(devReleaseBinary, '');
    fs.writeFileSync(devDebugBinary, '');
    fs.writeFileSync(packagedBinary, '');

    const calls = [];
    const makeReader = (isPackaged, runFile) => createServerJarListReader({
      isPackaged, appDir: root, resourcesPath: path.join(root, 'resources'), platform: process.platform,
      logger: silentLogger, runFile,
    });
    for (const [isPackaged, expectedBinary] of [[false, devReleaseBinary], [true, packagedBinary]]) {
      const reader = makeReader(isPackaged, (binary, args, options, callback) => {
        calls.push([binary, args, options]);
        callback(null, `${JSON.stringify(expected)}\n`);
      });
      assert.deepEqual(await reader(directory), expected);
      assert.equal(calls.at(-1)[0], expectedBinary);
      if (!isPackaged) {
        fs.rmSync(devReleaseBinary);
        assert.deepEqual(await reader(directory), expected);
        assert.equal(calls.at(-1)[0], devDebugBinary);
      }
    }

    for (const invalidOutput of [null, '{"unexpected":true}']) {
      const failedReader = makeReader(false, (binary, args, options, callback) => {
        callback(null, invalidOutput);
      });
      assert.deepEqual(await failedReader(directory), expected);
    }
    const failedReader = makeReader(false, (binary, args, options, callback) => {
      callback(new Error('native failure'));
    });
    assert.deepEqual(await failedReader(directory), expected);

    const fallbackReader = createServerJarListReader({
      isPackaged: true, appDir: root, resourcesPath: path.join(root, 'missing-resources'), platform: process.platform,
      logger: silentLogger,
    });
    assert.deepEqual(await fallbackReader(directory), expected);
    assert.deepEqual(await fallbackReader(path.join(root, 'missing-directory')), []);
  });
});

test('production preload routes both listing calls and preserves handler result envelopes', async () => {
  await withTempRoot(async root => {
    const serverId = 'ipc-fixture';
    const serversDir = path.join(root, 'craftdock-data', 'servers', serverId);
    const modsDir = makeDirectory(serversDir, 'mods');
    const pluginsDir = makeDirectory(serversDir, 'plugins');
    const expectedMods = listJarFilesFallback(modsDir);
    const expectedPlugins = listJarFilesFallback(pluginsDir);
    const handlers = new Map();
    const { exposed, invocations } = loadProductionIpc(root, handlers);

    assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdockServer.listMods(serverId))), { success: true, files: expectedMods });
    assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdockServer.listPlugins(serverId))), { success: true, files: expectedPlugins });
    assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdockServer.listMods('missing'))), { success: true, files: [] });
    assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdockServer.listPlugins(null))), {
      success: false, error: 'Server ID is required', files: [],
    });
    assert.deepEqual(JSON.parse(JSON.stringify(invocations)), [
      ['server-list-mods', serverId],
      ['server-list-plugins', serverId],
      ['server-list-mods', 'missing'],
      ['server-list-plugins', null],
    ]);
  });
});
