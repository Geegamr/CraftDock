// A skins.json is tiny compared with what it can ask for: every entry names an
// image that is read and base64-encoded, so N entries pointing at one large file
// ask for that file N times over. A 10 KB metadata file plus one 4 MB image used
// to produce 533 MB of output and ~1 GB of RSS in ~16 s. The helper now encodes
// each distinct image once and refuses to build a response above its render
// budget, and the app path must surface that refusal instead of hydrating the
// same library entry by entry in JavaScript.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSkinLibraryAccess, getAllFallback } = require('../skin-library');
const { projectRoot } = require('./helpers/electron-app');

const access = createSkinLibraryAccess({
  isPackaged: false,
  appDir: projectRoot,
  resourcesPath: projectRoot,
  platform: process.platform,
});

async function withLibrary(build, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-skins-'));
  try {
    build(directory);
    return await callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function writeMetadata(directory, entries) {
  fs.writeFileSync(path.join(directory, 'skins.json'), JSON.stringify(entries));
}

test('a tiny metadata file cannot multiply one image into hundreds of megabytes', async () => {
  await withLibrary(
    directory => {
      const image = path.join(directory, 'big.png');
      fs.writeFileSync(image, Buffer.alloc(4 * 1024 * 1024, 7));
      writeMetadata(directory, Array.from({ length: 100 }, (_, index) => ({
        id: `s${index}`,
        name: `Skin ${index}`,
        filePath: image,
      })));
      assert.ok(fs.statSync(path.join(directory, 'skins.json')).size < 16 * 1024);
    },
    async directory => {
      const started = Date.now();
      await assert.rejects(access.getAll(directory), /render budget/i);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 5000, `the hostile library took ${elapsed}ms to reject`);
    },
  );
});

test('the JavaScript fallback is bounded too, not a slower repeat', async () => {
  await withLibrary(
    directory => {
      const image = path.join(directory, 'big.png');
      fs.writeFileSync(image, Buffer.alloc(4 * 1024 * 1024, 7));
      writeMetadata(directory, Array.from({ length: 100 }, (_, index) => ({
        id: `s${index}`,
        filePath: image,
      })));
    },
    async directory => {
      const started = Date.now();
      assert.throws(() => getAllFallback(directory), /render budget/i);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 5000, `the fallback took ${elapsed}ms to reject`);
    },
  );
});

test('an ordinary library still hydrates identically', async () => {
  await withLibrary(
    directory => {
      const entries = [0, 1, 2].map(index => {
        const image = path.join(directory, `s${index}.png`);
        fs.writeFileSync(image, Buffer.alloc(20 * 1024, index + 1));
        return { id: `s${index}`, name: `Legit ${index}`, filePath: image };
      });
      writeMetadata(directory, entries);
    },
    async directory => {
      const skins = await access.getAll(directory);
      assert.equal(skins.length, 3);
      for (const [index, skin] of skins.entries()) {
        assert.equal(skin.id, `s${index}`);
        assert.equal(skin.name, `Legit ${index}`);
        assert.ok(skin.dataUrl.startsWith('data:image/png;base64,'));
        assert.equal(
          Buffer.from(skin.dataUrl.split(',')[1], 'base64').length,
          20 * 1024,
        );
      }
      // The JavaScript path must agree byte for byte.
      assert.deepEqual(getAllFallback(directory), skins);
    },
  );
});

test('one large legitimate skin is still inside the budget', async () => {
  await withLibrary(
    directory => {
      const image = path.join(directory, 'large.png');
      fs.writeFileSync(image, Buffer.alloc(40 * 1024 * 1024, 3));
      writeMetadata(directory, [{ id: 'large', name: 'Large', filePath: image }]);
    },
    async directory => {
      const skins = await access.getAll(directory);
      assert.equal(skins.length, 1);
      // A 40 MiB image encodes to ~53 MiB, which must not be clipped.
      assert.equal(
        Buffer.from(skins[0].dataUrl.split(',')[1], 'base64').length,
        40 * 1024 * 1024,
      );
    },
  );
});
