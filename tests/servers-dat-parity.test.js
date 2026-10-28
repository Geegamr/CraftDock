const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { before, test } = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(__dirname, 'fixtures', 'servers-dat');
const binaryName = process.platform === 'win32'
  ? 'craftdock-servers-dat.exe'
  : 'craftdock-servers-dat';
const binaryPath = path.join(projectRoot, 'rust', 'target', 'debug', binaryName);
let readServersDatFallback;
let readServersDat;

before(() => {
  const build = spawnSync('cargo', [
    'build', '--manifest-path', 'rust/Cargo.toml', '--locked',
  ], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(build.status, 0, `Rust parser build failed:\n${build.stderr}`);
  assert.ok(fs.existsSync(binaryPath), `Rust parser executable not found: ${binaryPath}`);

  // Evaluate the actual production fallback functions without loading Electron's
  // app startup path. Marker checks make source movement fail loudly in tests.
  const source = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const startMarker = '// ── Minimal NBT parser (for servers.dat) ───────────────────';
  const endMarker = '// Uses AES-256-GCM with a per-install random key stored next to the data.';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'Could not locate the production servers.dat fallback in main.js');
  const productionParser = source.slice(start, end)
    + '\nglobalThis.readServersDatFallback = readServersDatFallback;'
    + '\nglobalThis.readServersDat = readServersDat;';
  const context = vm.createContext({
    Buffer,
    app: { isPackaged: false },
    console: { warn() {} },
    fs,
    path,
    process: { platform: process.platform },
    require,
    __dirname: projectRoot,
    zlib: require('node:zlib'),
  });
  new vm.Script(productionParser, { filename: 'main.js servers.dat parser' }).runInContext(context);
  readServersDatFallback = context.readServersDatFallback;
  readServersDat = context.readServersDat;
});

test('renderer servers.dat request stays on the existing IPC contract', () => {
  const main = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');

  assert.match(main, /ipcMain\.handle\('instance-read-servers-dat', async \(_, instId\) => \{\s*const gameDir = instDir\(instId\);\s*return await readServersDat\(gameDir\);\s*\}\);/);
  assert.match(preload, /readServersDat:\s*\(id\)\s*=> ipcRenderer\.invoke\('instance-read-servers-dat', id\)/);
  assert.match(renderer, /window\.craftdockInstance\.readServersDat\(inst\.id\)/);
  for (const field of ['name', 'ip', 'icon', 'hidden']) {
    assert.ok(renderer.includes(`srv.${field}`), `Renderer no longer consumes ${field}`);
  }
});

const cases = [
  {
    file: 'raw-full.nbt',
    expected: [{
      name: 'Example Server',
      ip: 'play.example.test:25565',
      icon: 'data:image/png;base64,AAH/',
      hidden: true,
    }],
  },
  {
    file: 'gzip-full.nbt.gz',
    expected: [{
      name: 'Example Server',
      ip: 'play.example.test:25565',
      icon: 'data:image/png;base64,AAH/',
      hidden: true,
    }],
  },
  {
    file: 'raw-defaults.nbt',
    expected: [{ name: 'Minecraft Server', ip: '', icon: null, hidden: false }],
  },
  {
    file: 'gzip-defaults.nbt.gz',
    expected: [{ name: 'Minecraft Server', ip: '', icon: null, hidden: false }],
  },
  { file: 'raw-missing-list.nbt', expected: [] },
];

for (const { file, expected } of cases) {
  test(`Rust and JavaScript results match for ${file}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-servers-parity-'));
    const input = path.join(dir, 'servers.dat');
    try {
      fs.copyFileSync(path.join(fixtureRoot, file), input);
      const rust = spawnSync(binaryPath, [input], { encoding: 'utf8' });
      assert.equal(rust.status, 0, `Rust parser failed for ${file}: ${rust.stderr}`);
      const rustResult = JSON.parse(rust.stdout);
      const jsResult = JSON.parse(JSON.stringify(await readServersDatFallback(dir)));
      const ipcResult = JSON.parse(JSON.stringify(await readServersDat(dir)));
      assert.deepEqual(jsResult, rustResult, 'Rust and production fallback results differ');
      assert.deepEqual(ipcResult, rustResult, 'Production IPC helper result differs from Rust output');
      assert.deepEqual(rustResult, expected, 'Renderer-facing result or default behavior changed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const file of [
  'malformed-invalid-root.nbt',
  'malformed-truncated.nbt',
  'malformed-gzip.nbt.gz',
]) {
  test(`malformed input falls back to the same empty IPC result: ${file}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-servers-parity-'));
    const input = path.join(dir, 'servers.dat');
    try {
      fs.copyFileSync(path.join(fixtureRoot, file), input);
      const rust = spawnSync(binaryPath, [input], { encoding: 'utf8' });
      assert.notEqual(rust.status, 0, `Rust parser unexpectedly accepted ${file}`);
      const jsResult = JSON.parse(JSON.stringify(await readServersDatFallback(dir)));
      const ipcResult = JSON.parse(JSON.stringify(await readServersDat(dir)));
      assert.deepEqual(jsResult, [], 'Malformed input must retain the current empty-list fallback behavior');
      assert.deepEqual(ipcResult, jsResult, 'Production parser wrapper must fall back after Rust rejects malformed input');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
