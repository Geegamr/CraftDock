// Library controls and the shared modpack update check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

function extract(pattern, label) {
  const match = html.match(pattern);
  assert.ok(match, `${label} is missing`);
  return match[0];
}

function loadUpdateCheck(fetchImpl) {
  const context = {
    APP_VERSION: 'test',
    URLSearchParams,
    fetch: fetchImpl,
    _modpackUpdateCache: new Map(),
    MODPACK_UPDATE_TTL: 5 * 60 * 1000,
  };
  vm.createContext(context);
  vm.runInContext(
    extract(/^async function checkModpackUpdate\(inst\) \{[\s\S]*?^\}/m, 'checkModpackUpdate()'),
    context,
  );
  return context;
}

function packVersion(id) {
  return {
    id,
    version_number: id,
    files: [{ primary: true, url: `https://cdn.example/${id}.mrpack`, filename: `${id}.mrpack` }],
  };
}

test('modpack update checks never offer an older build as an update', async () => {
  const urls = [];
  const context = loadUpdateCheck(async url => {
    urls.push(String(url));
    return { ok: true, json: async () => [packVersion('installed'), packVersion('older')] };
  });

  const update = await context.checkModpackUpdate({
    source: 'modrinth',
    sourceId: 'pack',
    sourceVersionId: 'installed',
    mcVersion: '1.21.1',
    loader: 'Fabric',
  });

  assert.equal(update, null);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /game_versions=/);
  assert.match(urls[0], /loaders=%5B%22fabric%22%5D/);
});

test('modpack update checks return the newest compatible build', async () => {
  const context = loadUpdateCheck(async () => ({
    ok: true,
    json: async () => [packVersion('new'), packVersion('installed'), packVersion('old')],
  }));

  const update = await context.checkModpackUpdate({
    source: 'modrinth',
    sourceId: 'pack',
    sourceVersionId: 'installed',
    mcVersion: '1.21.1',
    loader: 'fabric',
  });

  assert.equal(update.versionId, 'new');
  assert.equal(update.versionName, 'new');
  assert.equal(update.downloadUrl, 'https://cdn.example/new.mrpack');
});

test('locked modpacks skip the update check entirely', async () => {
  let fetched = false;
  const context = loadUpdateCheck(async () => {
    fetched = true;
    return { ok: true, json: async () => [packVersion('new')] };
  });

  const update = await context.checkModpackUpdate({
    source: 'modrinth',
    sourceId: 'pack',
    sourceVersionId: 'installed',
    skipUpdateCheck: true,
  });

  assert.equal(update, null);
  assert.equal(fetched, false);
});

test('the Library sort select stays a full native clickable control', () => {
  assert.match(html, /<select id="librarySort" class="library-sort-select" onchange="setLibrarySort\(this.value\)"/);
  assert.match(html, /\.library-sort\{[^}]*flex-shrink:0/);
  assert.match(html, /\.library-sort-select\{min-width:92px;max-width:156px;height:34px/);
  assert.doesNotMatch(html, /\.library-sort::after/);
});

test('the Library exposes three persisted card sizes with 7 and 5 column layouts', () => {
  assert.match(html, /id="libraryView" data-card-size="small"/);
  for (const size of ['small', 'medium', 'large']) {
    assert.match(html, new RegExp(`data-library-size="${size}"`));
  }
  assert.match(html, /craftdock:libraryCardSize/);
  assert.match(html, /\.library-view\[data-card-size="medium"\] \.library-cards\{grid-template-columns:repeat\(7,minmax\(0,1fr\)\)\}/);
  assert.match(html, /\.library-view\[data-card-size="large"\] \.library-cards\{grid-template-columns:repeat\(5,minmax\(0,1fr\)\)\}/);
  assert.match(html, /\.library-card\{position:relative;display:flex;flex-direction:column;min-height:194px/);
  assert.match(html, /\.library-card-icon img\{width:100%;height:100%;object-fit:contain/);
  assert.match(html, /\.library-view\[data-card-size="medium"\] \.library-card,\n\.library-view\[data-card-size="large"\] \.library-card\{min-height:0;aspect-ratio:38\/51\}/);
  assert.match(html, /\.library-view\[data-card-size="medium"\] \.library-card-art,\n\.library-view\[data-card-size="large"\] \.library-card-art\{min-height:0\}/);
  assert.doesNotMatch(html, /data-card-size="(?:medium|large)"\] \.library-card\{[^}]*flex-direction:row/);
  assert.match(html, /class="library-size-btn active"[^>]*data-library-size="small"/);
});

test('Library deletes use the themed dialog with the item name on the button', () => {
  assert.match(html, /class="modal confirm-modal"/);
  assert.doesNotMatch(html, /id="confirmOk"[^>]*>Confirm</);
  assert.match(html, /okBtn\.title = okLabel \|\| 'Continue'/);
  assert.match(html, /Delete \$\{name\}/);
  assert.match(html, /Delete \$\{cat\.name\}/);
  assert.match(html, /Delete \$\{modName\}/);
  assert.match(html, /Delete \$\{filename\}/);
});

test('Library update warnings and the convert-to-server menu action are wired', () => {
  assert.match(html, /library-card-update/);
  assert.match(html, /A newer version/);
  assert.match(html, /openLibraryModpackUpdate/);
  assert.match(html, /dismissModpackUpdate\('lock'\)/);
  assert.match(html, /unlockModpackVersion/);
  assert.match(html, /data-action="convert-server"/);
  assert.match(html, /convertInstanceToServer/);
  assert.match(html, /client-only mods stay with the instance/);
});
