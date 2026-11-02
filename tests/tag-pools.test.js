// Shared tag folders outlived the instances that used them: deleting the last
// instance of a tag left its worlds/servers/packs on disk with nothing pointing
// at them. These cover the sweep that now runs on delete and update, the folder
// list the Tags tab reads, and the per-instance banner.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, plain, withTempRoot } = require('./helpers/electron-app');

const instanceApi = app => app.exposed.craftdockInstance;

async function createInstance(app, id, meta = {}) {
  const created = plain(await instanceApi(app).create({ id, name: id, mcVersion: '1.21.4', ...meta }));
  assert.equal(created.success, true);
  return created.dir;
}

async function setTags(app, id, tags) {
  const inst = plain(await instanceApi(app).get(id));
  plain(await instanceApi(app).update({ ...inst, ...tags }));
}

function poolDir(app, kind, name) {
  const bases = {
    world: app.sharedWorldsDir,
    server: app.sharedServersDir,
    resource: app.sharedResourcesDir,
    shader: app.sharedShadersDir,
  };
  return path.join(bases[kind], name);
}

test('deleting the last instance of a tag removes that tag folder', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    await createInstance(app, 'inst_solo', { worldTag: 'solo-worlds' });
    const pool = poolDir(app, 'world', 'solo-worlds');
    fs.writeFileSync(path.join(pool, 'level.dat'), 'world bytes');

    const result = plain(await instanceApi(app).delete('inst_solo'));

    assert.deepEqual(result, { success: true, removedPools: [{ kind: 'world', name: 'solo-worlds' }] });
    assert.equal(fs.existsSync(pool), false);
  });
});

test('a tag folder shared with another instance survives the delete', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    await createInstance(app, 'inst_one', { worldTag: 'smp' });
    await createInstance(app, 'inst_two', { worldTag: 'smp' });
    const pool = poolDir(app, 'world', 'smp');
    fs.writeFileSync(path.join(pool, 'level.dat'), 'shared world');

    const result = plain(await instanceApi(app).delete('inst_one'));

    assert.deepEqual(result, { success: true, removedPools: [] });
    assert.equal(fs.existsSync(path.join(pool, 'level.dat')), true);

    const last = plain(await instanceApi(app).delete('inst_two'));
    assert.deepEqual(last.removedPools, [{ kind: 'world', name: 'smp' }]);
    assert.equal(fs.existsSync(pool), false);
  });
});

test('clearing the last tag on an instance cleans up its folder too', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    await createInstance(app, 'inst_clear', { resourceTag: 'packs' });
    const pool = poolDir(app, 'resource', 'packs');
    assert.equal(fs.existsSync(pool), true);

    await setTags(app, 'inst_clear', { resourceTag: null });

    assert.equal(fs.existsSync(pool), false);
  });
});

test('the tag folder list reports owners, size and kind', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    await createInstance(app, 'inst_listed', { worldTag: 'owned', shaderTag: 'shiny' });
    fs.writeFileSync(path.join(poolDir(app, 'world', 'owned'), 'level.dat'), Buffer.alloc(2048));
    // A folder nothing references is exactly what the user is meant to see and delete.
    fs.mkdirSync(path.join(poolDir(app, 'world', 'orphan')), { recursive: true });

    const pools = plain(await instanceApi(app).listTagPools());
    const owned = pools.find(p => p.kind === 'world' && p.name === 'owned');
    const orphan = pools.find(p => p.kind === 'world' && p.name === 'orphan');
    const shiny = pools.find(p => p.kind === 'shader' && p.name === 'shiny');

    assert.deepEqual(owned.instances, ['inst_listed']);
    assert.equal(owned.size, 2048);
    assert.deepEqual(orphan.instances, []);
    assert.equal(shiny.kind, 'shader');
  });
});

test('a tag folder still in use cannot be deleted by hand', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    await createInstance(app, 'inst_busy', { worldTag: 'busy-worlds' });
    const pool = poolDir(app, 'world', 'busy-worlds');

    const refused = plain(await instanceApi(app).deleteTagPool('world', 'busy-worlds'));
    assert.equal(refused.success, false);
    assert.match(refused.error, /inst_busy/);
    assert.equal(fs.existsSync(pool), true);

    await instanceApi(app).delete('inst_busy');
    fs.mkdirSync(pool, { recursive: true });
    fs.writeFileSync(path.join(pool, 'leftover.dat'), 'junk');

    assert.deepEqual(plain(await instanceApi(app).deleteTagPool('world', 'busy-worlds')), { success: true });
    assert.equal(fs.existsSync(pool), false);
  });
});

test('a tag folder name cannot escape the shared folder', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const marker = path.join(app.dataRoot, 'keep-me.txt');
    fs.writeFileSync(marker, 'still here');

    const escaped = plain(await instanceApi(app).deleteTagPool('world', '../keep-me.txt'));
    assert.equal(escaped.success, false);
    assert.match(escaped.error, /outside/i);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'still here');
  });
});

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('a banner round-trips through the instance folder, not instance.json', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const dir = await createInstance(app, 'inst_banner', { worldTag: 'none' });

    assert.equal(plain(await instanceApi(app).getBanner('inst_banner')), null);
    assert.deepEqual(plain(await instanceApi(app).setBanner('inst_banner', TINY_PNG)), { success: true });

    assert.equal(plain(await instanceApi(app).getBanner('inst_banner')), TINY_PNG);
    assert.equal(fs.existsSync(path.join(dir, 'banner.png')), true);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
    assert.equal(meta.bannerFile, 'banner.png');
    assert.equal(JSON.stringify(meta).includes('base64'), false);

    assert.deepEqual(plain(await instanceApi(app).clearBanner('inst_banner')), { success: true });
    assert.equal(fs.existsSync(path.join(dir, 'banner.png')), false);
    assert.equal(plain(await instanceApi(app).getBanner('inst_banner')), null);
  });
});

test('a banner that is not a small image is refused', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const dir = await createInstance(app, 'inst_bad_banner');

    const notAnImage = plain(await instanceApi(app).setBanner('inst_bad_banner', 'data:text/plain;base64,aGVsbG8='));
    assert.equal(notAnImage.success, false);

    const huge = 'data:image/png;base64,' + Buffer.alloc(9 * 1024 * 1024).toString('base64');
    const tooBig = plain(await instanceApi(app).setBanner('inst_bad_banner', huge));
    assert.equal(tooBig.success, false);
    assert.match(tooBig.error, /8 MB/);

    assert.equal(fs.existsSync(path.join(dir, 'banner.png')), false);
  });
});
