const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadApp, plain, withTempRoot, writeInstance } = require('./helpers/electron-app');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const galleryScript = fs.readFileSync(path.join(root, 'src', 'gallery.js'), 'utf8');

test('the rail is wider and stacks the top-three most played packs vertically', () => {
  assert.match(html, /\.icon-rail\{width:81\.9px/);
  assert.match(html, /\.rail-top-list\{[^}]*flex-direction:column/);
  assert.match(html, /\.rail-btn\{width:46\.2px;height:46\.2px/);
  assert.match(html, /\.rail-pack\{[^}]*width:47\.586px[^}]*height:47\.586px[^}]*padding:0/);
  assert.match(html, /\.rail-pack\{[^}]*background:transparent/);
  assert.match(html, /\.rail-pack-icon\{[^}]*width:100%[^}]*height:100%/);
  assert.match(html, /\.rail-pack:hover[^}]*transform:scale/);
  assert.match(html, /\.rail-top\{[^}]*padding:4px 7px 8px/);
  assert.doesNotMatch(html, /rail-pack-rank|rail-top-label/);
  assert.doesNotMatch(galleryScript, /rail-pack-rank|TOP 3/);
  assert.match(html, /id="railTopPacks"/);
  assert.match(html, /id="railTopList"/);
  const rail = html.slice(html.indexOf('<div class="icon-rail">'), html.indexOf('<div class="main-content">'));
  assert.ok(rail.indexOf('rail-spacer') < rail.indexOf('railTopPacks'), 'the top-three block sits below the flexible spacer');
  assert.ok(rail.indexOf('railTopPacks') < rail.indexOf('consolRailBtn'), 'the top-three block sits directly above Console');
  assert.match(html, /renderRailTopPacks\(allInstances\)/);
  assert.match(galleryScript, /\.slice\(0, 3\)/);
  assert.match(galleryScript, /totalPlayMinutes/);
});

test('the gallery is one newest-first stream with directly loaded thumbnails and editor tools', () => {
  assert.match(html, /id="page-gallery"/);
  assert.match(html, /id="galleryItems"/);
  assert.match(html, /\.gallery-grid\{[^}]*width:100%;margin:0\}/);
  assert.doesNotMatch(html, /\.gallery-grid\{[^}]*max-width:1400px/);
  assert.match(html, /Every screenshot, newest first\./);
  assert.doesNotMatch(html, /gallery-group/);
  assert.match(html, /if \(name==='gallery'\) loadGalleryPage\(\)/);
  assert.match(html, /<script src="gallery\.js"><\/script>/);
  assert.match(html, /id="galleryViewer"/);
  assert.match(html, /id="galleryEditor"/);
  for (const tool of ['crop', 'pen', 'highlight', 'rect', 'ellipse', 'arrow']) {
    assert.match(html, new RegExp(`data-gallery-tool="${tool}"`));
  }
  assert.match(galleryScript, /function loadGalleryPage/);
  assert.match(galleryScript, /const GALLERY_AUTO_REFRESH_MS = 4000/);
  assert.match(galleryScript, /function startGalleryAutoRefresh/);
  assert.match(galleryScript, /setInterval\(/);
  assert.match(galleryScript, /loadGalleryPage\(\{ silent: true \}\)/);
  assert.match(galleryScript, /galleryItemsSignature/);
  assert.match(galleryScript, /items\.sort\(\(a, b\) => b\.takenAt - a\.takenAt/);
  assert.match(galleryScript, /galleryFileTimestamp\(file\)/);
  assert.match(galleryScript, /function loadGalleryThumbnails/);
  assert.match(galleryScript, /image\.src = response\.dataUrl/);
  assert.match(galleryScript, /getElementById\('galleryItems'\)/);
  assert.doesNotMatch(galleryScript, /galleryGroups|IntersectionObserver|_galleryGroups|toggleGalleryGroup/);
  assert.match(galleryScript, /function openGalleryViewer/);
  assert.match(galleryScript, /function applyGalleryCrop/);
  assert.match(galleryScript, /function saveGalleryEditor/);
  assert.match(galleryScript, /saveScreenshotCopy/);
});

test('gallery timestamps come from Minecraft screenshot names and fall back to file time', () => {
  const context = { document: { addEventListener() {} } };
  vm.createContext(context);
  vm.runInContext(galleryScript, context);
  const captured = new Date(2026, 10, 7, 14, 32, 5).getTime();

  assert.equal(context.galleryFileTimestamp({ name: '2026-11-07_14.32.05.png', mtime: 123 }), captured);
  assert.equal(context.galleryFileTimestamp({ name: '2026-11-07_14.32.05-edited-1700000000000.png', mtime: 123 }), captured);
  assert.equal(context.galleryFileTimestamp({ name: 'screenshot.png', mtime: 123 }), 123);
  assert.equal(context.galleryFileTimestamp({ name: '2026-13-40_25.99.99.png', mtime: 123 }), 123);
  assert.equal(context.galleryDateLabel(captured), 'Nov, 07 26');
  assert.equal(context.galleryTimeLabel(captured), '14:32');
});

test('gallery change detection notices new screenshots and ignores identical scans', () => {
  const context = { document: { addEventListener() {} } };
  vm.createContext(context);
  vm.runInContext(galleryScript, context);
  const item = {
    instance: { id: 'pack-1', name: 'Pack' },
    file: { name: '2026-11-07_14.32.05.png', path: '/shots/shot.png', size: 100, mtime: 200 },
    takenAt: 300,
  };

  assert.equal(context.galleryItemsSignature([item]), context.galleryItemsSignature([{ ...item }]));
  assert.notEqual(context.galleryItemsSignature([item]), context.galleryItemsSignature([{
    ...item,
    file: { ...item.file, path: '/shots/new.png', size: 101 },
  }]));
});

test('edited screenshots are saved as a new copy and cannot escape the instance folder', async () => {
  await withTempRoot(async tempRoot => {
    const app = loadApp(tempRoot);
    const instanceDir = writeInstance(app, 'inst_gallery');
    const screenshotsDir = path.join(instanceDir, 'screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });
    const sourcePath = path.join(screenshotsDir, 'shot.png');
    const sourceBytes = Buffer.from('original screenshot');
    fs.writeFileSync(sourcePath, sourceBytes);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

    const saved = plain(await app.exposed.craftdockInstance.saveScreenshotCopy('inst_gallery', sourcePath, dataUrl));
    assert.equal(saved.success, true, saved.error);
    assert.notEqual(saved.path, sourcePath);
    assert.match(path.basename(saved.path), /^shot-edited-\d+(?:-\d+)?\.png$/);
    assert.deepEqual(fs.readFileSync(saved.path), png);
    assert.deepEqual(fs.readFileSync(sourcePath), sourceBytes, 'the original is never overwritten');

    const outsidePath = path.join(tempRoot, 'outside.png');
    fs.writeFileSync(outsidePath, png);
    const outside = plain(await app.exposed.craftdockInstance.saveScreenshotCopy('inst_gallery', outsidePath, dataUrl));
    assert.equal(outside.success, false);
    assert.match(outside.error, /outside this instance/i);

    const wrongType = plain(await app.exposed.craftdockInstance.saveScreenshotCopy(
      'inst_gallery', sourcePath, `data:image/jpeg;base64,${png.toString('base64')}`
    ));
    assert.equal(wrongType.success, false);
    assert.match(wrongType.error, /must be a PNG/i);
  });
});
