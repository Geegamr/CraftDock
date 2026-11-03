const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { createScreenshotListReader, listScreenshotsFallback } = require('../screenshot-list');

const projectRoot = path.resolve(__dirname, '..');
const binaryName = process.platform === 'win32' ? 'craftdock-screenshot-list.exe' : 'craftdock-screenshot-list';
const binaryPath = path.join(projectRoot, 'rust', 'target', 'debug', binaryName);
const silentLogger = { warn() {} };

async function withTempRoot(callback, parent = os.tmpdir()) {
  const root = fs.mkdtempSync(path.join(parent, 'craftdock-screenshots-'));
  try { await callback(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function populateScreenshots(directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, contents, mtime] of [
    ['old.PNG', 'old png', 1_000_000_000],
    ['middle.JpG', 'middle jpeg', 1_100_000_000],
    ['newest.jPeG', 'new jpeg', 1_200_000_000],
    ['ignore.txt', 'not an image', 1_300_000_000],
  ]) {
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, contents);
    fs.utimesSync(filePath, mtime, mtime);
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

test('Rust screenshot scanner matches JavaScript on shared input and preserves ordering and fields', async () => {
  const build = spawnSync('cargo', ['build', '--manifest-path', 'rust/Cargo.toml', '--locked', '--bin', 'craftdock-screenshot-list'], {
    cwd: projectRoot, encoding: 'utf8',
  });
  assert.equal(build.status, 0, `Rust screenshot scanner build failed:\n${build.stderr}`);
  assert.ok(fs.existsSync(binaryPath), `Rust scanner executable not found: ${binaryPath}`);

  await withTempRoot(root => {
    const directory = path.join(root, 'screenshots');
    populateScreenshots(directory);
    const expected = listScreenshotsFallback(directory);
    const native = spawnSync(binaryPath, [directory], { encoding: 'utf8' });
    assert.equal(native.status, 0, `Rust screenshot scanner failed: ${native.stderr}`);
    const actual = JSON.parse(native.stdout);
    assert.deepEqual(actual.map(({ name, path: filePath, size }) => ({ name, path: filePath, size })),
      expected.map(({ name, path: filePath, size }) => ({ name, path: filePath, size })));
    assert.deepEqual(actual.map(file => file.name), ['newest.jPeG', 'middle.JpG', 'old.PNG']);
    assert.ok(actual.every(file => path.isAbsolute(file.path)));
    assert.deepEqual(actual.map(file => Object.keys(file).sort()), actual.map(() => ['mtime', 'name', 'path', 'size']));
    for (const [actualFile, expectedFile] of actual.map(file => [file, expected.find(item => item.name === file.name)])) {
      assert.ok(Math.abs(actualFile.mtime - expectedFile.mtime) < 2, `${actualFile.name} mtime differs`);
    }
  });
});

test('JavaScript fallback returns absolute normalized paths for relative directories', async () => {
  await withTempRoot(async root => {
    const directory = path.join(root, 'screenshots');
    populateScreenshots(directory);
    const relativeDirectory = path.relative(process.cwd(), directory);
    assert.equal(path.isAbsolute(relativeDirectory), false);
    const fallback = listScreenshotsFallback(relativeDirectory);
    const native = spawnSync(binaryPath, [directory], { encoding: 'utf8' });
    assert.equal(native.status, 0, `Rust screenshot scanner failed: ${native.stderr}`);
    const nativeFiles = JSON.parse(native.stdout);

    assert.ok(fallback.every(file => path.isAbsolute(file.path)));
    assert.deepEqual(fallback.map(file => file.path), nativeFiles.map(file => file.path));
  }, process.cwd());
});

test('JavaScript fallback returns an empty list when reading a directory fails', () => {
  const originalReadDirectory = fs.readdirSync;
  try {
    fs.readdirSync = () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); };
    assert.deepEqual(listScreenshotsFallback(path.resolve('unreadable-screenshots')), []);
  } finally {
    fs.readdirSync = originalReadDirectory;
  }
});

test('native scanner failure for an unreadable directory falls back to an empty list', async () => {
  await withTempRoot(async root => {
    const directory = path.join(root, 'screenshots');
    fs.mkdirSync(directory);
    const native = path.join(root, 'native', binaryName);
    fs.mkdirSync(path.dirname(native));
    fs.writeFileSync(native, 'stub');
    const originalReadDirectory = fs.readdirSync;
    try {
      fs.readdirSync = (target, ...args) => {
        if (path.resolve(String(target)) === path.resolve(directory)) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return originalReadDirectory.call(fs, target, ...args);
      };
      const reader = createScreenshotListReader({
        isPackaged: true, appDir: root, resourcesPath: root,
        platform: process.platform, logger: silentLogger,
        runFile: (binary, args, options, callback) => callback(new Error('permission denied')),
      });
      assert.deepEqual(await reader(directory), []);
    } finally {
      fs.readdirSync = originalReadDirectory;
    }
  });
});

test('reader resolves development and packaged binaries and falls back when absent or broken', async () => {
  await withTempRoot(async root => {
    const directory = path.join(root, 'screenshots');
    populateScreenshots(directory);
    const expected = listScreenshotsFallback(directory);
    const devRelease = path.join(root, 'rust', 'target', 'release', binaryName);
    const devDebug = path.join(root, 'rust', 'target', 'debug', binaryName);
    const packaged = path.join(root, 'resources', 'native', binaryName);
    for (const file of [devRelease, devDebug, packaged]) fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const file of [devRelease, devDebug, packaged]) fs.writeFileSync(file, 'stub');
    const calls = [];
    const reader = (isPackaged, runFile) => createScreenshotListReader({
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
    assert.deepEqual(await createScreenshotListReader({
      isPackaged: false, appDir: path.join(root, 'no-dev-binaries'),
      resourcesPath: path.join(root, 'no-resources'), platform: process.platform, logger: silentLogger,
    })(directory), expected);
    assert.deepEqual(await reader(true, undefined)(path.join(root, 'missing')), []);
  });
});

test('production preload reaches screenshot-list and screenshot-read handlers with usable paths', async () => {
  await withTempRoot(async root => {
    const instanceId = 'gallery-fixture';
    const screenshotDir = path.join(root, 'craftdock-data', 'instances', instanceId, 'screenshots');
    populateScreenshots(screenshotDir);
    const expected = listScreenshotsFallback(screenshotDir);
    const handlers = new Map();
    const exposed = loadProductionIpc(root, handlers);
    const files = await exposed.craftdockInstance.listScreenshots(instanceId);
    assert.deepEqual(JSON.parse(JSON.stringify(files)), expected);
    const result = await exposed.craftdockInstance.readScreenshot(files[0].path);
    assert.equal(result.success, true);
    assert.match(result.dataUrl, /^data:image\/jpeg;base64,/);
    assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdockInstance.listScreenshots('missing'))), []);
  });
});
