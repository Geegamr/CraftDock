// The native servers.dat parser must reject a small file that declares far more
// entries than its own bytes can carry, and the JavaScript wrapper must surface
// that rejection instead of re-parsing the same bytes in its slower fallback
// (which allocates hundreds of times the file size). These tests drive the real
// Rust binary and the real IPC handler, not a mocked parser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createServersDatReader, readServersDatFallback } = require('../servers-dat');
const { loadApp, plain, projectRoot, withTempRoot } = require('./helpers/electron-app');

const silentLogger = { warn() {} };
const nativeReader = createServersDatReader({
  isPackaged: false,
  appDir: projectRoot,
  resourcesPath: projectRoot,
  platform: process.platform,
  logger: silentLogger,
});

const nativeBinary = path.join(
  projectRoot, 'rust', 'target',
  fs.existsSync(path.join(projectRoot, 'rust', 'target', 'release',
    process.platform === 'win32' ? 'craftdock-servers-dat.exe' : 'craftdock-servers-dat'))
    ? 'release' : 'debug',
  process.platform === 'win32' ? 'craftdock-servers-dat.exe' : 'craftdock-servers-dat',
);

function nbtString(value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

async function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-bounds-'));
  try {
    return await callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// A list of `count` empty compounds: one input byte buys one declared entry, the
// cheapest possible way to inflate what the parser has to materialise.
function paddingFlood(count) {
  const header = Buffer.alloc(4);
  header.writeInt32BE(count);
  return Buffer.concat([
    Buffer.from([0x0a]), nbtString(''),
    Buffer.from([0x09]), nbtString('servers'), Buffer.from([0x0a]),
    header,
    Buffer.alloc(count),
    Buffer.from([0x00]),
  ]);
}

// A list of `count` entries of exactly `size` bytes each, carrying a string
// field so the entry is real content rather than padding.
function sizedEntries(count, size) {
  const header = Buffer.alloc(4);
  header.writeInt32BE(count);
  const payloadLength = size - 7;
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(payloadLength);
  const element = Buffer.concat([
    Buffer.from([0x08]), nbtString('a'), payload, Buffer.alloc(payloadLength, 0x78),
    Buffer.from([0x00]),
  ]);
  assert.equal(element.length, size, 'the sized entry must be exactly the requested size');
  return Buffer.concat([
    Buffer.from([0x0a]), nbtString(''),
    Buffer.from([0x09]), nbtString('servers'), Buffer.from([0x0a]),
    header,
    ...Array.from({ length: count }, () => element),
    Buffer.from([0x00]),
  ]);
}

function serverEntry(name, ip) {
  return Buffer.concat([
    Buffer.from([0x08]), nbtString('name'), nbtString(name),
    Buffer.from([0x08]), nbtString('ip'), nbtString(ip),
    Buffer.from([0x01]), nbtString('hiddenAddress'), Buffer.from([0x00]),
    Buffer.from([0x00]),
  ]);
}

function legitimateServers(count) {
  const header = Buffer.alloc(4);
  header.writeInt32BE(count);
  return Buffer.concat([
    Buffer.from([0x0a]), nbtString(''),
    Buffer.from([0x09]), nbtString('servers'), Buffer.from([0x0a]),
    header,
    ...Array.from({ length: count }, (_, index) =>
      serverEntry(`Survival ${index} with a long, realistic name`, `play.server${index}.example.test:25565`)),
    Buffer.from([0x00]),
  ]);
}

test('the native parser rejects a padding flood quickly instead of parsing it', async () => {
  assert.ok(fs.existsSync(nativeBinary), `native parser not built: ${nativeBinary}`);

  await withTempDir(async directory => {
    fs.writeFileSync(path.join(directory, 'servers.dat'), paddingFlood(900_000));

    const started = Date.now();
    await assert.rejects(nativeReader(directory), /entries|bytes/i);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 1000, `rejection took ${elapsed}ms through the real parser`);
    assert.ok(
      fs.statSync(path.join(directory, 'servers.dat')).size < 1024 * 1024,
      'the hostile fixture is about one megabyte',
    );
  });
});

test('the wrapper surfaces the rejection rather than falling back to JavaScript', async () => {
  await withTempDir(async directory => {
    const flood = paddingFlood(900_000);
    fs.writeFileSync(path.join(directory, 'servers.dat'), flood);

    // A fallback would resolve with an array (the slow path). A rejection can
    // only come from the wrapper refusing to re-parse the same bytes.
    const result = await nativeReader(directory).then(
      value => ({ resolved: value }),
      error => ({ rejected: error }),
    );
    assert.ok(result.rejected, 'the wrapper must reject instead of resolving');
    assert.match(result.rejected.message, /entries|bytes/i);
    assert.doesNotMatch(result.rejected.message, /^Rejected:/, 'the prefix is stripped for the caller');
  });
});

test('a legitimate list is unaffected by the bound', async () => {
  await withTempDir(async directory => {
    fs.writeFileSync(path.join(directory, 'servers.dat'), legitimateServers(500));

    const started = Date.now();
    const servers = await nativeReader(directory);
    const elapsed = Date.now() - started;

    assert.equal(servers.length, 500);
    assert.equal(servers[0].name, 'Survival 0 with a long, realistic name');
    assert.equal(servers[499].ip, 'play.server499.example.test:25565');
    assert.ok(elapsed < 2000, `legitimate parse took ${elapsed}ms`);
  });
});

test('other malformed files still degrade to an empty list, not a rejection', async () => {
  await withTempDir(async directory => {
    // Not a compound root: the ordinary fallback contract is unchanged.
    fs.writeFileSync(path.join(directory, 'servers.dat'), Buffer.from([0x05, 0x00, 0x00, 0xff]));
    assert.deepEqual(await nativeReader(directory), []);
  });
});

test('a gzip-compressed flood is rejected on its decompressed size', async () => {
  await withTempDir(async directory => {
    // ~1 KB on disk that inflates to ~900 KB of declared entries: the bound
    // has to be applied to the bytes the parser actually sees, not the file.
    const file = path.join(directory, 'servers.dat');
    fs.writeFileSync(file, zlib.gzipSync(paddingFlood(900_000)));
    assert.ok(fs.statSync(file).size < 64 * 1024, 'the compressed fixture must be tiny');

    const started = Date.now();
    await assert.rejects(nativeReader(directory), /entries|bytes/i);
    assert.ok(Date.now() - started < 1000, 'the compressed flood must be rejected quickly');
  });
});

test('the entry bound is a clean edge in the wrapper too', async () => {
  await withTempDir(async directory => {
    const file = path.join(directory, 'servers.dat');

    // Ten-byte entries are supportable, so the same shape is accepted.
    fs.writeFileSync(file, sizedEntries(1_000, 10));
    const accepted = await nativeReader(directory);
    assert.equal(accepted.length, 1_000);

    // One byte less per entry for the same declared count is impossible.
    fs.writeFileSync(file, sizedEntries(1_000, 9));
    await assert.rejects(nativeReader(directory), /entries|bytes/i);
  });
});

test('a dense but accepted list stays on the native path', async () => {
  await withTempDir(async directory => {
    // 100k ten-byte entries in ~1 MB: inside the bound and inside the item
    // budget, so it must be parsed. Its ~6 MB of JSON also exceeds the old
    // 4 MB buffer, which used to trip a silent re-parse in JavaScript.
    fs.writeFileSync(path.join(directory, 'servers.dat'), sizedEntries(100_000, 10));

    const warnings = [];
    const reader = createServersDatReader({
      isPackaged: false,
      appDir: projectRoot,
      resourcesPath: projectRoot,
      platform: process.platform,
      logger: { warn: (...args) => warnings.push(args.join(' ')) },
    });

    const started = Date.now();
    const servers = await reader(directory);
    const elapsed = Date.now() - started;

    assert.equal(servers.length, 100_000);
    assert.deepEqual(warnings, [], 'the native path must not fall back to JavaScript');
    assert.ok(elapsed < 5000, `the dense list took ${elapsed}ms`);
  });
});

test('a dense list renders identically and stays proportional', async () => {
  await withTempDir(async directory => {
    // 200k ten-byte entries: ~2 MB in, ~12 MB of JSON out. This is the shape
    // that used to cost a tag tree plus a value tree per entry.
    fs.writeFileSync(path.join(directory, 'servers.dat'), sizedEntries(200_000, 10));
    const warnings = [];
    const reader = createServersDatReader({
      isPackaged: false,
      appDir: projectRoot,
      resourcesPath: projectRoot,
      platform: process.platform,
      logger: { warn: (...args) => warnings.push(args.join(' ')) },
    });

    const started = Date.now();
    const servers = await reader(directory);
    const elapsed = Date.now() - started;

    assert.equal(servers.length, 200_000);
    const expected = { name: 'Minecraft Server', ip: '', icon: null, hidden: false };
    assert.deepEqual(servers[0], expected);
    assert.deepEqual(servers[100_000], expected);
    assert.deepEqual(servers[199_999], expected);
    assert.deepEqual(warnings, [], 'the parse must stay on the native path');
    assert.ok(elapsed < 3000, `the dense render took ${elapsed}ms`);
  });
});

test('an over-budget dense list is rejected instead of re-parsed in JavaScript', async () => {
  await withTempDir(async directory => {
    // 500k ten-byte entries pass the size bound but exceed the item budget: the
    // parser rejects structurally, so the wrapper must rethrow rather than hand
    // the same bytes to the slower fallback.
    fs.writeFileSync(path.join(directory, 'servers.dat'), sizedEntries(500_000, 10));
    const warnings = [];
    const reader = createServersDatReader({
      isPackaged: false,
      appDir: projectRoot,
      resourcesPath: projectRoot,
      platform: process.platform,
      logger: { warn: (...args) => warnings.push(args.join(' ')) },
    });

    const started = Date.now();
    await assert.rejects(reader(directory), /too many tags|too many collection items/i);
    const elapsed = Date.now() - started;

    assert.deepEqual(warnings, [], 'the rejection must not fall through to the fallback');
    assert.ok(elapsed < 3000, `the rejection took ${elapsed}ms`);
  });
});

test('the native path matches the JavaScript parser on the shared fixture', async () => {
  const fixture = path.join(projectRoot, 'tests', 'fixtures', 'servers-dat', 'raw-full.nbt');
  await withTempDir(async directory => {
    fs.copyFileSync(fixture, path.join(directory, 'servers.dat'));
    const native = await nativeReader(directory);
    const fallback = await readServersDatFallback(directory, { warn() {} });
    assert.deepEqual(native, fallback);
    assert.ok(native.length > 0);
  });
});

test('the IPC handler rejects the flood instead of falling back to a slow parse', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);

    // Point the reader's binary lookup at the real build output, exactly as a
    // packaged app finds it, so the IPC path runs the actual Rust parser.
    let linked = true;
    try {
      fs.mkdirSync(path.join(root, 'rust'), { recursive: true });
      fs.symlinkSync(
        path.join(projectRoot, 'rust', 'target'),
        path.join(root, 'rust', 'target'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      linked = false;
    }
    if (!linked) return; // no junction privileges: covered by the reader tests

    const created = plain(await app.exposed.craftdockInstance.create({
      id: 'inst_flood', name: 'Flood', mcVersion: '1.21.4',
    }));
    fs.writeFileSync(path.join(created.dir, 'servers.dat'), paddingFlood(900_000));

    const started = Date.now();
    await assert.rejects(app.exposed.craftdockInstance.readServersDat('inst_flood'), /entries|bytes/i);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 2000, `the IPC rejection took ${elapsed}ms`);

    // A normal server list through the same IPC path still works.
    fs.writeFileSync(path.join(created.dir, 'servers.dat'), legitimateServers(3));
    const servers = plain(await app.exposed.craftdockInstance.readServersDat('inst_flood'));
    assert.equal(servers.length, 3);
    assert.match(servers[0].ip, /play\.server0\.example\.test:25565/);
  });
});
