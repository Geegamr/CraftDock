const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, plain, withTempRoot, writeInstance } = require('./helpers/electron-app');

test('the screenshot lightbox close control does not fall through to the backdrop', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  const overlay = html.match(/<div id="screenshotLightbox"[^>]*>/)?.[0];
  assert.ok(overlay, 'the screenshot lightbox exists');
  assert.match(overlay, /event\.target === this/);
  // The controls overlap the frameless titlebar's drag strip, and Electron's
  // drag region swallows clicks regardless of the overlay's z-index.
  assert.match(overlay, /-webkit-app-region:no-drag/);

  const close = html.match(/<button[^>]*onclick="event\.stopPropagation\(\);closeLightbox\(\)"[^>]*>✕ Close<\/button>/)?.[0];
  assert.ok(close, 'the close button has its own handler');
  assert.match(close, /type="button"/);
  assert.match(close, /aria-label="Close screenshot"/);
  assert.match(html, /top:16px;right:16px;display:flex;gap:8px;z-index:20/);
});

test('screenshot thumbnails are downscaled while full reads stay original', async () => {
  await withTempRoot(async root => {
    const source = Buffer.from('full-resolution-png-bytes');
    const thumbBytes = Buffer.from('thumbnail-jpeg-bytes');
    const resizeCalls = [];
    const jpegQualities = [];
    const decoded = [];
    const nativeImage = {
      createFromPath: () => ({ isEmpty: () => true }),
      createFromBuffer(data) {
        decoded.push(Buffer.from(data));
        return {
          isEmpty: () => false,
          getSize: () => ({ width: 1920, height: 1080 }),
          resize(options) {
            resizeCalls.push(options);
            return { toJPEG: quality => { jpegQualities.push(quality); return thumbBytes; } };
          },
          toJPEG(quality) {
            jpegQualities.push(quality);
            return thumbBytes;
          },
        };
      },
    };

    const app = loadApp(root, { nativeImage });
    const dir = writeInstance(app, 'inst_shot');
    const shotPath = path.join(dir, 'screenshots', 'shot.png');
    fs.mkdirSync(path.dirname(shotPath), { recursive: true });
    fs.writeFileSync(shotPath, source);

    const thumb = plain(await app.exposed.craftdockInstance.readScreenshot(shotPath, { thumbnail: true }));
    assert.deepEqual(thumb, {
      success: true,
      dataUrl: `data:image/jpeg;base64,${thumbBytes.toString('base64')}`,
    });
    assert.deepEqual(plain(resizeCalls), [{ width: 480, height: 270, quality: 'good' }]);
    assert.deepEqual(jpegQualities, [82]);
    assert.deepEqual(decoded, [source]);

    const full = plain(await app.exposed.craftdockInstance.readScreenshot(shotPath));
    assert.deepEqual(full, {
      success: true,
      dataUrl: `data:image/png;base64,${source.toString('base64')}`,
    });
    assert.equal(resizeCalls.length, 1, 'full-resolution reads must not be resized');
    assert.equal(decoded.length, 1, 'full-resolution reads must not decode an image');
  });
});
