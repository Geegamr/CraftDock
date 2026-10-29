const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { createConfigFileListReader, listConfigFilesFallback } = require('../config-file-list');

const projectRoot = path.resolve(__dirname, '..');
const binaryName = process.platform === 'win32' ? 'craftdock-config-file-list.exe' : 'craftdock-config-file-list';
const binaryPath = path.join(projectRoot, 'rust', 'target', 'debug', binaryName);
const silentLogger = { warn() {} };

async function withTempRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-config-files-'));
  try { await callback(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function populateConfigFiles(directory) {
  fs.mkdirSync(path.join(directory, 'nested', 'deep'), { recursive: true });
  for (const name of [
    'zeta.TOML',
    'alpha.json',
    'nested/mod.YAML',
    'nested/deep/options.InI',
    'nested/deep/readme.md',
    'ignored.XML',
    '.toml',
  ]) {
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, 'config fixture');
  }
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
    if (name === './config-file-list') return require('../config-file-list');
    if (name === './server-properties') return require('../server-properties');
    if (name === './modpack-metadata') return { createModpackMetadataReader: () => async () => ({}) };
    if (name === './package.json') return require('../package.json');
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8'), {
    Buffer, __dirname: tempRoot, console: { log() {}, warn() {}, error() {} }, fetch,
    module: { exports: {} }, process: { ...process, resourcesPath: path.join(tempRoot, 'resources') },
    require: mockMainRequire, setInterval: () => 0, clearInterval() {},
  }, { filename: 'main.js' });

  const electronPreload = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      invoke: (channel, ...args) => {
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
  return exposed;
}

test('Rust scanner and JavaScript fallback match on nested config files and sorting', async () => {
  const build = spawnSync('cargo', ['build', '--manifest-path', 'rust/Cargo.toml', '--locked', '--bin', 'craftdock-config-file-list'], {
    cwd: projectRoot, encoding: 'utf8',
  });
  assert.equal(build.status, 0, `Rust config scanner build failed:\n${build.stderr}`);
  assert.ok(fs.existsSync(binaryPath), `Rust scanner executable not found: ${binaryPath}`);

  await withTempRoot(async root => {
    const directory = path.join(root, 'config');
    populateConfigFiles(directory);
    const expected = listConfigFilesFallback(directory);
    const reader = createConfigFileListReader({
      isPackaged: false, appDir: projectRoot, resourcesPath: path.join(root, 'resources'),
      platform: process.platform, logger: silentLogger,
    });
    const actual = await reader(directory);
    assert.deepEqual(actual, expected);
    assert.deepEqual(actual.map(({ name, subdir }) => [name, subdir]),
      [...actual].sort((left, right) => left.name.localeCompare(right.name))
        .map(({ name, subdir }) => [name, subdir]));
    assert.deepEqual(actual.map(({ name, subdir }) => [name, subdir]), [
      ['alpha.json', ''],
      ['mod.YAML', 'nested'],
      ['options.InI', 'nested/deep'],
      ['zeta.TOML', ''],
    ]);
    assert.ok(actual.every(file => path.isAbsolute(file.path)));
    assert.deepEqual(actual.map(file => Object.keys(file).sort()), actual.map(() => ['name', 'path', 'subdir']));
  });
});

test('fallback skips an unreadable nested directory and keeps readable sibling results', async () => {
  await withTempRoot(async root => {
    const directory = path.join(root, 'config');
    const unreadable = path.join(directory, 'locked');
    fs.mkdirSync(unreadable, { recursive: true });
    fs.mkdirSync(path.join(directory, 'readable'));
    fs.writeFileSync(path.join(unreadable, 'hidden.toml'), 'hidden');
    fs.writeFileSync(path.join(directory, 'readable', 'visible.JSON'), 'visible');

    const originalReadDirectory = fs.readdirSync;
    try {
      fs.readdirSync = (target, ...args) => {
        if (path.resolve(String(target)) === unreadable) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return originalReadDirectory.call(fs, target, ...args);
      };
      assert.deepEqual(listConfigFilesFallback(directory), [{
        name: 'visible.JSON', path: path.join(directory, 'readable', 'visible.JSON'), subdir: 'readable',
      }]);
    } finally {
      fs.readdirSync = originalReadDirectory;
    }
  });
});

test('empty and missing roots return empty lists', async () => {
  await withTempRoot(async root => {
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    const reader = createConfigFileListReader({
      isPackaged: true, appDir: root, resourcesPath: path.join(root, 'resources'),
      platform: process.platform, logger: silentLogger,
    });
    assert.deepEqual(await reader(empty), []);
    assert.deepEqual(await reader(path.join(root, 'missing')), []);
  });
});

test('reader resolves development and packaged binaries and falls back on failures', async () => {
  await withTempRoot(async root => {
    const directory = path.join(root, 'config');
    populateConfigFiles(directory);
    const expected = listConfigFilesFallback(directory);
    const devRelease = path.join(root, 'rust', 'target', 'release', binaryName);
    const devDebug = path.join(root, 'rust', 'target', 'debug', binaryName);
    const packaged = path.join(root, 'resources', 'native', binaryName);
    for (const file of [devRelease, devDebug, packaged]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'stub');
    }
    const calls = [];
    const reader = (isPackaged, runFile) => createConfigFileListReader({
      isPackaged, appDir: root, resourcesPath: path.join(root, 'resources'),
      platform: process.platform, logger: silentLogger, runFile,
    });
    const runOk = (binary, args, options, callback) => {
      calls.push(binary);
      callback(null, `${JSON.stringify(expected)}\n`);
    };

    assert.deepEqual(await reader(false, runOk)(directory), expected);
    assert.equal(calls.at(-1), devRelease);
    fs.rmSync(devRelease);
    assert.deepEqual(await reader(false, runOk)(directory), expected);
    assert.equal(calls.at(-1), devDebug);
    assert.deepEqual(await reader(true, runOk)(directory), expected);
    assert.equal(calls.at(-1), packaged);
    assert.deepEqual(await reader(false, (binary, args, options, callback) => callback(new Error('native failure')))(directory), expected);
    assert.deepEqual(await reader(false, (binary, args, options, callback) => callback(null, 'invalid'))(directory), expected);
    assert.deepEqual(await createConfigFileListReader({
      isPackaged: false, appDir: path.join(root, 'no-binaries'),
      resourcesPath: path.join(root, 'no-resources'), platform: process.platform, logger: silentLogger,
    })(directory), expected);
  });
});

test('production preload reaches config listing handler with the existing result shape', async () => {
  await withTempRoot(async root => {
    const instanceId = 'config-fixture';
    const configDirectory = path.join(root, 'craftdock-data', 'instances', instanceId, 'config');
    populateConfigFiles(configDirectory);
    const expected = listConfigFilesFallback(configDirectory);
    const handlers = new Map();
    const exposed = loadProductionIpc(root, handlers);
    const files = await exposed.craftdockInstance.listConfigFiles(instanceId);
    assert.deepEqual(JSON.parse(JSON.stringify(files)), expected);
    assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdockInstance.listConfigFiles('missing'))), []);
  });
});
