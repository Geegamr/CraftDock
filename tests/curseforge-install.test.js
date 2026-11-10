// CurseForge modpack install from the browse list: resolve the newest pack file,
// download it, install overrides and resolve every manifest fileID to a CDN URL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadApp, makeZip, plain, projectRoot, withTempRoot,
} = require('./helpers/electron-app');

const PACK_URL = 'https://cdn.example/cf-pack.zip';
const LIST_URL = 'https://api.curseforge.com/v1/mods/900/files';

function jsonResponse(body, { ok = true, status = 200, text = '' } = {}) {
  return { ok, status, json: async () => body, text: async () => text };
}

function routingFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url));
  };
  return { calls, impl };
}

function curseForgePack(extraEntries = []) {
  return makeZip([
    ['manifest.json', JSON.stringify({
      minecraft: {
        version: '1.21.4',
        modLoaders: [{ id: 'fabric-0.15.11', primary: true }],
      },
      name: 'CF Test Pack',
      files: [
        { projectID: 11, fileID: 101, required: true },
        { projectID: 12, fileID: 202, required: false },
      ],
    })],
    ['overrides/config/cf.toml', 'shared=true'],
    ['client-overrides/options.txt', 'fov:0.5'],
    ['overrides/empty-folder/', ''],
    ...extraEntries,
  ]);
}

// CurseForge returns files unordered; the installer must pick the newest upload.
const FILE_LISTING = {
  data: [
    { id: 500, fileName: 'pack-1.0.zip', downloadUrl: 'https://cdn.example/old-pack.zip' },
    { id: 700, fileName: 'pack-source.jar' },
    { id: 600, fileName: 'pack-1.2.zip', displayName: 'CF Test Pack 1.2', downloadUrl: PACK_URL },
  ],
};

test('a CurseForge pack downloads, installs mods and overrides, and records its version', async () => {
  await withTempRoot(async root => {
    const network = routingFetch(url => {
      const { pathname } = new URL(url);
      if (pathname === '/v1/mods/900/files') return jsonResponse(FILE_LISTING);
      if (pathname === '/v1/mods/11/files/101') {
        return jsonResponse({ data: { fileName: 'alpha.jar', downloadUrl: 'https://cdn.example/alpha.jar' } });
      }
      if (pathname === '/v1/mods/12/files/202') {
        return jsonResponse({ data: { fileName: 'beta.jar', downloadUrl: 'https://cdn.example/beta.jar' } });
      }
      return jsonResponse({ message: 'not found' }, { ok: false, status: 404, text: 'not found' });
    });

    const app = loadApp(root, {
      fetch: network.impl,
      routes: {
        [PACK_URL]: curseForgePack(),
        'https://cdn.example/alpha.jar': 'alpha bytes',
        'https://cdn.example/beta.jar': 'beta bytes',
      },
    });
    const created = await app.exposed.craftdockInstance.create({ id: 'inst_cf', name: 'CF Pack' });

    const result = await app.exposed.craftdockInstance.installCurseForgeModpack(
      'inst_cf', 900, '1.21.4', 'fabric',
    );

    assert.deepEqual(plain(result), {
      success: true,
      mcVersion: '1.21.4',
      loader: 'fabric',
      loaderVersion: '0.15.11',
      modsInstalled: 2,
      modsFailed: 0,
    });

    const dir = created.dir;
    assert.equal(fs.readFileSync(path.join(dir, 'mods', 'alpha.jar'), 'utf8'), 'alpha bytes');
    assert.equal(fs.readFileSync(path.join(dir, 'mods', 'beta.jar'), 'utf8'), 'beta bytes');
    assert.equal(fs.readFileSync(path.join(dir, 'config', 'cf.toml'), 'utf8'), 'shared=true');
    assert.equal(fs.readFileSync(path.join(dir, 'options.txt'), 'utf8'), 'fov:0.5');
    assert.equal(fs.existsSync(path.join(dir, '_modpack.zip')), false, 'the downloaded pack is cleaned up');

    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
    assert.equal(meta.source, 'curseforge');
    assert.equal(meta.sourceId, 900);
    assert.equal(meta.sourceVersionId, '600', 'the newest .zip upload is the installed version');
    assert.equal(meta.sourceVersionName, 'CF Test Pack 1.2');
    assert.equal(meta.mcVersion, '1.21.4');
    assert.equal(meta.loader, 'fabric');
    assert.equal(meta.loaderVersion, '0.15.11');
    assert.equal(meta.downloadStatus, 'installed');

    // The file listing asks for this version and loader; the key stays in the header.
    const listing = new URL(network.calls[0].url);
    assert.equal(`${listing.origin}${listing.pathname}`, LIST_URL);
    assert.equal(listing.searchParams.get('gameVersion'), '1.21.4');
    assert.equal(listing.searchParams.get('modLoaderType'), '4');
    assert.equal(listing.searchParams.get('pageSize'), '50');
    assert.equal(network.calls[0].init.headers['x-api-key'], 'test-cf-key');

    assert.ok(app.invocations.some(([channel, id, modId, mcVer, loader]) =>
      channel === 'instance-install-cf-modpack'
      && id === 'inst_cf' && modId === 900 && mcVer === '1.21.4' && loader === 'fabric'));
    assert.ok(app.events.some(([channel, id, percent, message]) =>
      channel === 'instance-install-progress' && id === 'inst_cf' && percent === 100
      && message === 'Done — 2 mods installed'));
  });
});

test('a missing downloadUrl falls back to the Forge CDN and a failed lookup is skipped', async () => {
  await withTempRoot(async root => {
    const pack = makeZip([
      ['manifest.json', JSON.stringify({
        minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] },
        files: [
          { projectID: 1, fileID: 12345, required: true },
          { projectID: 2, fileID: 222, required: true },
        ],
      })],
    ]);
    const network = routingFetch(url => {
      const { pathname } = new URL(url);
      if (pathname === '/v1/mods/900/files') {
        return jsonResponse({ data: [{ id: 600, fileName: 'pack.zip', downloadUrl: PACK_URL }] });
      }
      if (pathname === '/v1/mods/1/files/12345') return jsonResponse({ data: { fileName: 'fallback.jar' } });
      return jsonResponse({ message: 'boom' }, { ok: false, status: 500, text: 'boom' });
    });

    const app = loadApp(root, {
      fetch: network.impl,
      routes: {
        [PACK_URL]: pack,
        'https://edge.forgecdn.net/files/12/345/fallback.jar': 'fallback bytes',
      },
    });
    const created = await app.exposed.craftdockInstance.create({ id: 'inst_cdn', name: 'CDN Pack' });

    const result = await app.exposed.craftdockInstance.installCurseForgeModpack('inst_cdn', 900, '1.20.1', 'forge');

    assert.equal(result.success, true);
    assert.equal(result.modsInstalled, 1);
    assert.equal(result.modsFailed, 1);
    assert.equal(fs.readFileSync(path.join(created.dir, 'mods', 'fallback.jar'), 'utf8'), 'fallback bytes');

    const meta = JSON.parse(fs.readFileSync(path.join(created.dir, 'instance.json'), 'utf8'));
    assert.equal(meta.loader, 'forge');
    assert.equal(meta.loaderVersion, '47.2.0');
    assert.equal(meta.downloadStatus, 'installed');

    assert.ok(app.events.some(([, id, percent, message]) =>
      id === 'inst_cdn' && percent === 100 && message === 'Done — 1 mods installed, 1 skipped'));
  });
});

test('a pack without a file for the requested version fails and marks the instance', async () => {
  await withTempRoot(async root => {
    const network = routingFetch(() => jsonResponse({
      data: [{ id: 700, fileName: 'pack-source.jar', downloadUrl: 'https://cdn.example/x.jar' }],
    }));
    const app = loadApp(root, { fetch: network.impl });
    const created = await app.exposed.craftdockInstance.create({
      id: 'inst_nopack', name: 'No Pack', mcVersion: '1.19', loader: 'fabric',
    });

    const result = await app.exposed.craftdockInstance.installCurseForgeModpack(
      'inst_nopack', 900, '1.19', 'fabric',
    );

    assert.deepEqual(plain(result), {
      success: false, error: 'No CurseForge pack file for Minecraft 1.19',
    });
    assert.equal(fs.existsSync(path.join(created.dir, '_modpack.zip')), false);
    const meta = JSON.parse(fs.readFileSync(path.join(created.dir, 'instance.json'), 'utf8'));
    assert.equal(meta.mcVersion, '1.19');
    assert.equal(meta.downloadStatus, 'error');
  });
});

test('without a configured key the install fails before any request', async () => {
  await withTempRoot(async root => {
    const network = routingFetch(() => jsonResponse({ data: [] }));
    const app = loadApp(root, { fetch: network.impl, env: { CF_API_KEY: '' } });
    await app.exposed.craftdockInstance.create({ id: 'inst_nokey', name: 'No Key' });

    const result = await app.exposed.craftdockInstance.installCurseForgeModpack('inst_nokey', 900, '1.21.4', 'fabric');

    assert.equal(result.success, false);
    assert.match(result.error, /CurseForge API key is not configured/);
    assert.deepEqual(network.calls, []);
  });
});

test('a chosen CurseForge pack file is installed instead of the newest upload', async () => {
  await withTempRoot(async root => {
    const pack = makeZip([
      ['manifest.json', JSON.stringify({
        minecraft: { version: '1.21.4', modLoaders: [{ id: 'fabric-0.15.11', primary: true }] },
        name: 'Picked Pack',
        files: [],
      })],
    ]);
    const network = routingFetch(url => {
      const { pathname } = new URL(url);
      if (pathname === '/v1/mods/900/files/500') {
        return jsonResponse({ data: {
          id: 500,
          fileName: 'picked.zip',
          displayName: 'Picked Pack 1.0',
          downloadUrl: 'https://cdn.example/picked.zip',
        } });
      }
      return jsonResponse({ message: 'not found' }, { ok: false, status: 404, text: 'not found' });
    });
    const app = loadApp(root, {
      fetch: network.impl,
      routes: { 'https://cdn.example/picked.zip': pack },
    });
    const created = await app.exposed.craftdockInstance.create({ id: 'inst_picked', name: 'Picked Pack' });

    const result = await app.exposed.craftdockInstance.installCurseForgeModpack(
      'inst_picked', 900, '1.21.4', 'fabric', '500',
    );

    assert.equal(result.success, true);
    const meta = JSON.parse(fs.readFileSync(path.join(created.dir, 'instance.json'), 'utf8'));
    assert.equal(meta.sourceVersionId, '500');
    assert.equal(meta.sourceVersionName, 'Picked Pack 1.0');
    assert.equal(network.calls[0].url, 'https://api.curseforge.com/v1/mods/900/files/500');
    assert.equal(network.calls.some(call => new URL(call.url).pathname === '/v1/mods/900/files'), false);
  });
});

test('the renderer installs CurseForge packs instead of marking them manual', () => {
  const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');
  const preload = fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf8');

  assert.match(renderer, /pack\.source === 'curseforge' && isCraftDock && window\.craftdockInstance\?\.installCurseForgeModpack/);
  assert.match(renderer, /installCurseForgeModpack\(instId, pack\.id, mcVersion, loader, selectedRelease\?\.id \|\| ''\)/);
  assert.match(renderer, /inst2\.downloadStatus = 'error'/);
  assert.match(preload, /installCurseForgeModpack: \(id, modId, mcVer, loader, fileId\) =>/);
  assert.match(preload, /invoke\('instance-install-cf-modpack', id, modId, mcVer, loader, fileId \|\| ''\)/);
});
