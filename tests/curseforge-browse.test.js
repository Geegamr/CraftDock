// CurseForge browsing: the search request the app sends for browse vs. search,
// pagination/filter passthrough, and how API failures are reported.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain, withTempRoot } = require('./helpers/electron-app');

function jsonResponse(body, { ok = true, status = 200, text = '' } = {}) {
  return { ok, status, json: async () => body, text: async () => text };
}

function recordingFetch(payload = { data: [], pagination: { totalCount: 0 } }, options = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse(payload, options);
  };
  return { calls, impl };
}

function paramsOf(call) {
  const url = new URL(call.url);
  return { base: `${url.origin}${url.pathname}`, params: Object.fromEntries(url.searchParams), headers: call.init.headers };
}

test('browsing sends popularity sorting and the default class without a query', async () => {
  await withTempRoot(async root => {
    const fetchMock = recordingFetch({ data: [{ id: 1, name: 'Sodium' }], pagination: { totalCount: 1 } });
    const app = loadApp(root, { fetch: fetchMock.impl });

    const result = await app.exposed.craftdock.api.curseforgeSearch();

    assert.equal(result.success, true);
    assert.deepEqual(plain(result.data), [{ id: 1, name: 'Sodium' }]);
    assert.deepEqual(plain(result.pagination), { totalCount: 1 });

    const { base, params, headers } = paramsOf(fetchMock.calls[0]);
    assert.equal(base, 'https://api.curseforge.com/v1/mods/search');
    assert.equal(params.gameId, '432');
    assert.equal(params.classId, '4471');
    assert.equal(params.searchFilter, '');
    assert.equal(params.pageSize, '40');
    assert.equal(params.sortField, '2');
    assert.equal(params.sortOrder, 'desc');
    assert.equal('gameVersion' in params, false);
    assert.equal('modLoaderType' in params, false);
    assert.equal('index' in params, false);
    assert.equal(headers['x-api-key'], 'test-cf-key');
    assert.equal(headers.Accept, 'application/json');
  });
});

test('a search sends the query, version, loader, class, sort and page parameters', async () => {
  await withTempRoot(async root => {
    const fetchMock = recordingFetch();
    const app = loadApp(root, { fetch: fetchMock.impl });

    await app.exposed.craftdock.api.curseforgeSearch('sodium', '1.21.4', 4, 6, 6, 40, 20);

    const { params } = paramsOf(fetchMock.calls[0]);
    assert.equal(params.searchFilter, 'sodium');
    assert.equal(params.gameVersion, '1.21.4');
    assert.equal(params.modLoaderType, '4');
    assert.equal(params.classId, '6');
    assert.equal(params.sortField, '6');
    assert.equal(params.pageSize, '20');
    assert.equal(params.index, '40');
    assert.equal(params.sortOrder, 'desc');
  });
});

test('loader 0 is sent as an explicit "any loader" and index 0 is omitted', async () => {
  await withTempRoot(async root => {
    const fetchMock = recordingFetch();
    const app = loadApp(root, { fetch: fetchMock.impl });

    await app.exposed.craftdock.api.curseforgeSearch('', '1.20.1', 0, 4471, 2, 0, 20);

    const { params } = paramsOf(fetchMock.calls[0]);
    assert.equal(params.modLoaderType, '0');
    assert.equal('index' in params, false);
    assert.equal(params.gameVersion, '1.20.1');
  });
});

test('API errors are returned instead of thrown', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, {
      fetch: async () => jsonResponse(null, { ok: false, status: 403, text: 'invalid key' }),
    });

    const result = await app.exposed.craftdock.api.curseforgeSearch('sodium');

    assert.equal(result.success, false);
    assert.match(result.error, /CurseForge API 403: invalid key/);
  });
});

test('a network failure is returned instead of thrown', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, { fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });

    const result = await app.exposed.craftdock.api.curseforgeSearch('sodium');

    assert.deepEqual(plain(result), { success: false, error: 'getaddrinfo ENOTFOUND' });
  });
});

test('without a configured key no request is made', async () => {
  await withTempRoot(async root => {
    const fetchMock = recordingFetch();
    const app = loadApp(root, { fetch: fetchMock.impl, env: { CF_API_KEY: '' } });

    const result = await app.exposed.craftdock.api.curseforgeSearch('sodium');

    assert.equal(result.success, false);
    assert.match(result.error, /CurseForge API key is not configured/);
    assert.deepEqual(fetchMock.calls, []);
  });
});

test('Minecraft version browsing reuses the key and unwraps the data array', async () => {
  await withTempRoot(async root => {
    const fetchMock = recordingFetch({ data: [{ versionString: '1.21.4', type: 'release' }] });
    const app = loadApp(root, { fetch: fetchMock.impl });

    const result = await app.exposed.craftdock.api.getMinecraftVersions();

    assert.equal(result.success, true);
    assert.deepEqual(plain(result.data), [{ versionString: '1.21.4', type: 'release' }]);
    const call = fetchMock.calls[0];
    assert.equal(call.url, 'https://api.curseforge.com/v1/minecraft/version');
    assert.equal(call.init.headers['x-api-key'], 'test-cf-key');
  });
});
