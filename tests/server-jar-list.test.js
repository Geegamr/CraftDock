const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const zlib = require('node:zlib');
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

function makeZip(entries) {
  const crc32 = data => {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, value, options = {}] of entries) {
    const filename = Buffer.from(name);
    const data = Buffer.from(value);
    const compressed = options.compression === 8 ? zlib.deflateRawSync(data) : data;
    const declaredUncompressedSize = options.declaredUncompressedSize ?? data.length;
    const crc = (crc32(data) ^ (options.corruptCrc ? 1 : 0)) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(options.compression || 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredUncompressedSize, 22);
    local.writeUInt16LE(filename.length, 26);
    localParts.push(local, filename, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(options.compression || 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredUncompressedSize, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, filename);
    localOffset += local.length + filename.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function loadProductionIpc(tempRoot, handlers, options = {}) {
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
  const mainFs = Object.keys(options.fsOverrides || {}).length
    ? Object.assign(Object.create(fs), options.fsOverrides)
    : fs;
  const mockMainRequire = name => {
    if (name === 'electron') return electronMain;
    if (name === 'https' && options.httpsModule) return options.httpsModule;
    if (name === 'child_process' && options.childProcess) return options.childProcess;
    if (name === './servers-dat') return require('../servers-dat');
    if (name === './server-jar-list') return require('../server-jar-list');
    if (name === './screenshot-list') return require('../screenshot-list');
    if (name === './config-file-list') return require('../config-file-list');
    if (name === './server-properties') return require('../server-properties');
    if (name === './modpack-metadata') return { createModpackMetadataReader: () => async () => ({}) };
    if (name === './browse-cache') return require('../browse-cache');
    if (name === './launcher-import') return require('../launcher-import');
    if (name === './package.json') return require('../package.json');
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8'), {
    Buffer, __dirname: tempRoot, console: { log() {}, warn() {}, error() {}, ...(options.console || {}) }, fetch,
    module: { exports: {} }, process: { ...process, resourcesPath: path.join(tempRoot, 'resources') },
    require: name => name === 'fs' ? mainFs : mockMainRequire(name),
    setInterval: () => 0, clearInterval() {},
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
  }, { filename: 'main.js' });

  const invocations = [];
  const electronPreload = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      invoke: (channel, ...args) => {
        invocations.push([channel, ...args]);
        const handler = handlers.get(channel);
        assert.ok(handler, `No main handler registered for ${channel}`);
        const sender = options.sender || 'preload-test';
        return Promise.resolve(handler({ sender }, ...args));
      },
      send() {}, on() {},
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf8'), {
    require: name => name === 'electron' ? electronPreload : require(name),
  }, { filename: 'preload.js' });
  return { exposed, invocations };
}

function prepareNativeLaunch(root, archivePaths, nativeSuffix, nativeNames = []) {
  const version = '1.16.5';
  const id = 'native-jar-fixture';
  const dataRoot = path.join(root, 'craftdock-data');
  const versionDir = path.join(dataRoot, 'client-cache', version);
  const librariesDir = path.join(dataRoot, 'client-cache', 'libraries');
  const instanceDir = path.join(dataRoot, 'instances', id);
  const archives = (Array.isArray(archivePaths) ? archivePaths : [archivePaths]).map((archivePath, index) => {
    const artifact = index === 0 ? 'lwjgl' : `lwjgl-extra${index}`;
    const nativeJar = path.join(librariesDir, 'org', 'lwjgl', `${artifact}-3.3.3-${nativeSuffix}.jar`);
    fs.mkdirSync(path.dirname(nativeJar), { recursive: true });
    fs.copyFileSync(archivePath, nativeJar);
    return { nativeJar, artifactPath: path.relative(librariesDir, nativeJar) };
  });
  fs.mkdirSync(versionDir, { recursive: true });
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'client-cache', 'assets', 'indexes'), { recursive: true });
  fs.writeFileSync(path.join(instanceDir, 'instance.json'), JSON.stringify({ id, mcVersion: version, javaPath: 'java' }));
  fs.writeFileSync(path.join(versionDir, 'version.json'), JSON.stringify({
    mainClass: 'net.minecraft.client.main.Main',
    downloads: { client: { url: 'https://fixture.invalid/client.jar' } },
    libraries: archives.map(({ artifactPath }) => ({ downloads: { artifact: {
      url: 'https://fixture.invalid/native.jar', path: artifactPath,
    } } })),
    assetIndex: { id: 'fixture' },
  }));
  fs.writeFileSync(path.join(versionDir, `minecraft-${version}-client.jar`), 'cached client jar');
  fs.writeFileSync(path.join(dataRoot, 'client-cache', 'assets', 'indexes', 'fixture.json'), JSON.stringify({ objects: {} }));
  const nativePaths = nativeNames.map(name => path.join(versionDir, 'natives', name));
  return { id, version, nativeJar: archives[0].nativeJar, nativeJars: archives.map(({ nativeJar }) => nativeJar), nativePath: nativePaths[0], nativePaths };
}

function launchDependencies() {
  const spawnCalls = [];
  const childProcess = {
    spawn(_command, args) {
      spawnCalls.push(args);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.unref = () => {};
      child.kill = () => {};
      child.killed = false;
      child.pid = 4242;
      if (args[0] === '-version') {
        queueMicrotask(() => {
          child.stderr.emit('data', 'openjdk version "21.0.1"');
          child.emit('close', 0);
        });
      }
      return child;
    },
  };
  const httpsModule = {
    get(_url, _options, callback) {
      const request = new EventEmitter();
      request.setTimeout = () => {};
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = {};
        response.resume = () => {};
        callback(response);
        response.emit('data', JSON.stringify({ versions: [{ id: '1.16.5', url: 'https://fixture.invalid/version.json' }] }));
        response.emit('end');
      });
      return request;
    },
  };
  const sender = { send() {}, isDestroyed: () => false };
  const setTimeout = (callback, delay) => {
    if (delay === 8000) { queueMicrotask(callback); return 0; }
    return global.setTimeout(callback, delay);
  };
  return { childProcess, httpsModule, sender, setTimeout, spawnCalls };
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

test('production preload launches with a valid native JAR and extracts native bytes unchanged', async () => {
  await withTempRoot(async root => {
    const nativeName = process.platform === 'win32' ? 'lwjgl64.dll' : process.platform === 'darwin' ? 'liblwjgl.dylib' : 'liblwjgl.so';
    const nativeSuffix = process.platform === 'win32' ? 'natives-windows' : process.platform === 'darwin' ? 'natives-osx' : 'natives-linux';
    const nativeBytes = Buffer.from([0, 255, 17, 42, 128, 10]);
    const nativeJar = makeZip([
      [nativeName, nativeBytes, { compression: 8 }],
      ['META-INF/MANIFEST.MF', 'fixture manifest', { compression: 8 }],
    ]);
    const archivePath = path.join(root, 'valid-native.jar');
    fs.writeFileSync(archivePath, nativeJar);
    const fixture = prepareNativeLaunch(root, archivePath, nativeSuffix, [nativeName]);
    const deps = launchDependencies();
    const handlers = new Map();
    const { exposed, invocations } = loadProductionIpc(root, handlers, deps);

    const result = await exposed.craftdockInstance.launch({ id: fixture.id, mcVersion: fixture.version });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { success: true, method: 'direct-java', pid: 4242 });
    assert.deepEqual(fs.readFileSync(fixture.nativePath), nativeBytes);
    assert.ok(deps.spawnCalls.some(args => args.includes('net.minecraft.client.main.Main')), 'Java launch follows successful extraction');
    assert.deepEqual(JSON.parse(JSON.stringify(invocations)), [['instance-launch', { id: fixture.id, mcVersion: fixture.version }, null]]);
  });
});

test('production preload validates all native JARs before writing any candidate files', async () => {
  await withTempRoot(async root => {
    const nativeName = process.platform === 'win32' ? 'lwjgl64.dll' : process.platform === 'darwin' ? 'liblwjgl.dylib' : 'liblwjgl.so';
    const nativeSuffix = process.platform === 'win32' ? 'natives-windows' : process.platform === 'darwin' ? 'natives-osx' : 'natives-linux';
    const rejectedNativeName = process.platform === 'win32' ? 'rejected.dll' : process.platform === 'darwin' ? 'rejected.dylib' : 'rejected.so';
    const sentinelName = process.platform === 'win32' ? 'sentinel.dll' : process.platform === 'darwin' ? 'sentinel.dylib' : 'sentinel.so';
    const rejectedArchives = [
      ['oversize', makeZip([[rejectedNativeName, 'small native', { declaredUncompressedSize: 128 * 1024 * 1024 + 1 }]]), /entry exceeds size limit/],
      ['malformed', makeZip([[rejectedNativeName, 'corrupt native', { corruptCrc: true }]]), /corrupt entry/],
    ];
    for (const [label, rejectedBytes, expectedError] of rejectedArchives) {
      for (const hasExistingNative of [true, false]) {
        const validBytes = makeZip([[nativeName, `${label} valid native`, { compression: 8 }]]);
        const validArchivePath = path.join(root, `${label}-valid.jar`);
        const rejectedArchivePath = path.join(root, `${label}-rejected.jar`);
        fs.writeFileSync(validArchivePath, validBytes);
        fs.writeFileSync(rejectedArchivePath, rejectedBytes);
        const fixture = prepareNativeLaunch(root, [validArchivePath, rejectedArchivePath], nativeSuffix, [nativeName, rejectedNativeName, sentinelName]);
        for (const nativePath of fixture.nativePaths) fs.rmSync(nativePath, { force: true });
        const existingCandidateNative = Buffer.from('preserve rejected candidate native');
        const existingSentinelNative = Buffer.from('preserve unrelated native');
        if (hasExistingNative) {
          fs.mkdirSync(path.dirname(fixture.nativePath), { recursive: true });
          fs.writeFileSync(fixture.nativePaths[1], existingCandidateNative);
          fs.writeFileSync(fixture.nativePaths[2], existingSentinelNative);
        }
        const deps = launchDependencies();
        const warnings = [];
        const handlers = new Map();
        const nativeWriteAttempts = [];
        const nativeDeleteAttempts = [];
        let nativeDirectoryChecks = 0;
        const fsOverrides = {
          readdirSync(directory, ...args) {
            if (hasExistingNative && String(directory) === path.dirname(fixture.nativePath) && nativeDirectoryChecks++ === 0) return [];
            return fs.readdirSync(directory, ...args);
          },
          writeFileSync(filePath, ...args) {
            if (fixture.nativePaths.includes(String(filePath))) nativeWriteAttempts.push(String(filePath));
            return fs.writeFileSync(filePath, ...args);
          },
          unlinkSync(filePath) {
            if (fixture.nativePaths.includes(String(filePath))) nativeDeleteAttempts.push(String(filePath));
            return fs.unlinkSync(filePath);
          },
        };
        const { exposed } = loadProductionIpc(root, handlers, {
          ...deps,
          fsOverrides,
          console: { warn: (...parts) => warnings.push(parts.join(' ')) },
        });

        const result = await exposed.craftdockInstance.launch({ id: fixture.id, mcVersion: fixture.version });
        assert.equal(result.success, true, 'the current launch success contract is retained');
        assert.deepEqual(nativeWriteAttempts, [], `${label} candidate archives do not partially write native files`);
        assert.deepEqual(nativeDeleteAttempts, [], `${label} does not delete native targets`);
        assert.equal(fs.existsSync(fixture.nativePaths[0]), false, `${label} valid candidate native is not written`);
        assert.equal(fs.existsSync(fixture.nativePaths[1]), hasExistingNative, `${label} preserves rejected candidate target presence`);
        assert.equal(fs.existsSync(fixture.nativePaths[2]), hasExistingNative, `${label} leaves other native presence unchanged`);
        if (hasExistingNative) {
          assert.deepEqual(fs.readFileSync(fixture.nativePaths[1]), existingCandidateNative, `${label} preserves rejected candidate target bytes`);
          assert.deepEqual(fs.readFileSync(fixture.nativePaths[2]), existingSentinelNative, `${label} preserves other native bytes`);
        }
        assert.equal(deps.spawnCalls.filter(args => args.includes('net.minecraft.client.main.Main')).length, 1);
        assert.ok(warnings.some(parts => expectedError.test(parts)), `${label} is reported through the existing extraction warning`);
      }
    }
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
