const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { loadApp, plain, projectRoot, withTempRoot } = require('./helpers/electron-app');

const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');
const capeUrl = 'https://api.minecraftservices.com/minecraft/profile/capes/active';
const capeId = '2d4de64a-da1b-4196-8e37-20740f6941ad';

test('cape equip and clear go through the main process with the active cape id', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, {
      routes: { [capeUrl]: { status: 204, body: '' } },
    });

    assert.deepEqual(plain(await app.exposed.craftdock.auth.setCape('token-one', capeId)), { ok: true });
    assert.deepEqual(plain(await app.exposed.craftdock.auth.setCape('token-one', null)), { ok: true });

    assert.deepEqual(
      app.network.requests.filter(request => request.url === capeUrl).map(request => ({
        method: request.method,
        body: request.body,
        authorization: request.headers.Authorization,
        contentType: request.headers['Content-Type'] || null,
      })),
      [
        {
          method: 'PUT',
          body: JSON.stringify({ capeId }),
          authorization: 'Bearer token-one',
          contentType: 'application/json',
        },
        {
          method: 'DELETE',
          body: '',
          authorization: 'Bearer token-one',
          contentType: null,
        },
      ],
    );
    assert.deepEqual(
      app.invocations.filter(([channel]) => channel === 'auth-set-cape'),
      [['auth-set-cape', 'token-one', capeId], ['auth-set-cape', 'token-one', null]],
    );
  });
});

test('failed cape changes are reported instead of being treated as equipped', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, {
      routes: { [capeUrl]: { status: 403, body: { error: 'Forbidden' } } },
    });

    assert.deepEqual(plain(await app.exposed.craftdock.auth.setCape('token-one', capeId)), {
      ok: false,
      status: 403,
      error: 'http_403',
    });
    assert.deepEqual(plain(await app.exposed.craftdock.auth.setCape('token-one', '../escape')), {
      ok: false,
      error: 'invalid_cape',
    });
    assert.deepEqual(plain(await app.exposed.craftdock.auth.setCape('', capeId)), {
      ok: false,
      error: 'missing_token',
    });
  });
});

test('saved outfits carry the active cape and restore it in the preview', () => {
  const start = renderer.indexOf('function outfitCapeSnapshot()');
  const end = renderer.indexOf('\nasync function saveSkin()', start);
  assert.ok(start >= 0 && end > start, 'the renderer defines the outfit cape snapshot');
  const sandbox = {
    currentActiveCape: {
      id: capeId,
      alias: 'Migrator',
      name: 'Migrator Cape',
      url: 'https://textures.minecraft.net/texture/example',
      equipped: false,
    },
    getCapeDisplay: alias => ({ name: alias === 'Migrator' ? 'Migrator Cape' : (alias || 'Cape') }),
  };
  vm.runInNewContext(
    `${renderer.slice(start, end)}\nglobalThis.outfitCapeSnapshot = outfitCapeSnapshot;`,
    sandbox,
  );

  assert.deepEqual(plain(sandbox.outfitCapeSnapshot()), {
    id: capeId,
    alias: 'Migrator',
    name: 'Migrator Cape',
    url: 'https://textures.minecraft.net/texture/example',
  });
  sandbox.currentActiveCape = null;
  assert.equal(sandbox.outfitCapeSnapshot(), null);

  assert.match(renderer, /const cape = outfitCapeSnapshot\(\);[\s\S]*?addedAt:\s*existing \? existing\.addedAt : Date\.now\(\),\s*cape\s*\}/,
    'saveSkin stores the cape with the skin and keeps an edited entry\u2019s original timestamp');
  assert.match(renderer, /outfitCape && outfitCape\.alias[\s\S]*?updateActiveCapeInSkinPanel\([\s\S]*?false\);/,
    'selecting a saved outfit restores its cape, marked as not yet applied');
  assert.match(renderer, /mainRenderer\.setCape\(textureUrl\|\|null\)/,
    'the active cape panel updates the 3D preview');
  assert.match(renderer, /mainRenderer\.setCape\(currentActiveCape\?\.url \|\| null\)/,
    'opening the skin manager restores the cached outfit cape');
  assert.match(renderer, /new THREE\.BoxGeometry\(2\.5, 4, 0\.25\)/,
    'the preview builds a one-pixel-thick 10×16 cape slab');
  assert.match(renderer, /const faces = \(modern \|\| legacy\)[\s\S]*?uv\(11, 1, 1, 16\)[\s\S]*?uv\(0, 1, 1, 16\)[\s\S]*?uv\(1, 0, 10, 1\)[\s\S]*?uv\(11, 0, 10, 1\)[\s\S]*?uv\(12, 1, 10, 16\)[\s\S]*?uv\(1, 1, 10, 16\)/,
    'the cape maps the left, right, top, bottom, inside, and outside atlas strips onto its six faces');
  assert.match(renderer, /const materials = faces\.map\(\(\[tx, ty, tw, th\]\) =>[\s\S]*?this\._faceMat\(this\._cape, tx, ty, tw, th, false, width, height\)/,
    'each cape face samples its own atlas region instead of reusing the back crop');
  assert.match(renderer, /this\._disposeCharacterResources\(this\._capePivot\)/,
    'the per-face cape texture clones are disposed with the cape');
  assert.match(renderer, /group\.add\(this\._capeGroup\);/,
    'the cape is parented to the character so it moves with the player');
  assert.doesNotMatch(renderer, /_capeGroup\.rotation\.copy\(this\._characterGroup\.rotation\)/,
    'the cape is not transformed separately from the character');
  assert.match(renderer, /if \(res\.ok\)[\s\S]*?const pendingOutfitCape = currentActiveCape && currentActiveCape\.equipped === false/,
    'applying an outfit equips its cape after the skin upload succeeds');

  const equipStart = renderer.indexOf('async function equipCape');
  const equipEnd = renderer.indexOf('\nasync function disableCape', equipStart);
  assert.ok(equipStart >= 0 && equipEnd > equipStart, 'the renderer defines equipCape');
  const equip = renderer.slice(equipStart, equipEnd);
  assert.match(equip, /requestCapeChange\(token, capeId\)/,
    'cape changes go through the main-process bridge');
  assert.match(equip, /if \(!result \|\| !result\.ok\) throw/,
    'the active cape is only updated after the API accepts the change');
  assert.doesNotMatch(equip, /\bfetch\(/,
    'the renderer does not call the CORS-blocked Mojang cape endpoint directly');
});
