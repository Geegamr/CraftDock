const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const {
  createServerPropertiesAccess,
  parseServerProperties,
  readServerPropertiesFallback,
} = require('../server-properties');

const projectRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(__dirname, 'fixtures', 'server-properties');
const binaryName = process.platform === 'win32' ? 'craftdock-server-properties.exe' : 'craftdock-server-properties';
const binaryPath = path.join(projectRoot, 'rust', 'target', 'debug', binaryName);

async function withTempRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-server-properties-'));
  try { await callback(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function access(root, isPackaged, runNative) {
  return createServerPropertiesAccess({
    isPackaged,
    appDir: root,
    resourcesPath: path.join(root, 'resources'),
    platform: process.platform,
    runNative,
  });
}

function loadProductionIpc(tempRoot, handlers, serverPropertiesModule = require('../server-properties')) {
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
    if (name === './server-properties') return serverPropertiesModule;
    if (name === './modpack-metadata') return { createModpackMetadataReader: () => async () => ({}) };
    if (name === './browse-cache') return require('../browse-cache');
    if (name === './launcher-import') return require('../launcher-import');
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

test('Rust and JavaScript parse the shared edge-case fixture identically', async () => {
  const build = spawnSync('cargo', ['build', '--manifest-path', 'rust/Cargo.toml', '--locked', '--bin', 'craftdock-server-properties'], {
    cwd: projectRoot, encoding: 'utf8',
  });
  assert.equal(build.status, 0, `Rust server.properties build failed:\n${build.stderr}`);
  assert.ok(fs.existsSync(binaryPath), `Rust executable not found: ${binaryPath}`);

  const fixture = path.join(fixtureRoot, 'read-edge.properties');
  const native = spawnSync(binaryPath, ['read', fixture], { encoding: 'utf8' });
  assert.equal(native.status, 0, `Rust reader failed: ${native.stderr}`);
  const rustEntries = JSON.parse(native.stdout);
  const expected = parseServerProperties(fs.readFileSync(fixture, 'utf8'));
  const rustObject = {};
  for (const [key, value] of rustEntries) rustObject[key] = value;
  assert.deepEqual(rustObject, expected);
  assert.deepEqual(expected, {
    'online-mode': 'true', message: 'a=b=c', empty: '', duplicate: 'last', unicode: 'world 🌍',
  });
  assert.deepEqual(await access(projectRoot, false).read(fixture), expected);
});

test('Rust writer matches exact JS bytes including the final newline and empty object', async () => {
  await withTempRoot(async root => {
    const pathA = path.join(root, 'native.properties');
    const pathB = path.join(root, 'fallback.properties');
    const values = { motd: 'hello=world', 'online-mode': 'true', empty: '' };
    const entries = Object.entries(values).map(([key, value]) => [key, `${value}`]);
    const contents = entries.map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
    const native = spawnSync(binaryPath, ['write', pathA], { input: JSON.stringify(entries), encoding: 'utf8' });
    assert.equal(native.status, 0, `Rust writer failed: ${native.stderr}`);
    fs.writeFileSync(pathB, contents, 'utf8');
    assert.deepEqual(fs.readFileSync(pathA), fs.readFileSync(pathB));
    assert.deepEqual(fs.readFileSync(pathA), Buffer.from('motd=hello=world\nonline-mode=true\nempty=\n'));

    const realNativePath = path.join(root, 'real-native.properties');
    assert.deepEqual(await access(projectRoot, false).write(realNativePath, values), { success: true });
    assert.deepEqual(fs.readFileSync(realNativePath), Buffer.from('motd=hello=world\nonline-mode=true\nempty=\n'));

    const empty = path.join(root, 'empty.properties');
    const emptyResult = spawnSync(binaryPath, ['write', empty], { input: '[]', encoding: 'utf8' });
    assert.equal(emptyResult.status, 0);
    assert.deepEqual(fs.readFileSync(empty), Buffer.from('\n'));
  });
});

test('missing files return an empty object in Rust, fallback, and reader paths', async () => {
  await withTempRoot(async root => {
    const missing = path.join(root, 'missing.properties');
    const rust = spawnSync(binaryPath, ['read', missing], { encoding: 'utf8' });
    assert.notEqual(rust.status, 0);
    assert.deepEqual(readServerPropertiesFallback(missing), {});
    assert.deepEqual(await access(root, false).read(missing), {});
  });
});

test('reader and writer resolve dev/packaged binaries and fall back when absent or broken', async () => {
  await withTempRoot(async root => {
    const fixture = path.join(fixtureRoot, 'read-edge.properties');
    const expected = readServerPropertiesFallback(fixture);
    const devRelease = path.join(root, 'rust', 'target', 'release', binaryName);
    const devDebug = path.join(root, 'rust', 'target', 'debug', binaryName);
    const packaged = path.join(root, 'resources', 'native', binaryName);
    for (const file of [devRelease, devDebug, packaged]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'stub');
    }
    const calls = [];
    const nativeSuccess = async (binary, args, input) => {
      calls.push([binary, args, input]);
      return args[0] === 'read'
        ? JSON.stringify(Object.entries(expected))
        : '';
    };

    assert.deepEqual(await access(root, false, nativeSuccess).read(fixture), expected);
    assert.equal(calls.at(-1)[0], devRelease);
    fs.rmSync(devRelease);
    assert.deepEqual(await access(root, false, nativeSuccess).read(fixture), expected);
    assert.equal(calls.at(-1)[0], devDebug);
    assert.deepEqual(await access(root, true, nativeSuccess).read(fixture), expected);
    assert.equal(calls.at(-1)[0], packaged);
    const packagedWriter = access(root, true, nativeSuccess);
    const packagedOutput = path.join(root, 'packaged.properties');
    assert.deepEqual(await packagedWriter.write(packagedOutput, { packaged: true }), { success: true });
    assert.equal(calls.at(-1)[0], packaged);

    const writer = access(root, false, nativeSuccess);
    const output = path.join(root, 'written.properties');
    assert.deepEqual(await writer.write(output, { first: 'one', second: 'two=three' }), { success: true });
    assert.equal(calls.at(-1)[2], JSON.stringify([['first', 'one'], ['second', 'two=three']]));

    const failed = access(root, false, async () => { throw new Error('native failed'); });
    assert.deepEqual(await failed.read(fixture), expected);
    const fallbackOutput = path.join(root, 'fallback.properties');
    assert.deepEqual(await failed.write(fallbackOutput, { first: 'one' }), { success: true });
    assert.equal(fs.readFileSync(fallbackOutput, 'utf8'), 'first=one\n');

    const noBinary = access(path.join(root, 'no-binaries'), false);
    assert.deepEqual(await noBinary.read(fixture), expected);
    const noBinaryOutput = path.join(root, 'no-binary.properties');
    assert.deepEqual(await noBinary.write(noBinaryOutput, {}), { success: true });
    assert.equal(fs.readFileSync(noBinaryOutput, 'utf8'), '\n');
  });
});

test('production preload preserves read/write IPC through fallback and the actual Rust executable', async () => {
  for (const useRust of [false, true]) {
    await withTempRoot(async root => {
      const serverId = 'properties-fixture';
      const serverDirectory = path.join(root, 'craftdock-data', 'servers', serverId);
      fs.mkdirSync(serverDirectory, { recursive: true });
      const propertiesFile = path.join(serverDirectory, 'server.properties');
      const devBinary = path.join(root, 'rust', 'target', 'debug', binaryName);
      fs.copyFileSync(path.join(fixtureRoot, 'read-edge.properties'), propertiesFile);

      if (useRust) {
        const build = spawnSync('cargo', ['build', '--manifest-path', 'rust/Cargo.toml', '--locked', '--bin', 'craftdock-server-properties'], {
          cwd: projectRoot, encoding: 'utf8',
        });
        assert.equal(build.status, 0, `Rust server.properties build failed:\n${build.stderr}`);
        fs.mkdirSync(path.dirname(devBinary), { recursive: true });
        fs.copyFileSync(binaryPath, devBinary);
        assert.ok(fs.existsSync(devBinary), 'the actual Rust executable must be available to the dev resolver');
      }

      const nativeCalls = [];
      const baseServerProperties = require('../server-properties');
      const serverPropertiesModule = useRust
        ? {
          ...baseServerProperties,
          createServerPropertiesAccess: options => baseServerProperties.createServerPropertiesAccess({
            ...options,
            runNative: (binary, args, input = '') => {
              const result = spawnSync(binary, args, { input, encoding: 'utf8' });
              nativeCalls.push({ binary, args, status: result.status });
              if (result.error) throw result.error;
              if (result.status !== 0) throw new Error(result.stderr || `Rust process exited with ${result.status}`);
              return result.stdout;
            },
          }),
        }
        : baseServerProperties;
      const handlers = new Map();
      const { exposed, invocations } = loadProductionIpc(root, handlers, serverPropertiesModule);
      const expected = readServerPropertiesFallback(propertiesFile);
      let readResult;
      let writeResult;
      if (useRust) {
        const originalReadFileSync = fs.readFileSync;
        const originalWriteFileSync = fs.writeFileSync;
        fs.readFileSync = function (filePath, ...args) {
          if (path.resolve(filePath) === path.resolve(propertiesFile)) throw new Error('Unexpected JavaScript read fallback');
          return originalReadFileSync.call(this, filePath, ...args);
        };
        fs.writeFileSync = function (filePath, ...args) {
          if (path.resolve(filePath) === path.resolve(propertiesFile)) throw new Error('Unexpected JavaScript write fallback');
          return originalWriteFileSync.call(this, filePath, ...args);
        };
        try {
          readResult = await exposed.craftdockServer.readServerProps(serverId);
          writeResult = await exposed.craftdockServer.writeProperties(serverId, { motd: 'a=b', online: true });
        } finally {
          fs.readFileSync = originalReadFileSync;
          fs.writeFileSync = originalWriteFileSync;
        }
        assert.deepEqual(nativeCalls.map(({ args, status }) => [args[0], status]), [['read', 0], ['write', 0]]);
        assert.deepEqual(nativeCalls.map(({ binary }) => binary), [devBinary, devBinary]);
      } else {
        readResult = await exposed.craftdockServer.readServerProps(serverId);
        writeResult = await exposed.craftdockServer.writeProperties(serverId, { motd: 'a=b', online: true });
      }
      assert.deepEqual(JSON.parse(JSON.stringify(readResult)), expected);
      assert.deepEqual(JSON.parse(JSON.stringify(writeResult)), { success: true });
      assert.deepEqual(fs.readFileSync(propertiesFile), Buffer.from('motd=a=b\nonline=true\n'));
      await assert.rejects(exposed.craftdockServer.writeProperties('missing', {}), /ENOENT/);
      assert.deepEqual(JSON.parse(JSON.stringify(invocations)), [
        ['server-read-props', serverId],
        ['server-write-props', serverId, { motd: 'a=b', online: true }],
        ['server-write-props', 'missing', {}],
      ]);
    });
  }
});
