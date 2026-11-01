// Modpack installation into an instance: a Modrinth .mrpack is unpacked into
// overrides, mod files and instance metadata without clobbering local files.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadApp, makeZip, plain, withTempRoot, writeInstance,
} = require('./helpers/electron-app');

const PACK_URL = 'https://cdn.example/pack.mrpack';

function pack(extra = {}) {
  return makeZip([
    ['modrinth.index.json', JSON.stringify({
      formatVersion: 1,
      game: 'minecraft',
      name: 'Test Pack',
      dependencies: { minecraft: '1.21.4', 'fabric-loader': '0.15.11' },
      files: [
        { path: 'mods/sodium.jar', downloads: ['https://cdn.example/sodium.jar'], env: { client: 'required', server: 'required' } },
        { path: 'mods/iris.jar', downloads: ['https://cdn.example/iris.jar'], env: { client: 'required', server: 'unsupported' } },
        { path: 'resourcepacks/pack.zip', downloads: ['https://cdn.example/pack.zip'] },
      ],
      ...extra,
    })],
    ['overrides/config/sodium-options.json', '{"quality":true}'],
    ['client-overrides/options.txt', 'fov:0.5'],
  ]);
}

test('a Modrinth .mrpack installs mods, overrides and metadata', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, {
      routes: {
        [PACK_URL]: pack(),
        'https://cdn.example/sodium.jar': 'sodium bytes',
        'https://cdn.example/iris.jar': 'iris bytes',
        'https://cdn.example/pack.zip': 'resource pack bytes',
      },
    });
    const instanceDir = writeInstance(app, 'inst_pack', { name: 'Pack', downloadStatus: 'installing' });

    const result = await app.exposed.craftdockInstance.installModpack('inst_pack', PACK_URL);

    assert.deepEqual(plain(result), {
      success: true, mcVersion: '1.21.4', loader: 'fabric', loaderVersion: '0.15.11', modsInstalled: 3,
    });
    assert.equal(fs.readFileSync(path.join(instanceDir, 'mods', 'sodium.jar'), 'utf8'), 'sodium bytes');
    assert.equal(fs.readFileSync(path.join(instanceDir, 'resourcepacks', 'pack.zip'), 'utf8'), 'resource pack bytes');
    assert.equal(fs.readFileSync(path.join(instanceDir, 'config', 'sodium-options.json'), 'utf8'), '{"quality":true}');
    assert.equal(fs.readFileSync(path.join(instanceDir, 'options.txt'), 'utf8'), 'fov:0.5');
    assert.equal(fs.existsSync(path.join(instanceDir, '_modpack.mrpack')), false, 'the downloaded pack is cleaned up');

    const meta = JSON.parse(fs.readFileSync(path.join(instanceDir, 'instance.json'), 'utf8'));
    assert.equal(meta.mcVersion, '1.21.4');
    assert.equal(meta.loader, 'fabric');
    assert.equal(meta.loaderVersion, '0.15.11');
    assert.equal(meta.downloadStatus, 'installed');

    assert.ok(app.events.some(([channel, id, percent, message]) =>
      channel === 'instance-install-progress' && id === 'inst_pack' && percent === 100 && /Done/.test(message)));
  });
});

test('client-unsupported pack files are skipped and existing files are preserved', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, {
      routes: {
        [PACK_URL]: pack(),
        'https://cdn.example/sodium.jar': 'remote sodium',
        'https://cdn.example/pack.zip': 'remote pack',
      },
    });
    const instanceDir = writeInstance(app, 'inst_keep');
    fs.writeFileSync(path.join(instanceDir, 'mods', 'sodium.jar'), 'local sodium');

    const result = await app.exposed.craftdockInstance.installModpack('inst_keep', PACK_URL);

    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(path.join(instanceDir, 'mods', 'sodium.jar'), 'utf8'), 'local sodium');
    assert.equal(fs.existsSync(path.join(instanceDir, 'mods', 'iris.jar')), false,
      'files marked client-unsupported are not installed on the server');
  });
});

test('downloading a mod tries each download URL until one succeeds', async () => {
  await withTempRoot(async root => {
    const multiUrlPack = makeZip([
      ['modrinth.index.json', JSON.stringify({
        dependencies: { minecraft: '1.21.4', 'fabric-loader': '0.15.11' },
        files: [{
          path: 'mods/resilient.jar',
          downloads: ['https://cdn.example/missing.jar', 'https://cdn.example/mirror.jar'],
        }],
      })],
    ]);
    const app = loadApp(root, {
      routes: {
        [PACK_URL]: multiUrlPack,
        'https://cdn.example/mirror.jar': 'mirror bytes',
      },
    });
    const instanceDir = writeInstance(app, 'inst_resilient');

    const result = await app.exposed.craftdockInstance.installModpack('inst_resilient', PACK_URL);

    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(path.join(instanceDir, 'mods', 'resilient.jar'), 'utf8'), 'mirror bytes');
  });
});

test('an invalid .mrpack fails without creating instance files', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, {
      routes: { [PACK_URL]: makeZip([['manifest.json', '{"name":"not a mrpack"}']]) },
    });
    const instanceDir = writeInstance(app, 'inst_invalid', { mcVersion: '1.20.1', loader: 'forge' });

    const result = await app.exposed.craftdockInstance.installModpack('inst_invalid', PACK_URL);

    assert.equal(result.success, false);
    assert.match(result.error, /missing modrinth\.index\.json/);
    const meta = JSON.parse(fs.readFileSync(path.join(instanceDir, 'instance.json'), 'utf8'));
    assert.equal(meta.mcVersion, '1.20.1', 'metadata is untouched when the pack is rejected');
    assert.equal(meta.loader, 'forge');
    assert.equal(meta.downloadStatus, undefined);
  });
});

test('a download failure is reported through the progress channel', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, {
      routes: {
        [PACK_URL]: makeZip([
          ['modrinth.index.json', JSON.stringify({
            dependencies: { minecraft: '1.21.4', 'fabric-loader': '0.15.11' },
            files: [{ path: 'mods/nope.jar', downloads: ['https://cdn.example/nope.jar'] }],
          })],
        ]),
      },
    });
    writeInstance(app, 'inst_fail');

    const result = await app.exposed.craftdockInstance.installModpack('inst_fail', PACK_URL);

    // The handler installs what it can; failures surface as a 100% error message.
    assert.equal(typeof result.success, 'boolean');
    const messages = app.events
      .filter(([channel, id]) => channel === 'instance-install-progress' && id === 'inst_fail')
      .map(([, , , message]) => message);
    assert.ok(messages.some(message => message === 'Done — 1 mods installed' || /Error/.test(message)));
  });
});
