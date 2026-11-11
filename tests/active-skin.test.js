const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { plain, projectRoot } = require('./helpers/electron-app');

const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = renderer.indexOf(startMarker);
  const end = renderer.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} exists before ${endMarker}`);
  return renderer.slice(start, end);
}

test('the active profile skin is the ACTIVE entry with a texture URL', () => {
  const sandbox = {};
  vm.runInNewContext(
    `${sliceBetween('function getActiveProfileSkin', '\nfunction renderActiveSkin')}\nglobalThis.getActiveProfileSkin = getActiveProfileSkin;`,
    sandbox,
  );

  const active = {
    id: 'skin-active',
    state: 'ACTIVE',
    url: 'https://textures.minecraft.net/texture/active',
    variant: 'SLIM',
  };
  assert.deepEqual(
    plain(sandbox.getActiveProfileSkin({
      skins: [
        { id: 'skin-old', state: 'INACTIVE', url: 'https://textures.minecraft.net/texture/old' },
        active,
      ],
    })),
    active,
  );
  assert.equal(sandbox.getActiveProfileSkin({
    skins: [{ id: 'skin-old', state: 'INACTIVE', url: 'https://textures.minecraft.net/texture/old' }],
  }), null);
  assert.equal(sandbox.getActiveProfileSkin({ skins: [{ state: 'ACTIVE', url: '' }] }), null);
  assert.equal(sandbox.getActiveProfileSkin(null), null);
});

test('rendering the active skin loads its URL and model variant', () => {
  const calls = [];
  const classCalls = [];
  const elements = {
    modelClassic: { classList: { toggle: (name, on) => classCalls.push(['classic', name, on]) } },
    modelSlim: { classList: { toggle: (name, on) => classCalls.push(['slim', name, on]) } },
    previewSkinName: { textContent: '' },
    previewSkinMeta: { textContent: '' },
  };
  const sandbox = {
    mainRenderer: {
      setSlim: value => calls.push(['setSlim', value]),
      loadFromUrl: url => calls.push(['loadFromUrl', url]),
      loadDefaultSteve: () => calls.push(['default']),
    },
    document: { getElementById: id => elements[id] || null },
    pendingSkinDataUrl: 'local-selection',
    pendingSkinKind: 'file',
    editingSkinId: 'skin-local',
  };
  vm.runInNewContext(
    `${sliceBetween('function renderActiveSkin', '\nasync function initSkinManager')}\nglobalThis.renderActiveSkin = renderActiveSkin;`,
    sandbox,
  );

  const skinUrl = 'https://textures.minecraft.net/texture/active';
  assert.equal(sandbox.renderActiveSkin({ url: skinUrl, variant: 'SLIM' }, { name: 'Alex' }), true);
  assert.deepEqual(calls, [['setSlim', true], ['loadFromUrl', skinUrl]]);
  assert.deepEqual(classCalls, [['classic', 'active', false], ['slim', 'active', true]]);
  assert.equal(elements.previewSkinName.textContent, 'Alex');
  assert.match(elements.previewSkinMeta.textContent, /Slim model .* Active skin/);
  assert.equal(sandbox.pendingSkinDataUrl, skinUrl, 'the live skin becomes savable');
  assert.equal(sandbox.pendingSkinKind, 'active');
  assert.equal(sandbox.editingSkinId, null, 'the live skin is not an existing library entry');

  calls.length = 0;
  classCalls.length = 0;
  sandbox.pendingSkinDataUrl = 'local-selection';
  sandbox.pendingSkinKind = 'file';
  sandbox.editingSkinId = 'skin-local';
  assert.equal(sandbox.renderActiveSkin(null, { name: 'Alex' }), false);
  assert.deepEqual(calls, [['setSlim', false], ['default']]);
  assert.deepEqual(classCalls, [['classic', 'active', true], ['slim', 'active', false]]);
  assert.equal(elements.previewSkinName.textContent, 'Alex');
  assert.equal(elements.previewSkinMeta.textContent, 'No active skin found');
  assert.equal(sandbox.pendingSkinDataUrl, 'local-selection', 'a local selection is not discarded when no active skin exists');
  assert.equal(sandbox.pendingSkinKind, 'file');
  assert.equal(sandbox.editingSkinId, 'skin-local');
});

test('the skins page and profile refresh feed the active skin into the preview', () => {
  assert.match(renderer, /async function initSkinManager\(\)[\s\S]*?const acct = await AccountStore\.getActive\(\);[\s\S]*?renderActiveSkin\(getActiveProfileSkin\(acct\), acct\);/,
    'opening the skins page starts from the account skin instead of Steve');
  assert.match(renderer, /async function syncActiveCape\(\)[\s\S]*?if \(!hasLocalSkinSelection\(\)\) renderActiveSkin\(getActiveProfileSkin\(acct\), acct\);/,
    'the cached profile skin paints before the network request');
  assert.match(renderer, /acct\.skins = profile\.skins;[\s\S]*?if \(!hasLocalSkinSelection\(\)\) renderActiveSkin\(getActiveProfileSkin\(acct\), acct\);/,
    'a fresh profile skin updates the preview without replacing a local selection');
  assert.match(renderer, /loadFromUrl\(url\)[\s\S]*?this\._skinRequest/,
    'remote skin URLs load through the renderer and stale loads are discarded');
  assert.match(renderer, /loadFromDataUrl\(dataUrl\) \{ this\.loadFromUrl\(dataUrl\); \}/,
    'saved skins still use the existing data-URL entry point');
  assert.match(renderer, /async function setActiveAccount\(id\)[\s\S]*?pendingSkinDataUrl = null;[\s\S]*?renderActiveSkin\(getActiveProfileSkin\(acct\), acct\);/,
    'switching accounts refreshes the preview for the newly active account');
});
