const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { createServerJsonAccess, readServerJsonFallback } = require('../server-json');

const projectRoot = path.resolve(__dirname, '..');
const packageConfig = require('../package.json');
const binaryName = process.platform === 'win32' ? 'craftdock-server-json.exe' : 'craftdock-server-json';
const binaryPath = path.join(projectRoot, 'rust', 'target', 'debug', binaryName);

async function withTempRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-server-json-'));
  try { await callback(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function access(root, isPackaged, runNative) {
  return createServerJsonAccess({
    isPackaged,
    appDir: root,
    resourcesPath: path.join(root, 'resources'),
    platform: process.platform,
    runNative,
  });
}

function loadProductionIpc(tempRoot, handlers, jsonModule) {
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
    if (name === './server-json') return jsonModule;
    if (name === './modpack-metadata') return { createModpackMetadataReader: () => async () => ({}) };
    if (name === './browse-cache') return require('../browse-cache');
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

function buildRustBinary() {
  const result = spawnSync('cargo', [
    'build', '--manifest-path', 'rust/Cargo.toml', '--locked', '--bin', 'craftdock-server-json',
  ], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, `Rust server JSON build failed:\n${result.stderr}`);
  assert.ok(fs.existsSync(binaryPath), `Rust executable not found: ${binaryPath}`);
}

test('Rust and JavaScript preserve shared JSON read/write bytes and result behavior', async () => {
  buildRustBinary();
  await withTempRoot(async root => {
    const contents = Buffer.from('[\r\n  {"name":"🌍","value":1}\r\n]\r\n', 'utf8');
    const nativePath = path.join(root, 'native.json');
    const fallbackPath = path.join(root, 'fallback.json');
    fs.writeFileSync(nativePath, contents);
    fs.writeFileSync(fallbackPath, contents);
    assert.deepEqual(await access(projectRoot, false).read(nativePath), readServerJsonFallback(fallbackPath));

    const value = [{ name: 'server 🌍', nested: { enabled: true }, tags: ['a', 'b'] }];
    const expectedBytes = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
    const nativeOutput = path.join(root, 'native-output.json');
    const fallbackOutput = path.join(root, 'fallback-output.json');
    assert.deepEqual(await access(projectRoot, false).write(nativeOutput, value), { success: true });
    assert.deepEqual(await access(path.join(root, 'no-binaries'), false).write(fallbackOutput, value), { success: true });
    assert.deepEqual(fs.readFileSync(nativeOutput), expectedBytes);
    assert.deepEqual(fs.readFileSync(fallbackOutput), expectedBytes);

    const missing = path.join(root, 'missing.json');
    const malformed = path.join(root, 'malformed.json');
    fs.writeFileSync(malformed, '{ malformed');
    assert.deepEqual(await access(projectRoot, false).read(missing), []);
    assert.deepEqual(await access(projectRoot, false).read(malformed), []);
    assert.deepEqual(await access(path.join(root, 'no-binaries'), false).read(missing), []);
    assert.deepEqual(await access(path.join(root, 'no-binaries'), false).read(malformed), []);
  });
});

test('resolver selects dev release, dev debug, and packaged binary locations', async () => {
  await withTempRoot(async root => {
    const fixture = path.join(root, 'input.json');
    fs.writeFileSync(fixture, '[1]');
    const devRelease = path.join(root, 'rust', 'target', 'release', binaryName);
    const devDebug = path.join(root, 'rust', 'target', 'debug', binaryName);
    const packaged = path.join(root, 'resources', 'native', binaryName);
    for (const candidate of [devRelease, devDebug, packaged]) {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.writeFileSync(candidate, 'stub');
    }
    const calls = [];
    const runNative = async binary => { calls.push(binary); return '[1]'; };
    assert.deepEqual(await access(root, false, runNative).read(fixture), [1]);
    assert.equal(calls.at(-1), devRelease);
    fs.rmSync(devRelease);
    assert.deepEqual(await access(root, false, runNative).read(fixture), [1]);
    assert.equal(calls.at(-1), devDebug);
    assert.deepEqual(await access(root, true, runNative).read(fixture), [1]);
    assert.equal(calls.at(-1), packaged);

    const filters = packageConfig.build.extraResources[0].filter;
    assert.ok(filters.includes('craftdock-server-json'));
    assert.ok(filters.includes('craftdock-server-json.exe'));
    assert.ok(packageConfig.build.files.includes('server-json.js'));
  });
});

test('production preload keeps IPC contract and uses the actual Rust CLI without fallback', async () => {
  buildRustBinary();
  await withTempRoot(async root => {
    const serverId = 'json-fixture';
    const serverDirectory = path.join(root, 'craftdock-data', 'servers', serverId);
    fs.mkdirSync(serverDirectory, { recursive: true });
    const jsonPath = path.join(serverDirectory, 'ops.json');
    const initialBytes = Buffer.from('[\n  {"name":"Old Operator"}\n]', 'utf8');
    fs.writeFileSync(jsonPath, initialBytes);
    const devBinary = path.join(root, 'rust', 'target', 'debug', binaryName);
    fs.mkdirSync(path.dirname(devBinary), { recursive: true });
    fs.copyFileSync(binaryPath, devBinary);

    const nativeExecutions = [];
    const baseModule = require('../server-json');
    const jsonModule = {
      ...baseModule,
      createServerJsonAccess: options => baseModule.createServerJsonAccess({
        ...options,
        runNative: (binary, args, input = '') => {
          const result = spawnSync(binary, args, { input, encoding: 'utf8' });
          nativeExecutions.push({ binary, args, status: result.status, error: result.error?.message ?? null });
          if (result.error) throw result.error;
          if (result.status !== 0) throw new Error(result.stderr || `Rust process exited with ${result.status}`);
          return result.stdout;
        },
      }),
    };
    const handlers = new Map();
    const { exposed, invocations } = loadProductionIpc(root, handlers, jsonModule);
    const value = [{ name: 'New Operator', uuid: 'abc' }];
    const originalReadFileSync = fs.readFileSync;
    const originalWriteFileSync = fs.writeFileSync;
    let readResult;
    let writeResult;
    fs.readFileSync = function (filePath, ...args) {
      if (path.resolve(filePath) === path.resolve(jsonPath)) throw new Error('Unexpected JavaScript read fallback');
      return originalReadFileSync.call(this, filePath, ...args);
    };
    fs.writeFileSync = function (filePath, ...args) {
      if (path.resolve(filePath) === path.resolve(jsonPath)) throw new Error('Unexpected JavaScript write fallback');
      return originalWriteFileSync.call(this, filePath, ...args);
    };
    try {
      readResult = await exposed.craftdockServer.readJsonFile(serverId, 'ops.json');
      writeResult = await exposed.craftdockServer.patchJsonFile(serverId, 'ops.json', value);
    } finally {
      fs.readFileSync = originalReadFileSync;
      fs.writeFileSync = originalWriteFileSync;
    }

    assert.deepEqual(JSON.parse(JSON.stringify(readResult)), JSON.parse(initialBytes.toString('utf8')));
    assert.deepEqual(JSON.parse(JSON.stringify(writeResult)), { success: true });
    assert.deepEqual(fs.readFileSync(jsonPath), Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
    assert.deepEqual(nativeExecutions, [
      { binary: devBinary, args: ['read', jsonPath], status: 0, error: null },
      { binary: devBinary, args: ['write', jsonPath], status: 0, error: null },
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(invocations)), [
      ['server-read-json', serverId, 'ops.json'],
      ['server-patch-json', serverId, 'ops.json', value],
    ]);
  });
});

test('production async runner falls back after Rust failures through preload and IPC', async () => {
  buildRustBinary();
  await withTempRoot(async root => {
    const serverId = 'json-failure-fixture';
    const serverDirectory = path.join(root, 'craftdock-data', 'servers', serverId);
    fs.mkdirSync(serverDirectory, { recursive: true });
    const devBinary = path.join(root, 'rust', 'target', 'debug', binaryName);
    fs.mkdirSync(path.dirname(devBinary), { recursive: true });
    fs.copyFileSync(binaryPath, devBinary);

    const missingPath = path.join(serverDirectory, 'missing.json');
    const writeFailurePath = path.join(serverDirectory, 'missing-parent', 'ops.json');
    for (const [args, label] of [
      [['read', missingPath], 'read'],
      [['write', writeFailurePath], 'write'],
    ]) {
      const result = spawnSync(devBinary, args, { input: label === 'write' ? '{}' : undefined, encoding: 'utf8' });
      assert.equal(result.error, undefined, `Rust ${label} should start successfully`);
      assert.notEqual(result.status, 0, `Rust ${label} should fail for its missing path`);
    }

    const handlers = new Map();
    const { exposed, invocations } = loadProductionIpc(root, handlers, require('../server-json'));
    const originalReadFileSync = fs.readFileSync;
    const originalWriteFileSync = fs.writeFileSync;
    let fallbackReads = 0;
    let fallbackWrites = 0;
    fs.readFileSync = function (filePath, ...args) {
      if (path.resolve(filePath) === path.resolve(missingPath)) fallbackReads++;
      return originalReadFileSync.call(this, filePath, ...args);
    };
    fs.writeFileSync = function (filePath, ...args) {
      if (path.resolve(filePath) === path.resolve(writeFailurePath)) fallbackWrites++;
      return originalWriteFileSync.call(this, filePath, ...args);
    };
    let readResult;
    let writeResult;
    try {
      readResult = await exposed.craftdockServer.readJsonFile(serverId, 'missing.json');
      writeResult = await exposed.craftdockServer.patchJsonFile(serverId, 'missing-parent/ops.json', {});
    } finally {
      fs.readFileSync = originalReadFileSync;
      fs.writeFileSync = originalWriteFileSync;
    }

    assert.deepEqual(JSON.parse(JSON.stringify(readResult)), []);
    assert.equal(writeResult.success, false);
    assert.match(writeResult.error, /ENOENT/);
    assert.equal(fallbackReads, 1, 'failed native read should use the JavaScript reader');
    assert.equal(fallbackWrites, 1, 'failed native write should attempt the JavaScript writer');
    assert.deepEqual(JSON.parse(JSON.stringify(invocations)), [
      ['server-read-json', serverId, 'missing.json'],
      ['server-patch-json', serverId, 'missing-parent/ops.json', {}],
    ]);
  });
});

test('production preload preserves missing/malformed reads and JS fallback write errors', async () => {
  await withTempRoot(async root => {
    const serverDirectory = path.join(root, 'craftdock-data', 'servers', 'json-fixture');
    fs.mkdirSync(serverDirectory, { recursive: true });
    fs.writeFileSync(path.join(serverDirectory, 'bad.json'), 'not json');
    fs.writeFileSync(path.join(serverDirectory, 'ops.json'), '[]');
    fs.writeFileSync(path.join(serverDirectory, 'valid.json'), '[{"name":"Fallback"}]');
    const handlers = new Map();
    const { exposed, invocations } = loadProductionIpc(root, handlers, require('../server-json'));
    assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdockServer.readJsonFile('json-fixture', 'valid.json'))), [{ name: 'Fallback' }]);
    assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdockServer.readJsonFile('json-fixture', 'missing.json'))), []);
    assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdockServer.readJsonFile('json-fixture', 'bad.json'))), []);
    const fallbackWrite = await exposed.craftdockServer.patchJsonFile('json-fixture', 'ops.json', [{ name: 'Fallback' }]);
    assert.deepEqual(JSON.parse(JSON.stringify(fallbackWrite)), { success: true });
    assert.deepEqual(fs.readFileSync(path.join(serverDirectory, 'ops.json')), Buffer.from('[\n  {\n    "name": "Fallback"\n  }\n]', 'utf8'));
    const failure = await exposed.craftdockServer.patchJsonFile('missing', 'ops.json', []);
    assert.equal(failure.success, false);
    assert.match(failure.error, /ENOENT/);
    assert.deepEqual(JSON.parse(JSON.stringify(invocations)), [
      ['server-read-json', 'json-fixture', 'valid.json'],
      ['server-read-json', 'json-fixture', 'missing.json'],
      ['server-read-json', 'json-fixture', 'bad.json'],
      ['server-patch-json', 'json-fixture', 'ops.json', [{ name: 'Fallback' }]],
      ['server-patch-json', 'missing', 'ops.json', []],
    ]);
  });
});
