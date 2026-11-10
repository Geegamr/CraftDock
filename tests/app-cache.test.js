const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanUnusedGameFiles, cleanUnusedGameFiles } = require('../app-cache');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-cache-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relative, content = '') {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function fixture(t) {
  const root = tempRoot(t);
  write(root, 'client-cache/1.20.1/version.json', '{"id":"1.20.1"}');
  write(root, 'client-cache/1.20.1/minecraft-1.20.1-client.jar', 'old-client');
  write(root, 'client-cache/1.21.1/version.json', '{"id":"1.21.1"}');
  write(root, 'client-cache/assets/objects/ab/cdef', 'shared-asset');
  write(root, 'client-cache/libraries/example/lib.jar', 'shared-library');
  write(root, 'client-cache/loaders/fabric-1.20.1-0.15.11.json', 'old-loader');
  write(root, 'client-cache/loaders/forge-1.21.1', 'current-loader');
  return root;
}

test('the unused scan finds old Minecraft versions and loader files only', async t => {
  const dataRoot = fixture(t);
  const result = await scanUnusedGameFiles(dataRoot, ['1.21.1']);

  assert.equal(result.success, true, result.error);
  assert.deepEqual(result.activeVersions, ['1.21.1']);
  assert.equal(result.count, 2);
  assert.equal(result.files, 3);
  assert.ok(result.bytes > 0);
  assert.deepEqual(result.entries.map(entry => entry.relative).sort(), [
    '1.20.1',
    'loaders/fabric-1.20.1-0.15.11.json',
  ]);
  assert.equal(fs.existsSync(path.join(dataRoot, 'client-cache/1.20.1')), true, 'scan does not delete');
});

test('cleaning removes only the unused entries and leaves shared files intact', async t => {
  const dataRoot = fixture(t);
  const result = await cleanUnusedGameFiles(dataRoot, ['1.21.1']);

  assert.equal(result.success, true, result.error);
  assert.equal(result.count, 2);
  assert.deepEqual(result.removed.sort(), ['1.20.1', 'loaders/fabric-1.20.1-0.15.11.json']);
  assert.equal(fs.existsSync(path.join(dataRoot, 'client-cache/1.20.1')), false);
  assert.equal(fs.existsSync(path.join(dataRoot, 'client-cache/loaders/fabric-1.20.1-0.15.11.json')), false);
  assert.equal(fs.existsSync(path.join(dataRoot, 'client-cache/1.21.1/version.json')), true);
  assert.equal(fs.existsSync(path.join(dataRoot, 'client-cache/assets/objects/ab/cdef')), true);
  assert.equal(fs.existsSync(path.join(dataRoot, 'client-cache/libraries/example/lib.jar')), true);
  assert.equal(fs.existsSync(path.join(dataRoot, 'client-cache/loaders/forge-1.21.1')), true);
});

test('version matching is conservative for loader names and missing caches', async t => {
  const dataRoot = tempRoot(t);
  assert.deepEqual(await scanUnusedGameFiles(dataRoot, ['1.21.1']), {
    success: true,
    entries: [],
    count: 0,
    files: 0,
    bytes: 0,
    activeVersions: ['1.21.1'],
  });

  write(dataRoot, 'client-cache/loaders/fabric-1.21.1-0.16.2.json', 'keep');
  write(dataRoot, 'client-cache/loaders/forge-1.21.4', 'keep-conservatively');
  const result = await scanUnusedGameFiles(dataRoot, ['1.21']);
  assert.equal(result.count, 0, 'a parent version keeps matching loader files');
});

test('a missing data folder reports a failure instead of throwing', async () => {
  const result = await scanUnusedGameFiles(path.join(os.tmpdir(), 'craftdock-missing-cache-root'), ['1.21.1']);
  assert.equal(result.success, false);
  assert.match(result.error, /not found/);
});
