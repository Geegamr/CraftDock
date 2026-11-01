const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { before, test } = require('node:test');
const { createServersDatReader } = require('../servers-dat');

const projectRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(__dirname, 'fixtures', 'servers-dat');
const binaryName = process.platform === 'win32' ? 'craftdock-servers-dat.exe' : 'craftdock-servers-dat';
const binaryPath = path.join(projectRoot, 'rust', 'target', 'debug', binaryName);
const silentLogger = { warn() {} };
const readServersDat = createServersDatReader({
  isPackaged: false,
  appDir: projectRoot,
  resourcesPath: projectRoot,
  platform: process.platform,
  logger: silentLogger,
});

before(() => {
  const build = spawnSync('cargo', ['build', '--manifest-path', 'rust/Cargo.toml', '--locked'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, `Rust parser build failed:\n${build.stderr}`);
  assert.ok(fs.existsSync(binaryPath), `Rust parser executable not found: ${binaryPath}`);
});

test('preload invocation reaches the production main servers.dat handler', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-ipc-contract-'));
  const instanceId = 'ipc-fixture';
  const expected = [{ name: 'Example Server', ip: 'play.example.test:25565', icon: 'data:image/png;base64,AAH/', hidden: true }];
  const handlers = new Map();
  const exposed = {};
  const invocations = [];
  const app = {
    isPackaged: false,
    setAppUserModelId() {}, setName() {}, on() {},
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
    if (name === './browse-cache') return require('../browse-cache');
    if (name === './package.json') return require('../package.json');
    return require(name);
  };

  try {
    const gameDir = path.join(tempRoot, 'craftdock-data', 'instances', instanceId);
    fs.mkdirSync(gameDir, { recursive: true });
    fs.copyFileSync(path.join(fixtureRoot, 'raw-full.nbt'), path.join(gameDir, 'servers.dat'));
    vm.runInNewContext(fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8'), {
      Buffer, __dirname: tempRoot, console: { log() {}, warn() {} }, fetch,
      module: { exports: {} }, process: { ...process, resourcesPath: path.join(tempRoot, 'resources') },
      require: mockMainRequire, setInterval: () => 0, clearInterval() {},
    }, { filename: 'main.js' });

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

    assert.deepEqual(await exposed.craftdockInstance.readServersDat(instanceId), expected);
    assert.deepEqual(invocations, [['instance-read-servers-dat', instanceId]]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

const full = [{ name: 'Example Server', ip: 'play.example.test:25565', icon: 'data:image/png;base64,AAH/', hidden: true }];
const defaults = [{ name: 'Minecraft Server', ip: '', icon: null, hidden: false }];
const unicode = [{ name: '社区 Server 🌍', ip: '例え.テスト:25565', icon: 'data:image/png;base64,AAH/', hidden: false }];
const cases = [
  ['raw-full.nbt', full], ['gzip-full.nbt.gz', full],
  ['raw-defaults.nbt', defaults], ['gzip-defaults.nbt.gz', defaults],
  ['format-tags-unicode.nbt', unicode], ['format-tags-unicode.nbt.gz', unicode],
  ['raw-missing-list.nbt', []],
  ['malformed-invalid-root.nbt', [], true],
  ['malformed-truncated.nbt', [], true],
  ['malformed-gzip.nbt.gz', [], true],
];

for (const [file, expected, malformed = false] of cases) {
  test(`${malformed ? 'rejects and falls back for' : 'parses'} ${file}`, async () => {
    const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-servers-parity-'));
    try {
      fs.copyFileSync(path.join(fixtureRoot, file), path.join(gameDir, 'servers.dat'));
      const input = path.join(gameDir, 'servers.dat');
      const rust = spawnSync(binaryPath, [input], { encoding: 'utf8' });
      const fallbackReader = createServersDatReader({
        isPackaged: false, appDir: gameDir, resourcesPath: gameDir,
        platform: process.platform, logger: silentLogger,
      });
      const [fallback, reader] = await Promise.all([
        fallbackReader(gameDir),
        readServersDat(gameDir),
      ]);

      if (malformed) assert.notEqual(rust.status, 0, 'Rust parser unexpectedly accepted malformed input');
      else {
        assert.equal(rust.status, 0, `Rust parser failed: ${rust.stderr}`);
        assert.deepEqual(JSON.parse(rust.stdout), expected);
      }
      assert.deepEqual(fallback, expected);
      assert.deepEqual(reader, expected);
    } finally {
      fs.rmSync(gameDir, { recursive: true, force: true });
    }
  });
}
