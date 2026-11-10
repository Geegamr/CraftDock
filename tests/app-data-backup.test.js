const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BACKUP_FORMAT,
  BACKUP_MANIFEST,
  createAppDataBackup,
  isExcluded,
} = require('../app-data-backup');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-backup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relative, content = '') {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test('app-data backups keep user data and skip redownloadable runtimes', async t => {
  const root = tempRoot(t);
  const dataRoot = path.join(root, 'craftdock-data');
  const destination = path.join(root, 'backups');
  fs.mkdirSync(destination, { recursive: true });

  write(dataRoot, 'data/craftdock_appSettings.json', '{"theme":"dark"}');
  write(dataRoot, 'data/craftdock_accounts.json', '[]');
  write(dataRoot, 'instances/inst_one/instance.json', '{"name":"One"}');
  write(dataRoot, 'instances/inst_one/saves/world/level.dat', 'world');
  write(dataRoot, 'servers/srv_one/server.properties', 'motd=Hi\n');
  write(dataRoot, 'skins/example.png', 'skin');
  write(dataRoot, 'client-cache/1.21.1/version.json', '{}');
  write(dataRoot, 'client-cache/assets/objects/aa/hash', 'asset');
  write(dataRoot, 'data/java/java21/bin/java', 'runtime');
  write(dataRoot, 'data/browse-cache.json', '{"entries":[]}');

  const result = await createAppDataBackup({
    dataRoot,
    destinationRoot: destination,
    appVersion: '9.9.9',
    now: new Date(2026, 10, 10, 15, 4, 5),
  });

  assert.equal(result.success, true, result.error);
  assert.equal(path.basename(result.path), 'CraftDock Backup 2026-11-10-150405');
  assert.equal(result.files, 6, 'only the included user-data files are counted');
  assert.equal(fs.existsSync(path.join(result.path, 'craftdock-data/data/craftdock_appSettings.json')), true);
  assert.equal(fs.existsSync(path.join(result.path, 'craftdock-data/instances/inst_one/saves/world/level.dat')), true);
  assert.equal(fs.existsSync(path.join(result.path, 'craftdock-data/servers/srv_one/server.properties')), true);
  assert.equal(fs.existsSync(path.join(result.path, 'craftdock-data/client-cache')), false);
  assert.equal(fs.existsSync(path.join(result.path, 'craftdock-data/data/java')), false);
  assert.equal(fs.existsSync(path.join(result.path, 'craftdock-data/data/browse-cache.json')), false);

  const manifest = JSON.parse(fs.readFileSync(path.join(result.path, BACKUP_MANIFEST), 'utf8'));
  assert.equal(manifest.format, BACKUP_FORMAT);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.appVersion, '9.9.9');
  assert.equal(manifest.createdAt, new Date(2026, 10, 10, 15, 4, 5).toISOString());
  assert.equal(manifest.files, 6);
  assert.deepEqual(manifest.excluded, ['client-cache', 'data/java', 'data/browse-cache.json']);
});

test('a second backup at the same second gets its own folder', async t => {
  const root = tempRoot(t);
  const dataRoot = path.join(root, 'data');
  const destination = path.join(root, 'backups');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  write(dataRoot, 'data/settings.json', '{}');
  const now = new Date(2026, 0, 2, 3, 4, 5);

  const first = await createAppDataBackup({ dataRoot, destinationRoot: destination, now });
  const second = await createAppDataBackup({ dataRoot, destinationRoot: destination, now });

  assert.equal(first.success, true, first.error);
  assert.equal(second.success, true, second.error);
  assert.notEqual(first.path, second.path);
  assert.equal(path.basename(second.path), 'CraftDock Backup 2026-01-02-030405 (2)');
});

test('app-data backups refuse a destination inside the data folder', async t => {
  const root = tempRoot(t);
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(path.join(dataRoot, 'backups'), { recursive: true });

  const result = await createAppDataBackup({
    dataRoot,
    destinationRoot: path.join(dataRoot, 'backups'),
  });

  assert.equal(result.success, false);
  assert.match(result.error, /outside the CraftDock data folder/);
});

test('excluded paths cover directories and individual cache files', () => {
  assert.equal(isExcluded('client-cache'), true);
  assert.equal(isExcluded('client-cache/1.21.1/version.json'), true);
  assert.equal(isExcluded('client-cache-notes/data.json'), false);
  assert.equal(isExcluded('data/java'), true);
  assert.equal(isExcluded('data/java/java21/bin/java'), true);
  assert.equal(isExcluded('data/browse-cache.json'), true);
  assert.equal(isExcluded('data/craftdock_appSettings.json'), false);
});
