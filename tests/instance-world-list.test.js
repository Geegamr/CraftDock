const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { createInstanceWorldListReader, listInstanceWorldsFallback } = require('../instance-world-list');

const projectRoot = path.resolve(__dirname, '..');
const binaryName = process.platform === 'win32' ? 'craftdock-instance-world-list.exe' : 'craftdock-instance-world-list';
const binaryPath = path.join(projectRoot, 'rust', 'target', 'debug', binaryName);
const releaseBinaryPath = path.join(projectRoot, 'rust', 'target', 'release', binaryName);
const fixture = require('./fixtures/instance-world-list/worlds.json');
const silentLogger = { warn() {} };

async function withTempRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-world-list-'));
  try { await callback(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function createWorldFixture(root) {
  const savesPath = path.join(root, 'saves');
  for (const world of fixture.worlds) {
    const worldPath = path.join(savesPath, world.name);
    fs.mkdirSync(worldPath, { recursive: true });
    if (world.levelDatMtimeMs === null) fs.writeFileSync(path.join(worldPath, 'README.txt'), 'never played');
    else {
      const levelDat = path.join(worldPath, 'level.dat');
      fs.writeFileSync(levelDat, `${world.name}-level`);
      fs.utimesSync(levelDat, new Date(world.levelDatMtimeMs), new Date(world.levelDatMtimeMs));
    }
  }
  fs.mkdirSync(savesPath, { recursive: true });
  fs.writeFileSync(path.join(savesPath, fixture.nonDirectory), 'ordinary file');
  return savesPath;
}

function createReader(root, isPackaged, runFile, logger = silentLogger) {
  return createInstanceWorldListReader({
    isPackaged,
    appDir: root,
    resourcesPath: path.join(root, 'resources'),
    platform: process.platform,
    logger,
    runFile,
  });
}

function runRealBinary(binary, args, options, callback, executions) {
  const result = spawnSync(binary, args, {
    encoding: options.encoding,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: options.windowsHide,
  });
  const error = result.error || (result.status === 0 ? null :
    new Error(`Rust binary exited with status ${result.status}: ${result.stderr || ''}`));
  executions.push({ binary, error: error?.message ?? null, status: result.status });
  callback(error, result.stdout, result.stderr);
}

function loadProductionIpc(tempRoot, handlers, nativeExecutions, nativeWarnings) {
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
    if (name === './instance-world-list') {
      const worldList = require('../instance-world-list');
      return {
        ...worldList,
        createInstanceWorldListReader: options => worldList.createInstanceWorldListReader({
          ...options,
          logger: { warn: (...warning) => nativeWarnings.push(warning) },
          runFile: (binary, args, execOptions, callback) =>
            runRealBinary(binary, args, execOptions, callback, nativeExecutions),
        }),
      };
    }
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

test('Rust and JavaScript match the world fixture, including canonical paths and sort order', async () => {
  const build = spawnSync('cargo', ['build', '--manifest-path', 'rust/Cargo.toml', '--locked', '--bin', 'craftdock-instance-world-list'], {
    cwd: projectRoot, encoding: 'utf8',
  });
  assert.equal(build.status, 0, `Rust world scanner build failed:\n${build.stderr}`);
  assert.ok(fs.existsSync(binaryPath), `Rust scanner executable not found: ${binaryPath}`);

  await withTempRoot(async root => {
    const savesPath = createWorldFixture(root);
    const fallback = listInstanceWorldsFallback(savesPath);
    const native = spawnSync(binaryPath, [savesPath], { encoding: 'utf8' });
    assert.equal(native.status, 0, `Rust scanner failed: ${native.stderr}`);
    const rustWorlds = JSON.parse(native.stdout);
    assert.deepEqual(rustWorlds, fallback);
    assert.deepEqual(rustWorlds, [
      ...fixture.worlds.slice().sort((left, right) => (right.levelDatMtimeMs || 0) - (left.levelDatMtimeMs || 0))
        .map(({ name, levelDatMtimeMs }) => ({
          name, path: path.join(fs.realpathSync(savesPath), name), lastPlayed: levelDatMtimeMs,
        })),
    ]);
    assert.ok(rustWorlds.every(world => path.isAbsolute(world.path)));

    const releaseBuild = spawnSync('cargo', ['build', '--release', '--manifest-path', 'rust/Cargo.toml', '--locked', '--bin', 'craftdock-instance-world-list'], {
      cwd: projectRoot, encoding: 'utf8',
    });
    assert.equal(releaseBuild.status, 0, `Rust release scanner build failed:\n${releaseBuild.stderr}`);
    const packagedBinary = path.join(root, 'resources', 'native', binaryName);
    fs.mkdirSync(path.dirname(packagedBinary), { recursive: true });
    fs.copyFileSync(releaseBinaryPath, packagedBinary);
    const packagedExecutions = [];
    const packagedWarnings = [];
    const packagedReader = createReader(root, true,
      (binary, args, options, callback) => runRealBinary(binary, args, options, callback, packagedExecutions),
      { warn: (...warning) => packagedWarnings.push(warning) });
    assert.deepEqual(await packagedReader(savesPath), rustWorlds,
      'packaged resolver should execute the release Rust binary from resources/native');
    assert.deepEqual(packagedExecutions, [{ binary: packagedBinary, error: null, status: 0 }],
      'packaged resolver must complete the real Rust binary successfully');
    assert.deepEqual(packagedWarnings, [], 'packaged resolver must not fall back to JavaScript');
  });
});

test('missing, unreadable, and non-directory saves paths yield empty world lists', async () => {
  await withTempRoot(async root => {
    const reader = createReader(root, true, (binary, args, options, callback) => callback(new Error('native unavailable')));
    const missing = path.join(root, 'missing-saves');
    const file = path.join(root, 'not-a-directory');
    fs.writeFileSync(file, 'not a directory');
    assert.deepEqual(listInstanceWorldsFallback(missing), []);
    assert.deepEqual(await reader(missing), []);
    assert.deepEqual(listInstanceWorldsFallback(file), []);
    assert.deepEqual(await reader(file), []);
  });
});

test('reader resolves dev and packaged binaries and falls back when native execution fails', async () => {
  await withTempRoot(async root => {
    const savesPath = createWorldFixture(root);
    const expected = listInstanceWorldsFallback(savesPath);
    const devRelease = path.join(root, 'rust', 'target', 'release', binaryName);
    const devDebug = path.join(root, 'rust', 'target', 'debug', binaryName);
    const packaged = path.join(root, 'resources', 'native', binaryName);
    for (const file of [devRelease, devDebug, packaged]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'stub');
    }
    const calls = [];
    const runOk = (binary, args, options, callback) => {
      calls.push([binary, args]);
      callback(null, `${JSON.stringify(expected)}\n`);
    };

    assert.deepEqual(await createReader(root, false, runOk)(savesPath), expected);
    assert.equal(calls.at(-1)[0], devRelease);
    fs.rmSync(devRelease);
    assert.deepEqual(await createReader(root, false, runOk)(savesPath), expected);
    assert.equal(calls.at(-1)[0], devDebug);
    assert.deepEqual(await createReader(root, true, runOk)(savesPath), expected);
    assert.equal(calls.at(-1)[0], packaged);

    const fallbackAfterFailure = createReader(root, false,
      (binary, args, options, callback) => callback(new Error('native failure')));
    assert.deepEqual(await fallbackAfterFailure(savesPath), expected);
    const fallbackAfterInvalidOutput = createReader(root, false,
      (binary, args, options, callback) => callback(null, 'invalid json'));
    assert.deepEqual(await fallbackAfterInvalidOutput(savesPath), expected);
    assert.deepEqual(await createReader(path.join(root, 'no-binaries'), false)(savesPath), expected);
  });
});

test('production preload preserves instance-list-worlds IPC for native and fallback paths', async () => {
  for (const useRust of [false, true]) {
    await withTempRoot(async root => {
      const instanceId = 'world-fixture';
      const savesPath = createWorldFixture(path.join(root, 'craftdock-data', 'instances', instanceId));
      if (useRust) {
        const build = spawnSync('cargo', ['build', '--manifest-path', 'rust/Cargo.toml', '--locked', '--bin', 'craftdock-instance-world-list'], {
          cwd: projectRoot, encoding: 'utf8',
        });
        assert.equal(build.status, 0, `Rust scanner build failed:\n${build.stderr}`);
        const devBinary = path.join(root, 'rust', 'target', 'debug', binaryName);
        fs.mkdirSync(path.dirname(devBinary), { recursive: true });
        fs.copyFileSync(binaryPath, devBinary);
      }
      const handlers = new Map();
      const nativeExecutions = [];
      const nativeWarnings = [];
      const { exposed, invocations } = loadProductionIpc(root, handlers, nativeExecutions, nativeWarnings);
      const expected = listInstanceWorldsFallback(savesPath);
      assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdockInstance.listWorlds(instanceId))), expected);
      assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdockInstance.listWorlds('missing'))), []);
      assert.deepEqual(JSON.parse(JSON.stringify(invocations)), [
        ['instance-list-worlds', instanceId],
        ['instance-list-worlds', 'missing'],
      ]);
      assert.deepEqual(nativeExecutions, useRust ? [
        { binary: path.join(root, 'rust', 'target', 'debug', binaryName), error: null, status: 0 },
        { binary: path.join(root, 'rust', 'target', 'debug', binaryName), error: null, status: 0 },
      ] : [], 'preload → IPC must complete Rust successfully in native mode and avoid it in fallback mode');
      assert.deepEqual(nativeWarnings, [], 'preload → IPC must not fall back to JavaScript');
    });
  }
});

test('JavaScript fallback resolves a shared-world symlink to canonical world paths', async t => {
  await withTempRoot(async root => {
    const savesPath = createWorldFixture(root);
    const linkPath = path.join(root, 'instance-saves');
    try { fs.symlinkSync(savesPath, linkPath, 'junction'); }
    catch (error) {
      if (process.platform === 'win32') return t.skip(`junction unavailable: ${error.message}`);
      throw error;
    }
    const worlds = listInstanceWorldsFallback(linkPath);
    assert.deepEqual(worlds, listInstanceWorldsFallback(savesPath));
    assert.ok(worlds.every(world => world.path.startsWith(fs.realpathSync(savesPath))));
  });
});
