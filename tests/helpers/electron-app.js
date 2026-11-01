// Shared harness for exercising the real Electron main process.
//
// `main.js` is a single module that registers every ipcMain handler at load
// time, so tests load it in a vm context with a mocked `electron`, `https`,
// `child_process` and `fetch`, then call the handlers through the real
// preload.js API. `__dirname` points at a temp root, which puts every data
// folder (`craftdock-data/data`, `instances`, `servers`, ...) inside that root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const projectRoot = path.resolve(__dirname, '..', '..');

// Values created inside the vm have a different prototype; compare plain copies.
const plain = value => JSON.parse(JSON.stringify(value));

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimal store-only ZIP writer for modpack / server jar fixtures.
function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name);
    const data = Buffer.from(value);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    localParts.push(local, filename, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, filename);
    localOffset += local.length + filename.length + data.length;
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

// Reads a ZIP produced by `writeZipToFile` (stored entries) back into a map.
function readZip(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data));
    offset = dataStart + compressedSize;
  }
  return entries;
}

async function withTempRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-main-'));
  try {
    await callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function responseFor(route) {
  // A real readable stream: consumers attach 'data'/'end' listeners and pipe it
  // to file streams exactly like an https.IncomingMessage.
  const response = new PassThrough();
  response.headers = {};

  if (route === undefined) {
    response.statusCode = 404;
    response.headers = { 'content-length': '0' };
    return { response, body: Buffer.alloc(0) };
  }
  if (route && typeof route === 'object' && !Buffer.isBuffer(route) && ('status' in route || 'redirect' in route)) {
    response.statusCode = route.status || 302;
    response.headers = { ...(route.headers || {}) };
    if (route.redirect) response.headers.location = route.redirect;
    const bodyValue = route.redirect ? '' : (route.body ?? '');
    const body = Buffer.isBuffer(bodyValue) ? bodyValue : Buffer.from(String(bodyValue));
    return { response, body };
  }
  // `{ chunks, gapMs }` streams the body slowly so a download takes measurable
  // time — that is how throughput sampling gets more than one reading.
  if (route && typeof route === 'object' && !Buffer.isBuffer(route) && Array.isArray(route.chunks)) {
    const chunks = route.chunks.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const body = Buffer.concat(chunks);
    response.statusCode = 200;
    response.headers = { 'content-length': String(body.length) };
    return { response, body, chunks, gapMs: Number(route.gapMs) || 0 };
  }
  const body = Buffer.isBuffer(route)
    ? route
    : Buffer.from(typeof route === 'string' ? route : JSON.stringify(route));
  response.statusCode = 200;
  response.headers = { 'content-length': String(body.length) };
  return { response, body };
}

// Serves JSON and file bodies for `https.get`/`https.request` consumers.
// Keys are full request URLs (https://host/path).
function createNetworkMock(routes = {}) {
  const requested = [];
  const urlOf = (urlOrOptions, maybeOptions) => {
    if (typeof urlOrOptions === 'string') return urlOrOptions;
    const host = urlOrOptions.hostname || urlOrOptions.host || 'unknown.invalid';
    const requestPath = urlOrOptions.path || '/';
    return `https://${host}${requestPath}`;
  };
  const get = (urlOrOptions, maybeOptions, maybeCallback) => {
    const callback = typeof maybeOptions === 'function' ? maybeOptions : maybeCallback;
    const url = urlOf(urlOrOptions, maybeOptions);
    requested.push(url);
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.write = () => request;
    request.end = () => request;
    request.destroy = error => { if (error) request.emit('error', error); };
    queueMicrotask(() => {
      const { response, body, chunks, gapMs } = responseFor(routes[url]);
      if (callback) callback(response);
      if (chunks) {
        // Real timers, so the download spans several throughput sample windows.
        chunks.forEach((chunk, index) => {
          const write = () => {
            if (!response.destroyed) response.write(chunk);
            if (index === chunks.length - 1 && !response.destroyed) response.end();
          };
          if (index === 0) write();
          else setTimeout(write, gapMs * index);
        });
        return;
      }
      if (body.length) response.write(body);
      response.end();
    });
    return request;
  };
  return {
    requested,
    module: {
      get,
      request: (options, callback) => get(options, callback),
      Agent: class Agent { constructor() {} },
    },
  };
}

function createChildProcessMock(options = {}) {
  const calls = [];
  const children = [];
  const kills = [];
  const writes = [];
  const spawn = (command, args = [], spawnOptions = {}) => {
    calls.push({ command, args, options: spawnOptions });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = { write: text => writes.push([command, args.join(' '), String(text)]), end() {} };
    child.pid = 4000 + children.length;
    child.killed = false;
    child.unref = () => {};
    child.kill = signal => {
      child.killed = true;
      kills.push({ pid: child.pid, signal });
    };
    children.push(child);

    if ((args[0] || '') === '-version' || (args[0] || '').endsWith('-version')) {
      // `javaVersion(command)` maps a probed executable to a major version; 0
      // means "this path is not a usable Java".
      const major = typeof options.javaVersion === 'function' ? options.javaVersion(command) : undefined;
      queueMicrotask(() => {
        if (major === 0) { child.emit('close', 1); return; }
        const label = major === 8 ? '1.8.0_402' : major ? `${major}.0.1` : '21.0.1';
        child.stderr.write(`openjdk version "${label}" 2023-10-17\n`);
        child.emit('close', 0);
      });
    } else if (options.onSpawn) {
      options.onSpawn({ command, args, child, spawnOptions });
    }
    return child;
  };
  return {
    module: {
      spawn,
      execSync: command => {
        calls.push({ execSync: command });
        return options.execSync ? options.execSync(command) : '';
      },
      execFileSync: (...args) => {
        calls.push({ execFileSync: args });
        return options.execFileSync ? options.execFileSync(...args) : '';
      },
      execFile: (file, args = [], execOptions, callback) => {
        const done = typeof execOptions === 'function' ? execOptions : callback;
        calls.push({ execFile: [file, args, execOptions] });
        queueMicrotask(() => {
          try {
            const output = options.execFileSync ? options.execFileSync(file, args, execOptions) : '';
            done(null, output == null ? '' : String(output), '');
          } catch (error) {
            done(error, '', '');
          }
        });
      },
    },
    calls,
    children,
    kills,
    writes,
  };
}

function loadPreload(handlers, invocations, sender) {
  const exposed = {};
  const electronPreload = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      invoke: (channel, ...args) => {
        invocations.push([channel, ...args]);
        const handler = handlers.get(channel);
        assert.ok(handler, `No main handler registered for ${channel}`);
        return Promise.resolve(handler({ sender }, ...args));
      },
      send() {},
      on() {},
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf8'), {
    require: name => name === 'electron' ? electronPreload : require(name),
  }, { filename: 'preload.js' });
  return exposed;
}

// Loads the production main process into an isolated data root.
//
// options:
//   routes        URL → JSON/file body for https/http (see createNetworkMock)
//   fetch         replacement fetch (records every call)
//   onSpawn       hook after a non `-version` spawn
//   javaVersion   (command) => major version reported by `java -version`
//   execSync      (command) => output for child_process.execSync
//   execFileSync  (...args) => performs the (extraction) step a real command would
//   savePath      string or (defaultPath) => string for dialog.showSaveDialog
//   openPaths     string[] returned by dialog.showOpenDialog
//   fsOverrides   overrides for the fs module
//   env           extra environment variables
//   platform      override process.platform (defaults to the host)
function loadApp(root, options = {}) {
  const handlers = new Map();
  const invocations = [];
  const events = [];
  const logs = [];
  const fetchCalls = [];
  const dialogs = [];

  const network = createNetworkMock(options.routes);
  const children = createChildProcessMock({
    onSpawn: options.onSpawn,
    execSync: options.execSync,
    execFileSync: options.execFileSync,
    javaVersion: options.javaVersion,
  });
  const sender = {
    send: (...args) => events.push(args),
    isDestroyed: () => false,
  };

  const electronMain = {
    app: {
      isPackaged: false,
      setName() {},
      setAppUserModelId() {},
      getPath: () => root,
      whenReady: () => ({ then() {} }),
      on() {},
      quit() {},
    },
    BrowserWindow: class BrowserWindow { constructor() {} },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    dialog: {
      async showSaveDialog(_window, request) {
        dialogs.push(['save', request]);
        const resolved = typeof options.savePath === 'function'
          ? options.savePath(request?.defaultPath)
          : options.savePath;
        return resolved ? { canceled: false, filePath: resolved } : { canceled: true, filePath: null };
      },
      async showOpenDialog() {
        const filePaths = options.openPaths || [];
        return { canceled: filePaths.length === 0, filePaths };
      },
    },
    shell: { openPath: () => '', openExternal: async () => true },
    Tray: class Tray { setToolTip() {} setContextMenu() {} on() {} destroy() {} },
    Menu: { buildFromTemplate: () => ({}) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  };

  const mainFs = Object.keys(options.fsOverrides || {}).length
    ? Object.assign(Object.create(fs), options.fsOverrides)
    : fs;

  const moduleOverrides = {
    electron: electronMain,
    https: network.module,
    http: network.module,
    child_process: children.module,
    fs: mainFs,
  };

  const sandboxProcess = {
    ...process,
    env: { ...process.env, CF_API_KEY: 'test-cf-key', ...(options.env || {}) },
    platform: options.platform || process.platform,
    resourcesPath: path.join(root, 'resources'),
    loadEnvFile: undefined,
  };

  const fetchMock = (...args) => {
    fetchCalls.push(args);
    if (!options.fetch) return Promise.reject(new Error(`Unexpected fetch: ${args[0]}`));
    return options.fetch(...args);
  };

  const sandbox = {
    Buffer,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    AbortController,
    fetch: fetchMock,
    queueMicrotask,
    clearInterval: () => {},
    setInterval: () => 0,
    clearTimeout: handle => global.clearTimeout(handle),
    setTimeout: (callback, delay) => {
      if (delay === 8000) { queueMicrotask(callback); return 0; }
      const handle = global.setTimeout(callback, Math.min(Number(delay) || 0, 50));
      handle.unref?.();
      return handle;
    },
    module: { exports: {} },
    __dirname: root,
    process: sandboxProcess,
    console: {
      log: (...args) => logs.push(['log', args]),
      warn: (...args) => logs.push(['warn', args]),
      error: (...args) => logs.push(['error', args]),
    },
    // Relative requires resolve against the project root, as they would for main.js.
    require: name => {
      if (name in moduleOverrides) return moduleOverrides[name];
      return name.startsWith('.') ? require(path.resolve(projectRoot, name)) : require(name);
    },
  };

  vm.runInNewContext(fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8'), sandbox, { filename: 'main.js' });

  return {
    exposed: loadPreload(handlers, invocations, sender),
    handlers,
    invocations,
    events,
    logs,
    fetchCalls,
    dialogs,
    network,
    spawnCalls: children.calls,
    children: children.children,
    kills: children.kills,
    stdinWrites: children.writes,
    dataRoot: path.join(root, 'craftdock-data'),
    dataDir: path.join(root, 'craftdock-data', 'data'),
    instancesDir: path.join(root, 'craftdock-data', 'instances'),
    serversDir: path.join(root, 'craftdock-data', 'servers'),
    sharedWorldsDir: path.join(root, 'craftdock-data', 'shared-worlds'),
    sharedServersDir: path.join(root, 'craftdock-data', 'shared-servers'),
    sharedResourcesDir: path.join(root, 'craftdock-data', 'shared-resources'),
    sharedShadersDir: path.join(root, 'craftdock-data', 'shared-shaders'),
  };
}

// Creates the cached client metadata an instance launch needs, so a launch
// never has to download a client jar or asset objects.
function prepareClientCache(root, mcVersion = '1.16.5') {
  const versionDir = path.join(root, 'craftdock-data', 'client-cache', mcVersion);
  const assetsDir = path.join(root, 'craftdock-data', 'client-cache', 'assets');
  fs.mkdirSync(versionDir, { recursive: true });
  fs.mkdirSync(path.join(assetsDir, 'indexes'), { recursive: true });
  fs.writeFileSync(path.join(versionDir, 'version.json'), JSON.stringify({
    mainClass: 'net.minecraft.client.main.Main',
    downloads: { client: { url: `https://fixture.invalid/${mcVersion}-client.jar` } },
    libraries: [],
    assetIndex: { id: 'fixture', url: 'https://fixture.invalid/asset-index.json' },
  }));
  fs.writeFileSync(path.join(versionDir, `minecraft-${mcVersion}-client.jar`), 'cached client jar');
  fs.writeFileSync(path.join(assetsDir, 'indexes', 'fixture.json'), JSON.stringify({ objects: {} }));
  return { versionDir };
}

function writeInstance(app, id, meta = {}) {
  const dir = path.join(app.instancesDir, id);
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify({ id, mcVersion: '1.16.5', ...meta }));
  return dir;
}

module.exports = {
  assert,
  plain,
  makeZip,
  readZip,
  withTempRoot,
  createNetworkMock,
  loadApp,
  prepareClientCache,
  writeInstance,
  projectRoot,
};
