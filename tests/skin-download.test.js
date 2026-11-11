const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { loadApp, plain, projectRoot, withTempRoot } = require('./helpers/electron-app');

const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = renderer.indexOf(startMarker);
  const end = renderer.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} exists before ${endMarker}`);
  return renderer.slice(start, end);
}

function textureProperty(model, skinUrl = 'https://textures.minecraft.net/texture/example') {
  return Buffer.from(JSON.stringify({
    textures: {
      SKIN: {
        url: skinUrl,
        ...(model ? { metadata: { model } } : {}),
      },
    },
  })).toString('base64');
}

function profileRoutes({ model, skinUrl, id = '069a79f444e94726a5befca90e38aaf5' } = {}) {
  return {
    [`https://api.mojang.com/users/profiles/minecraft/Notch`]: { id, name: 'Notch' },
    [`https://sessionserver.mojang.com/session/minecraft/profile/${id}`]: {
      id,
      name: 'Notch',
      properties: [{ name: 'textures', value: textureProperty(model, skinUrl) }],
    },
  };
}

test('the main process resolves a profile skin URL and its slim model', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, {
      routes: profileRoutes({
        model: 'slim',
        skinUrl: 'http://textures.minecraft.net/texture/example',
      }),
    });

    assert.deepEqual(plain(await app.exposed.craftdock.auth.lookupSkin('Notch')), {
      ok: true,
      name: 'Notch',
      skinUrl: 'https://textures.minecraft.net/texture/example',
      model: 'slim',
    });
    assert.deepEqual(app.network.requested, [
      'https://api.mojang.com/users/profiles/minecraft/Notch',
      'https://sessionserver.mojang.com/session/minecraft/profile/069a79f444e94726a5befca90e38aaf5',
    ]);
  });
});

test('a profile without slim metadata is classic and unknown players fail cleanly', async () => {
  await withTempRoot(async root => {
    const classic = loadApp(root, { routes: profileRoutes({}) });
    assert.deepEqual(plain(await classic.exposed.craftdock.auth.lookupSkin('Notch')), {
      ok: true,
      name: 'Notch',
      skinUrl: 'https://textures.minecraft.net/texture/example',
      model: 'classic',
    });

    const missing = loadApp(root, { routes: {} });
    assert.deepEqual(plain(await missing.exposed.craftdock.auth.lookupSkin('MissingPlayer')), {
      ok: false,
      status: 404,
      error: 'not_found',
    });
    assert.equal(missing.network.requested.length, 1, 'the missing player was checked once');
    assert.deepEqual(plain(await missing.exposed.craftdock.auth.lookupSkin('../escape')), {
      ok: false,
      error: 'invalid_username',
    });
    assert.equal(missing.network.requested.length, 1, 'invalid names never reach Mojang');
  });
});

test('Minecraft bottom faces are vertically flipped, head layer included', () => {
  const methods = sliceBetween('  _faceMat(', '  // Dispose resources owned by a character group');
  const sandbox = {
    THREE: {
      MeshLambertMaterial: class {
        constructor(options) { this.map = options.map; }
      },
    },
  };
  vm.runInNewContext(`class Renderer {${methods}}\nglobalThis.renderer = new Renderer();`, sandbox);

  const texture = {
    clone() {
      return {
        repeat: { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } },
        offset: { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } },
      };
    },
  };

  const top = sandbox.renderer._boxMats(texture, [[8, 0, 8, 8]])[0].map;
  const bottom = sandbox.renderer._boxMats(texture, [[16, 0, 8, 8, false, true]])[0].map;
  assert.equal(top.repeat.y, 8 / 64, 'the top keeps its normal orientation');
  assert.equal(top.offset.y, 1 - 8 / 64);
  assert.equal(bottom.repeat.y, -8 / 64, 'the bottom samples upside-down');
  assert.equal(bottom.offset.y, 1, 'the flipped bottom stays inside the 8×8 head crop');

  assert.match(renderer,
    /\[16, 0, 8, 8, false, true\],\s*\/\/ bottom — flipped vertically in Minecraft/,
    'the head bottom face opts into the vertical flip');
  assert.match(renderer,
    /\[48, 0, 8, 8, false, true\],\s*\/\/ bottom — flipped vertically in Minecraft/,
    'the hat bottom face opts into the vertical flip too');
});

test('slim detection mirrors the unused 2px arm strips in a skin PNG', async () => {
  let mode = 'transparent';
  class FakeImage {
    constructor() { this.width = 64; this.height = 64; }
    set src(value) {
      this._src = value;
      queueMicrotask(() => this.onload && this.onload());
    }
  }
  const sandbox = {
    Image: FakeImage,
    document: {
      createElement() {
        return {
          width: 0,
          height: 0,
          getContext() {
            return {
              imageSmoothingEnabled: true,
              drawImage() {},
              getImageData(_x, _y, w, h) {
                const data = new Uint8ClampedArray(w * h * 4);
                for (let i = 0; i < w * h; i++) {
                  const pixel = mode === 'transparent' ? [0, 0, 0, 0]
                    : mode === 'black' ? [0, 0, 0, 255]
                      : mode === 'white' ? [255, 255, 255, 255]
                        : [12, 34, 56, 255];
                  data.set(pixel, i * 4);
                }
                return { data };
              },
            };
          },
        };
      },
    },
  };
  vm.runInNewContext(
    `${sliceBetween('async function inferSkinModel', 'async function resolveDownloadedSkinModel')}
     globalThis.inferSkinModel = inferSkinModel;`,
    sandbox,
  );

  mode = 'transparent';
  assert.equal(await sandbox.inferSkinModel('data:image/png;base64,AA=='), 'slim');
  mode = 'black';
  assert.equal(await sandbox.inferSkinModel('data:image/png;base64,AA=='), 'slim');
  mode = 'white';
  assert.equal(await sandbox.inferSkinModel('data:image/png;base64,AA=='), 'slim');
  mode = 'other';
  assert.equal(await sandbox.inferSkinModel('data:image/png;base64,AA=='), 'classic');
});

test('downloading saves the authoritative model and uses Mojang’s texture URL', async () => {
  const fetches = [];
  const saved = [];
  const notices = [];
  const button = { textContent: '', disabled: false, innerHTML: '' };
  const elements = { skinDownloadSaveBtn: button };
  const sandbox = {
    _skinDownloadPlayerName: 'Alex',
    _skinDownloadInfo: {
      name: 'Alex',
      skinUrl: 'https://textures.minecraft.net/texture/alex',
      model: 'slim',
    },
    _skinDownloadInfoPromise: null,
    document: { getElementById: id => elements[id] || null },
    fetch: async url => {
      fetches.push(url);
      return { ok: true, blob: async () => ({ type: 'image/png' }) };
    },
    FileReader: class {
      readAsDataURL() {
        this.result = 'data:image/png;base64,AAAA';
        this.onload();
      }
    },
    saveSkinToLibrary: async (...args) => { saved.push(args); },
    showNotif: (...args) => notices.push(args),
    clearSkinDownloadPreview() {},
    setTimeout() {},
    skinModelLabel: model => model === 'slim' ? 'Slim' : 'Classic',
    resolveDownloadedSkinModel: async (_dataUrl, model) => model,
  };
  vm.runInNewContext(
    `${sliceBetween('async function savePlayerSkin', 'async function saveSkinToLibrary(name, dataUrl')}
     globalThis.savePlayerSkin = savePlayerSkin;`,
    sandbox,
  );

  await sandbox.savePlayerSkin();

  assert.deepEqual(fetches, ['https://textures.minecraft.net/texture/alex']);
  assert.deepEqual(saved, [[
    "Alex's skin",
    'data:image/png;base64,AAAA',
    'slim',
  ]]);
  assert.ok(notices.some(([, message]) => message.includes('Slim model')));
});

test('without profile metadata the downloaded PNG decides classic vs slim', async () => {
  const fetches = [];
  const saved = [];
  const resolved = [];
  const elements = { skinDownloadSaveBtn: { textContent: '', disabled: false, innerHTML: '' } };
  const sandbox = {
    _skinDownloadPlayerName: 'Stevie',
    _skinDownloadInfo: null,
    _skinDownloadInfoPromise: Promise.resolve(null),
    document: { getElementById: id => elements[id] || null },
    fetch: async url => {
      fetches.push(url);
      return { ok: true, blob: async () => ({ type: 'image/png' }) };
    },
    FileReader: class {
      readAsDataURL() {
        this.result = 'data:image/png;base64,BBBB';
        this.onload();
      }
    },
    saveSkinToLibrary: async (...args) => { saved.push(args); },
    showNotif() {},
    clearSkinDownloadPreview() {},
    setTimeout() {},
    skinModelLabel: model => model === 'slim' ? 'Slim' : 'Classic',
    resolveDownloadedSkinModel: async (dataUrl, model) => {
      resolved.push([dataUrl, model]);
      return 'slim';
    },
  };
  vm.runInNewContext(
    `${sliceBetween('async function savePlayerSkin', 'async function saveSkinToLibrary(name, dataUrl')}
     globalThis.savePlayerSkin = savePlayerSkin;`,
    sandbox,
  );

  await sandbox.savePlayerSkin();

  assert.deepEqual(fetches, ['https://mc-heads.net/skin/Stevie']);
  assert.deepEqual(resolved, [['data:image/png;base64,BBBB', undefined]]);
  assert.deepEqual(saved, [["Stevie's skin", 'data:image/png;base64,BBBB', 'slim']]);
});
