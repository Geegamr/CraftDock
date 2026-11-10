const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, plain, withTempRoot, writeInstance } = require('./helpers/electron-app');

test('options.txt syncs from one instance to every other instance', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const sourceDir = writeInstance(app, 'inst_source', { name: 'Source' });
    const existingDir = writeInstance(app, 'inst_existing', { name: 'Existing' });
    const emptyDir = writeInstance(app, 'inst_empty', { name: 'Empty' });

    const sourceOptions = 'fov:90\nlang:en_us\n';
    fs.writeFileSync(path.join(sourceDir, 'options.txt'), sourceOptions);
    fs.writeFileSync(path.join(existingDir, 'options.txt'), 'fov:30\n');

    const result = plain(await app.exposed.craftdockInstance.syncOptions('inst_source'));

    assert.equal(result.success, true);
    assert.deepEqual(result.source, { id: 'inst_source', name: 'Source' });
    assert.equal(result.copied, 2);
    assert.deepEqual(
      result.copiedInstances.map(instance => instance.id).sort(),
      ['inst_empty', 'inst_existing']
    );
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.failed, []);
    assert.equal(fs.readFileSync(path.join(sourceDir, 'options.txt'), 'utf8'), sourceOptions);
    assert.equal(fs.readFileSync(path.join(existingDir, 'options.txt'), 'utf8'), sourceOptions);
    assert.equal(fs.readFileSync(path.join(emptyDir, 'options.txt'), 'utf8'), sourceOptions);
    assert.equal(fs.existsSync(path.join(emptyDir, 'options.txt.craftdock-sync')), false);
  });
});

test('options.txt sync reports a missing source file instead of creating empty options', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const sourceDir = writeInstance(app, 'inst_source', { name: 'Source' });
    const destinationDir = writeInstance(app, 'inst_destination', { name: 'Destination' });
    fs.writeFileSync(path.join(destinationDir, 'options.txt'), 'keep-me');

    const missing = plain(await app.exposed.craftdockInstance.syncOptions('inst_source'));
    assert.equal(missing.success, false);
    assert.match(missing.error, /has no options\.txt yet/);
    assert.equal(fs.existsSync(path.join(sourceDir, 'options.txt')), false);
    assert.equal(fs.readFileSync(path.join(destinationDir, 'options.txt'), 'utf8'), 'keep-me');

    const unknown = plain(await app.exposed.craftdockInstance.syncOptions('inst_unknown'));
    assert.equal(unknown.success, false);
    assert.match(unknown.error, /Source instance not found/);
  });
});
