const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { test } = require('node:test');
const {
  createModpackMetadataReader,
  parseModpackMetadataFallback,
} = require('../modpack-metadata');

const projectRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(__dirname, 'fixtures', 'modpack-metadata');
const binaryName = process.platform === 'win32' ? 'craftdock-modpack-metadata.exe' : 'craftdock-modpack-metadata';
const binaryPath = path.join(projectRoot, 'rust', 'target', 'debug', binaryName);
const packageConfig = require('../package.json');

async function withTempRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-modpack-metadata-'));
  try { await callback(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function readFixtureEntries(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0; index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  assert.notEqual(eocd, -1, 'fixture ZIP contains EOCD');
  const count = buffer.readUInt16LE(eocd + 10);
  let position = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(position), 0x02014b50, 'fixture has a central directory entry');
    const method = buffer.readUInt16LE(position + 10);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    const name = buffer.toString('utf8', position + 46, position + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(compressed));
    else if (method === 8) entries.set(name, zlib.inflateRawSync(compressed));
    else throw new Error(`Unsupported fixture ZIP method ${method}`);
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function buildRustBinary() {
  const result = spawnSync('cargo', [
    'build', '--manifest-path', 'rust/Cargo.toml', '--offline', '--bin', 'craftdock-modpack-metadata',
  ], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, `Rust modpack metadata build failed:\n${result.stderr}`);
  assert.ok(fs.existsSync(binaryPath), `Rust executable not found: ${binaryPath}`);
}

function createReader(root, packaged = false, runNative) {
  return createModpackMetadataReader({
    isPackaged: packaged,
    appDir: root,
    resourcesPath: path.join(root, 'resources'),
    platform: process.platform,
    runNative,
  });
}

function loadProductionIpc(tempRoot, handlers, modpackMetadataModule) {
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
    if (name === './modpack-metadata') return modpackMetadataModule;
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

function instanceDirectories(root) {
  const directory = path.join(root, 'craftdock-data', 'instances');
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

test('real Rust parser matches JS metadata for both formats, defaults, and unknown loader IDs', () => {
  buildRustBinary();
  const cases = [
    ['modrinth-full.mrpack', 'mr'],
    ['modrinth-defaults.mrpack', 'mr'],
    ['curseforge-full.zip', 'cf'],
    ['curseforge-unknown-loader.zip', 'cf'],
    ['curseforge-defaults.zip', 'cf'],
  ];
  for (const [name, type] of cases) {
    const archive = path.join(fixtureRoot, name);
    const result = spawnSync(binaryPath, ['inspect', archive, type], { encoding: 'utf8' });
    assert.equal(result.status, 0, `Rust parser failed for ${name}: ${result.stderr}`);
    const rust = JSON.parse(result.stdout);
    const js = parseModpackMetadataFallback(archive, type, readFixtureEntries(archive));
    assert.deepEqual(rust, js, `${name} has identical normalized metadata`);
  }
  const modrinth = JSON.parse(spawnSync(binaryPath, ['inspect', path.join(fixtureRoot, 'modrinth-full.mrpack'), 'mr'], { encoding: 'utf8' }).stdout);
  assert.equal(modrinth.loader, 'fabric-loader');
  assert.equal(modrinth.mcVersion, '1.20.1');
  assert.deepEqual(modrinth.mods, [{ url: 'https://cdn.example/mod.jar', path: 'mods/example.jar', sha512: 'abc123' }]);
  const curseforge = JSON.parse(spawnSync(binaryPath, ['inspect', path.join(fixtureRoot, 'curseforge-unknown-loader.zip'), 'cf'], { encoding: 'utf8' }).stdout);
  assert.equal(curseforge.loader, '');
  assert.equal(curseforge.mcVersion, '1.21.4');
  assert.deepEqual(curseforge.mods, [{ projectId: 1, fileId: 2, required: true }]);
});

test('Rust rejects missing or malformed manifests and import leaves no instance directories', async () => {
  buildRustBinary();
  for (const [name, type] of [
    ['modrinth-missing.mrpack', 'mr'], ['modrinth-malformed.mrpack', 'mr'],
    ['curseforge-missing.zip', 'cf'], ['curseforge-malformed.zip', 'cf'],
  ]) {
    const result = spawnSync(binaryPath, ['inspect', path.join(fixtureRoot, name), type], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${name} is rejected by Rust`);
    assert.match(result.stderr, /Could not parse modpack metadata/);
  }
  await withTempRoot(async root => {
    const modpackModule = require('../modpack-metadata');
    const handlers = new Map();
    const { exposed } = loadProductionIpc(root, handlers, modpackModule);
    for (const [name, type] of [
      ['modrinth-missing.mrpack', 'mr'], ['modrinth-malformed.mrpack', 'mr'],
      ['curseforge-missing.zip', 'cf'], ['curseforge-malformed.zip', 'cf'],
    ]) {
      const result = await exposed.craftdockInstance.importPack(path.join(fixtureRoot, name), type);
      assert.equal(result.success, false, `${name} is rejected`);
      assert.ok(result.error);
      assert.deepEqual(instanceDirectories(root), [], 'invalid manifest leaves no instance directories');
    }
  });
});

test('preload-to-handler import runs the real Rust binary and preserves IPC metadata and override behavior', async () => {
  buildRustBinary();
  await withTempRoot(async root => {
    const binary = path.join(root, 'rust', 'target', 'debug', binaryName);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.copyFileSync(binaryPath, binary);
    const actualModule = require('../modpack-metadata');
    const nativeCalls = [];
    const instrumentedModule = {
      ...actualModule,
      createModpackMetadataReader: options => actualModule.createModpackMetadataReader({
        ...options,
        runNative: async (nativeBinary, args) => {
          nativeCalls.push([nativeBinary, args]);
          return actualModule.runRustBinary(nativeBinary, args);
        },
      }),
    };
    const handlers = new Map();
    const { exposed, invocations } = loadProductionIpc(root, handlers, instrumentedModule);
    const archive = path.join(fixtureRoot, 'modrinth-full.mrpack');
    const result = await exposed.craftdockInstance.importPack(archive, 'mr');
    assert.equal(result.success, true);
    assert.equal(result.name, 'Cobblemon Adventures 🌍');
    assert.equal(result.mcVersion, '1.20.1');
    assert.equal(result.loader, 'fabric-loader');
    assert.equal(result.modCount, 1);
    assert.match(result.id, /^inst_\d+$/);
    assert.deepEqual(JSON.parse(JSON.stringify(invocations)), [['instance-import-pack', archive, 'mr']]);
    assert.deepEqual(nativeCalls, [[binary, ['inspect', archive, 'mr']]], 'production import invokes the copied Rust binary');
    const instanceDir = path.join(root, 'craftdock-data', 'instances', result.id);
    const metadata = JSON.parse(fs.readFileSync(path.join(instanceDir, 'instance.json'), 'utf8'));
    assert.deepEqual(metadata._pendingMods, [], 'Modrinth download records keep the current import metadata shape');
    assert.equal(fs.readFileSync(path.join(instanceDir, 'config', 'options.txt'), 'utf8'), 'not parsed by Rust');
  });
});

test('preload-to-handler import uses JS fallback when no Rust executable is available', async () => {
  await withTempRoot(async root => {
    const handlers = new Map();
    const { exposed } = loadProductionIpc(root, handlers, require('../modpack-metadata'));
    const archive = path.join(fixtureRoot, 'curseforge-full.zip');
    const result = await exposed.craftdockInstance.importPack(archive, 'cf');
    assert.equal(result.success, true);
    assert.equal(result.name, 'Forge Pack');
    assert.equal(result.mcVersion, '1.19.4');
    assert.equal(result.loader, 'forge');
    assert.equal(result.modCount, 2);
    const instanceDir = path.join(root, 'craftdock-data', 'instances', result.id);
    const metadata = JSON.parse(fs.readFileSync(path.join(instanceDir, 'instance.json'), 'utf8'));
    assert.deepEqual(metadata._pendingMods, [
      { projectId: 11, fileId: 22, required: false },
      { projectId: 33, fileId: 44, required: true },
    ]);
    assert.equal(fs.readFileSync(path.join(instanceDir, 'config', 'server.properties'), 'utf8'), 'motd=fixture');
  });
});

test('failed metadata persistence removes a newly created instance directory', async () => {
  await withTempRoot(async root => {
    const handlers = new Map();
    const { exposed } = loadProductionIpc(root, handlers, require('../modpack-metadata'));
    const originalWriteFileSync = fs.writeFileSync;
    let injected = false;
    fs.writeFileSync = function (filePath, ...args) {
      if (!injected && String(filePath).includes(`${path.sep}instances${path.sep}`) && String(filePath).endsWith(`${path.sep}instance.json`)) {
        injected = true;
        throw new Error('injected metadata persistence failure');
      }
      return originalWriteFileSync.call(this, filePath, ...args);
    };
    let result;
    try {
      result = await exposed.craftdockInstance.importPack(path.join(fixtureRoot, 'modrinth-full.mrpack'), 'mr');
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }
    assert.equal(injected, true);
    assert.equal(result.success, false);
    assert.match(result.error, /injected metadata persistence failure/);
    assert.deepEqual(instanceDirectories(root), [], 'failed import removes partially created instance directory');
  });
});

test('resolver and Electron packaging include dev, packaged, and fallback execution paths', async () => {
  buildRustBinary();
  await withTempRoot(async root => {
    const archive = path.join(fixtureRoot, 'modrinth-full.mrpack');
    const entries = readFixtureEntries(archive);
    const devRelease = path.join(root, 'rust', 'target', 'release', binaryName);
    const devDebug = path.join(root, 'rust', 'target', 'debug', binaryName);
    const packaged = path.join(root, 'resources', 'native', binaryName);
    for (const candidate of [devRelease, devDebug, packaged]) {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.copyFileSync(binaryPath, candidate);
    }
    const reader = createReader(root, false);
    assert.deepEqual(await reader(archive, 'mr', entries), parseModpackMetadataFallback(archive, 'mr', entries));
    fs.rmSync(devRelease);
    assert.deepEqual(await reader(archive, 'mr', entries), parseModpackMetadataFallback(archive, 'mr', entries));
    assert.deepEqual(await createReader(root, true)(archive, 'mr', entries), parseModpackMetadataFallback(archive, 'mr', entries));

    const fallback = createModpackMetadataReader({
      isPackaged: false, appDir: root, resourcesPath: path.join(root, 'none'), platform: process.platform,
      runNative: async () => { throw new Error('simulated native failure'); },
    });
    assert.deepEqual(await fallback(archive, 'mr', entries), parseModpackMetadataFallback(archive, 'mr', entries));

    const resourceFilter = packageConfig.build.extraResources[0].filter;
    assert.ok(resourceFilter.includes('craftdock-modpack-metadata'));
    assert.ok(resourceFilter.includes('craftdock-modpack-metadata.exe'));
    assert.ok(packageConfig.build.files.includes('modpack-metadata.js'));
  });
});
