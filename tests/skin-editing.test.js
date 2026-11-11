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

test('saving can turn a live texture URL into a PNG data URL', async () => {
  const fetches = [];
  class FakeFileReader {
    readAsDataURL() {
      this.result = 'data:image/png;base64,AQID';
      if (this.onload) this.onload();
    }
  }
  const sandbox = {
    Blob,
    FileReader: FakeFileReader,
    fetch: async url => {
      fetches.push(url);
      return {
        ok: true,
        blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      };
    },
  };
  vm.runInNewContext(
    `${sliceBetween('async function resolveSkinDataUrl', '\nasync function saveSkin')}\nglobalThis.resolveSkinDataUrl = resolveSkinDataUrl;`,
    sandbox,
  );

  const remote = 'https://textures.minecraft.net/texture/active';
  assert.equal(await sandbox.resolveSkinDataUrl(remote), 'data:image/png;base64,AQID');
  const inline = 'data:image/png;base64,AAAA';
  assert.equal(await sandbox.resolveSkinDataUrl(inline), inline);
  assert.deepEqual(fetches, [remote]);
  await assert.rejects(() => sandbox.resolveSkinDataUrl(''), /No skin image/);
});

test('saving a loaded library skin updates that entry instead of creating a duplicate', async () => {
  const saved = [];
  const notices = [];
  const resolves = [];
  const elements = {
    skinNameInput: { value: 'Renamed Outfit' },
    saveModelSlim: { classList: { contains: () => false } },
    skinCount: { textContent: '' },
    previewSkinName: { textContent: '' },
    previewSkinMeta: { textContent: '' },
  };
  const existing = {
    id: 'skin_existing',
    name: 'Old Name',
    model: 'classic',
    addedAt: 111,
    dataUrl: 'data:image/png;base64,OLD',
    cape: null,
  };
  const outfitCape = {
    id: 'cape-1',
    alias: 'Migrator',
    name: 'Migrator Cape',
    url: 'https://textures.minecraft.net/texture/cape',
  };
  const sandbox = {
    document: { getElementById: id => elements[id] || null },
    pendingSkinDataUrl: 'https://textures.minecraft.net/texture/active',
    pendingSkinKind: 'library',
    editingSkinId: 'skin_existing',
    outfitCapeSnapshot: () => outfitCape,
    resolveSkinDataUrl: async source => {
      resolves.push(source);
      return 'data:image/png;base64,NEW';
    },
    SkinStore: {
      getAll: async () => [existing],
      save: async skin => { saved.push(skin); },
    },
    refreshSkinGrid: async () => {},
    closeSkinNameModal: () => {},
    showNotif: (...args) => notices.push(args),
  };
  vm.runInNewContext(
    `${sliceBetween('async function saveSkin', '\nasync function applySkin')}\nglobalThis.saveSkin = saveSkin;`,
    sandbox,
  );

  await sandbox.saveSkin();

  assert.equal(saved.length, 1);
  const skin = plain(saved[0]);
  assert.equal(skin.id, 'skin_existing');
  assert.equal(skin.addedAt, 111);
  assert.equal(skin.name, 'Renamed Outfit');
  assert.equal(skin.dataUrl, 'data:image/png;base64,NEW');
  assert.deepEqual(skin.cape, outfitCape);
  assert.deepEqual(resolves, ['https://textures.minecraft.net/texture/active']);
  assert.equal(sandbox.pendingSkinDataUrl, 'data:image/png;base64,NEW');
  assert.equal(sandbox.pendingSkinKind, 'library');
  assert.equal(sandbox.editingSkinId, 'skin_existing');
  assert.ok(notices.some(([title]) => title === 'Outfit Updated'));
});

test('saving the live active skin creates a library entry and keeps editing it', async () => {
  const saved = [];
  const notices = [];
  const elements = {
    skinNameInput: { value: 'Live Skin' },
    saveModelSlim: { classList: { contains: () => false } },
    skinCount: { textContent: '' },
    previewSkinName: { textContent: '' },
    previewSkinMeta: { textContent: '' },
  };
  const sandbox = {
    document: { getElementById: id => elements[id] || null },
    pendingSkinDataUrl: 'https://textures.minecraft.net/texture/active',
    pendingSkinKind: 'active',
    editingSkinId: null,
    outfitCapeSnapshot: () => null,
    resolveSkinDataUrl: async () => 'data:image/png;base64,NEW',
    SkinStore: {
      getAll: async () => saved,
      save: async skin => { saved.push(skin); },
    },
    refreshSkinGrid: async () => {},
    closeSkinNameModal: () => {},
    showNotif: (...args) => notices.push(args),
  };
  vm.runInNewContext(
    `${sliceBetween('async function saveSkin', '\nasync function applySkin')}\nglobalThis.saveSkin = saveSkin;`,
    sandbox,
  );

  await sandbox.saveSkin();

  assert.equal(saved.length, 1);
  const skin = plain(saved[0]);
  assert.match(skin.id, /^skin_\d+$/);
  assert.equal(skin.name, 'Live Skin');
  assert.equal(skin.dataUrl, 'data:image/png;base64,NEW');
  assert.equal(sandbox.pendingSkinDataUrl, 'data:image/png;base64,NEW');
  assert.equal(sandbox.pendingSkinKind, 'library');
  assert.equal(sandbox.editingSkinId, skin.id);
  assert.ok(notices.some(([title]) => title === 'Skin Saved'));
});

test('loading a saved skin marks it for update while a file upload starts a new entry', () => {
  const apply = sliceBetween('async function applySkin', '\nasync function deleteSkin');
  assert.match(apply, /pendingSkinKind = 'library';[\s\S]*?editingSkinId = skin\.id;/,
    'clicking a saved skin selects that entry for editing');
  const file = sliceBetween('function handleSkinFile', '\nfunction handleSkinDrop');
  assert.match(file, /pendingSkinKind = 'file';[\s\S]*?editingSkinId = null;/,
    'a newly uploaded PNG is not forced onto an existing library entry');
  const modal = sliceBetween('async function openSkinNameModal', '\nfunction closeSkinNameModal');
  assert.match(modal, /const existing = skins\.find\(s => s\.id === editingSkinId\);/,
    'the save dialog reads the loaded entry');
  assert.match(modal, /nameInput\.value = name/,
    'the loaded entry name is prefilled for editing');
  assert.match(renderer, /pendingSkinDataUrl = skin\.url;[\s\S]*?pendingSkinKind = 'active';[\s\S]*?editingSkinId = null;/,
    'the live profile skin is savable but is not an existing library entry');
});
