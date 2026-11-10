// Browse UI: dropdown filters replace the side rail, clicking a project opens a
// native detail view, and favourites remember which source they came from.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

function extract(pattern, label) {
  const match = renderer.match(pattern);
  assert.ok(match, `${label} exists in the renderer`);
  return match[0];
}

test('Browse uses a dropdown filter bar instead of the old sidebar', () => {
  assert.match(renderer, /class="browse-headbar"/);
  assert.match(renderer, /id="browseTypeMenu"/);
  assert.match(renderer, /class="browse-menu-panel"/);
  assert.doesNotMatch(renderer, /class="browse-sidebar"/);
});

test('project details are fetched and rendered inside the app', () => {
  const detail = extract(/^async function fetchBrowseDetail\(pack\) \{[\s\S]*?^\}/m, 'fetchBrowseDetail()');
  const show = extract(/^async function showPackDetails\(pack\) \{[\s\S]*?^\}/m, 'showPackDetails()');

  assert.match(detail, /api\.modrinth\.com\/v2\/project/);
  assert.match(detail, /api\.curseforgeMod/);
  assert.match(show, /browseDetail/);
  assert.doesNotMatch(show, /window\.open|openExternal/);
  assert.doesNotMatch(renderer, /<webview|<iframe/i);
  assert.match(renderer, /browse-detail-tabs/);
  assert.match(renderer, /id="browseDetailRelease"/);
  assert.match(renderer, /id="browseGalleryLightbox"/);
  assert.match(renderer, /browse-detail-inner browse-source-\$\{sourceClass\}/);
  assert.match(renderer, /browse-detail-banner/);
  assert.match(renderer, /@media \(max-width:1120px\)/);
  assert.match(renderer, /openBrowseGallery\(\$\{index\}, this\)/);
  assert.match(renderer, /#page-browse\.browse-detail-mode > \.browse-topbar/);
  assert.match(renderer, /selectedRelease\?\.downloadUrl/);
  assert.match(renderer, /selectedRelease\?\.id \|\| ''/);
});

test('CurseForge gallery cards use thumbnails and keep the full image for the lightbox', () => {
  const normalise = extract(/^function normaliseCurseForgeDetail\(mod, files, pack\) \{[\s\S]*?^\}/m, 'normaliseCurseForgeDetail()');
  const safeUrl = `function safeBrowseUrl(value, baseUrl) {
    try { const url = new URL(String(value || ''), baseUrl || undefined); return /^https?:$/.test(url.protocol) ? url.href : ''; }
    catch { return ''; }
  }`;
  const context = vm.createContext({
    BROWSE_CF_LOADER_NAMES: { 1: 'Forge', 2: 'Cauldron', 3: 'LiteLoader', 4: 'Fabric', 5: 'Quilt', 6: 'NeoForge' },
    browseType: 'modpack',
    safeBrowseUrl: vm.runInContext(`(${safeUrl})`, vm.createContext({ URL })),
    sanitizeBrowseHtml: value => value,
  });
  vm.runInContext(`${normalise}\nglobalThis.normaliseCurseForgeDetail = normaliseCurseForgeDetail;`, context);

  const detail = vm.runInContext(`normaliseCurseForgeDetail({
    id: 123, name: 'Gallery Pack', screenshots: [
      { url: 'https://media.example/full.png', thumbnailUrl: 'https://media.example/thumb.png', title: 'Preview' },
      { thumbnailUrl: 'https://media.example/thumb-only.png' }
    ]
  }, [], { id: 123, name: 'Gallery Pack', browseType: 'modpack' })`, context);

  assert.equal(detail.gallery[0].url, 'https://media.example/full.png');
  assert.equal(detail.gallery[0].thumbnailUrl, 'https://media.example/thumb.png');
  assert.equal(detail.gallery[1].url, 'https://media.example/thumb-only.png');
  assert.equal(detail.gallery[1].thumbnailUrl, 'https://media.example/thumb-only.png');
  assert.match(renderer, /src="\$\{escAttr\(thumbUrl\)\}"/);
  assert.match(renderer, /data-full-src="\$\{escAttr\(fullUrl\)\}"/);
});

test('project descriptions keep the website Markdown and HTML formatting', () => {
  const escape = extract(/^function escapeBrowseMarkdownText\(text\) \{[\s\S]*?^\}/m, 'escapeBrowseMarkdownText()');
  const inline = extract(/^function browseMarkdownInline\(text\) \{[\s\S]*?^\}/m, 'browseMarkdownInline()');
  const cells = extract(/^function browseTableCells\(line\) \{[\s\S]*?^\}/m, 'browseTableCells()');
  const separator = extract(/^function browseTableSeparator\(line\) \{[\s\S]*?^\}/m, 'browseTableSeparator()');
  const render = extract(/^function renderBrowseMarkdown\(markdown\) \{[\s\S]*?^\}/m, 'renderBrowseMarkdown()');
  const context = vm.createContext({
    escHtml: value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    escAttr: value => String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    safeBrowseUrl: value => { try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.href : ''; } catch { return ''; } },
  });
  vm.runInContext(`${escape}\n${inline}\n${cells}\n${separator}\n${render}\nglobalThis.renderBrowseMarkdown = renderBrowseMarkdown;`, context);

  const output = vm.runInContext("renderBrowseMarkdown('<div align=\"center\"><img src=\"https://example.com/a.png\"></div>\\n\\n| A | B |\\n| --- | --- |\\n| **bold** | value |')", context);
  assert.match(output, /<div align="center"><img src="https:\/\/example\.com\/a\.png"><\/div>/);
  assert.match(output, /<table>/);
  assert.match(output, /<strong>bold<\/strong>/);
  assert.match(renderer, /sanitizeBrowseHtml\(renderBrowseMarkdown\(project\.body\)/);
});

test('favourites are keyed by source and keep enough metadata to render', () => {
  const key = extract(/^function favouriteKey\(pack\) \{[\s\S]*?^\}/m, 'favouriteKey()');
  const normalise = extract(/^function normaliseFavourite\(entry\) \{[\s\S]*?^\}/m, 'normaliseFavourite()');
  const snapshot = extract(/^function favouriteSnapshot\(pack\) \{[\s\S]*?^\}/m, 'favouriteSnapshot()');
  const context = vm.createContext({ browseType: 'modpack' });
  vm.runInContext(`${key}\n${normalise}\n${snapshot}\nglobalThis.favouriteKey = favouriteKey; globalThis.normaliseFavourite = normaliseFavourite; globalThis.favouriteSnapshot = favouriteSnapshot;`, context);

  const legacy = vm.runInContext("normaliseFavourite('sodium')", context);
  assert.equal(legacy.key, 'modrinth:sodium');

  const curseforge = vm.runInContext("normaliseFavourite({ id: 238222, source: 'curseforge', name: 'JEI', browseType: 'mod' })", context);
  assert.equal(curseforge.key, 'curseforge:238222');
  assert.equal(curseforge.source, 'curseforge');

  const saved = vm.runInContext("favouriteSnapshot({ id: 238222, source: 'curseforge', name: 'JEI', author: 'mezz', browseType: 'mod', downloads: 12 })", context);
  assert.equal(saved.key, 'curseforge:238222');
  assert.equal(saved.browseType, 'mod');
  assert.equal(saved.name, 'JEI');
  assert.equal(saved.downloads, 12);
});

test('the release picker defaults to a stable build when one exists', () => {
  const prerelease = extract(/^function browseIsPrerelease\(release\) \{[\s\S]*?^\}/m, 'browseIsPrerelease()');
  const context = vm.createContext({});
  vm.runInContext(`${prerelease}\nglobalThis.browseIsPrerelease = browseIsPrerelease;`, context);

  assert.equal(vm.runInContext("browseIsPrerelease({ name: '15.0.0-beta.3' })", context), true);
  assert.equal(vm.runInContext("browseIsPrerelease({ name: '15.0.0-rc.1' })", context), true);
  assert.equal(vm.runInContext("browseIsPrerelease({ name: '14.1.2' })", context), false);
  assert.match(renderer, /version\.downloadUrl && !browseIsPrerelease\(version\)/);
});

test('browse rows open the native detail view and use source-aware hearts', () => {
  const rows = extract(/^function renderBrowseList\(packs, append = false\) \{[\s\S]*?^\}/m, 'renderBrowseList()');
  assert.match(rows, /row\.onclick = \(\) => showPackDetails\(p\)/);
  assert.match(rows, /isFavourite\(p\)/);
  assert.match(rows, /favouriteKey\(p\)/);
  assert.match(rows, /createBrowseInstallButton\(p\)/);
});