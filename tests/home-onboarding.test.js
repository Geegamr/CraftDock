const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');

function extract(pattern, label) {
  const match = html.match(pattern);
  assert.ok(match, `${label} is missing`);
  return match[0];
}

test('Home shows onboarding only before the first account, instance and play session', () => {
  const gate = extract(
    /^function shouldShowHomeOnboarding\(accounts, instances, totalPlayMinutes\) \{[\s\S]*?^\}/m,
    'shouldShowHomeOnboarding()',
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(gate, context);

  assert.equal(context.shouldShowHomeOnboarding([], [], 0), true);
  assert.equal(context.shouldShowHomeOnboarding([{ id: 'acct' }], [], 0), false);
  assert.equal(context.shouldShowHomeOnboarding([], [{ id: 'inst' }], 0), false);
  assert.equal(context.shouldShowHomeOnboarding([], [], 5), false);

  const home = html.slice(html.indexOf('<div class="page active" id="page-home">'), html.indexOf('<!-- ── INSTANCES ── -->'));
  assert.match(home, /id="homeOnboarding"[^>]*hidden/);
  assert.match(home, /id="homeRegular"/);
  assert.ok(home.indexOf('id="homeOnboarding"') < home.indexOf('id="homeRegular"'), 'onboarding comes before the regular home');
  assert.match(home, /id="homePopularPacks"/);
  assert.match(home, /Popular modpacks/);

  const refresh = extract(/^async function refreshHomePage\(\) \{[\s\S]*?^\}/m, 'refreshHomePage()');
  assert.match(refresh, /shouldShowHomeOnboarding\(accounts, instances, totalMinsAll\)/);
  assert.match(refresh, /onboarding\.hidden = !showOnboarding/);
  assert.match(refresh, /regular\.hidden = showOnboarding/);
  assert.match(refresh, /if \(showOnboarding\) \{[\s\S]*?loadHomePopularPacks\(\)[\s\S]*?return;/);
});

test('popular Home rows load four Modrinth packs then four CurseForge packs', async () => {
  const source = [
    extract(/^async function fetchHomeModrinthPacks\(\) \{[\s\S]*?^\}/m, 'fetchHomeModrinthPacks()'),
    extract(/^async function fetchHomeCurseForgePacks\(\) \{[\s\S]*?^\}/m, 'fetchHomeCurseForgePacks()'),
    extract(/^async function fetchHomePopularPacks\(\) \{[\s\S]*?^\}/m, 'fetchHomePopularPacks()'),
  ].join('\n');
  let requested = '';
  const curseForgeCalls = [];
  const context = {
    APP_VERSION: '0.10.0',
    URLSearchParams,
    resourceApi: () => ({
      curseforgeSearch: async (...args) => {
        curseForgeCalls.push(args);
        return {
          success: true,
          data: Array.from({ length: 4 }, (_, index) => ({
            id: 900 + index,
            name: `CurseForge Pack ${index + 1}`,
            summary: 'A pack from CurseForge.',
            downloadCount: 900000 - index,
            authors: [{ name: 'CF Author' }],
            logo: { thumbnailUrl: `https://cdn.example/cf-${index}.png` },
            slug: `cf-pack-${index}`,
            latestFilesIndexes: [
              { gameVersion: '1.21.1', modLoader: 4 },
              { gameVersion: '1.20.1', modLoader: 1 },
            ],
          })),
        };
      },
    }),
    fetch: async url => {
      requested = String(url);
      return {
        ok: true,
        json: async () => ({
          hits: Array.from({ length: 4 }, (_, index) => ({
            project_id: `modrinth_pack_${index}`,
            title: `Modrinth Pack ${index + 1}`,
            author: 'MR Author',
            description: 'A pack from Modrinth.',
            icon_url: `https://cdn.example/mr-${index}.png`,
            downloads: 1200000 - index,
            versions: ['1.21.1'],
            loaders: ['fabric'],
            game_versions: ['1.21.1'],
            slug: `modrinth-pack-${index}`,
          })),
        }),
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  const result = await context.fetchHomePopularPacks();
  const url = new URL(requested);
  assert.equal(url.origin + url.pathname, 'https://api.modrinth.com/v2/search');
  assert.deepEqual(JSON.parse(url.searchParams.get('facets')), [['project_type:modpack']]);
  assert.equal(url.searchParams.get('index'), 'downloads');
  assert.equal(url.searchParams.get('limit'), '4');
  assert.deepEqual(curseForgeCalls[0], ['', '', '', 4471, 2, 0, 4]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.packs.length, 8);
  assert.deepEqual(Array.from(result.packs, pack => pack.source), [
    'modrinth', 'modrinth', 'modrinth', 'modrinth',
    'curseforge', 'curseforge', 'curseforge', 'curseforge',
  ]);
  assert.equal(result.packs[0].browseType, 'modpack');
  assert.equal(result.packs[0].name, 'Modrinth Pack 1');
  assert.deepEqual(Array.from(result.packs[0].loaders), ['fabric']);
  assert.deepEqual(Array.from(result.packs[0].mcVersions), ['1.21.1']);
  assert.equal(result.packs[4].name, 'CurseForge Pack 1');
  assert.deepEqual(Array.from(result.packs[4].loaders), ['fabric', 'forge']);
  assert.deepEqual(Array.from(result.packs[4].mcVersions), ['1.21.1', '1.20.1']);
});

test('a CurseForge failure keeps the Modrinth row visible', async () => {
  const source = [
    extract(/^async function fetchHomeModrinthPacks\(\) \{[\s\S]*?^\}/m, 'fetchHomeModrinthPacks()'),
    extract(/^async function fetchHomeCurseForgePacks\(\) \{[\s\S]*?^\}/m, 'fetchHomeCurseForgePacks()'),
    extract(/^async function fetchHomePopularPacks\(\) \{[\s\S]*?^\}/m, 'fetchHomePopularPacks()'),
  ].join('\n');
  const context = {
    APP_VERSION: '0.10.0',
    URLSearchParams,
    resourceApi: () => ({
      curseforgeSearch: async () => ({ success: false, error: 'CurseForge API key is not configured' }),
    }),
    fetch: async () => ({
      ok: true,
      json: async () => ({ hits: [{ project_id: 'pack_1', title: 'Modrinth Pack', slug: 'pack-1' }] }),
    }),
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  const result = await context.fetchHomePopularPacks();
  assert.equal(result.packs.length, 1);
  assert.equal(result.packs[0].source, 'modrinth');
  assert.match(result.errors[0], /^CurseForge: CurseForge API key is not configured$/);
});

test('popular pack cards render an install action through the existing install path', () => {
  const formatter = extract(
    /^function formatHomePackDownloads\(value\) \{[\s\S]*?^\}/m,
    'formatHomePackDownloads()',
  );
  const render = extract(
    /^function renderHomePopularPacks\(packs, errors = \[\]\) \{[\s\S]*?^\}/m,
    'renderHomePopularPacks()',
  );
  const grid = { innerHTML: '' };
  const context = {
    document: { getElementById: id => id === 'homePopularPacks' ? grid : null },
    escAttr: value => String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    escHtml: value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    defaultPackIcon: () => '<svg data-pack-icon></svg>',
  };
  vm.createContext(context);
  vm.runInContext(`${formatter}\n${render}`, context);

  context.renderHomePopularPacks([{
    name: 'Popular Pack',
    author: 'Pack Author',
    description: 'A pack people play.',
    iconUrl: 'https://cdn.example/icon.png',
    downloads: 1200000,
    source: 'curseforge',
  }]);

  assert.match(grid.innerHTML, /Popular Pack/);
  assert.match(grid.innerHTML, /Pack Author/);
  assert.match(grid.innerHTML, /1\.2M downloads/);
  assert.match(grid.innerHTML, /home-pack-source curseforge/);
  assert.match(grid.innerHTML, /CurseForge/);
  assert.match(grid.innerHTML, /installHomePopularPack\(0, this\)/);

  assert.match(html, /\.home-popular-grid\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);

  const install = extract(
    /^function installHomePopularPack\(index, btn\) \{[\s\S]*?^\}/m,
    'installHomePopularPack()',
  );
  let installed = null;
  const installContext = {
    _homePopularPacks: [{ name: 'CurseForge Pick', source: 'curseforge' }],
    installPack: (pack, btn) => { installed = { pack, btn }; return 'started'; },
  };
  vm.createContext(installContext);
  vm.runInContext(install, installContext);
  const button = {};
  assert.equal(installContext.installHomePopularPack(0, button), 'started');
  assert.equal(installed.pack.name, 'CurseForge Pick');
  assert.equal(installed.btn, button);
});
