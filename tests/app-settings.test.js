const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function extract(pattern, label) {
  const match = html.match(pattern);
  assert.ok(match, `${label} is missing`);
  return match[0];
}

function extractFunction(name) {
  return extract(
    new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'),
    `${name}()`,
  );
}

function themeChoice(value) {
  const classes = new Set();
  return {
    dataset: { themeChoice: value },
    attrs: {},
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
  };
}

test('Settings defaults to deep navy and offers light and OLED', () => {
  assert.match(html, /:root\s*\{[\s\S]*?--bg-darkest: #080c14;[\s\S]*?\}/);
  const lightBlock = extract(/^:root\[data-theme="light"\] \{[\s\S]*?^\}/m, 'light palette');
  const lightValue = name => lightBlock.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
  assert.match(html, /:root\[data-theme="oled"\]\s*\{/);
  assert.equal(lightValue('--bg-card'), '#ffffff');
  assert.notEqual(lightValue('--bg-card'), lightValue('--bg-mid'));
  assert.notEqual(lightValue('--bg-card'), lightValue('--bg-input'));
  assert.notEqual(lightValue('--bg-darkest'), lightValue('--bg-mid'));

  const dark = html.match(/<button[^>]*data-theme-choice="dark"[^>]*>/)?.[0] || '';
  const light = html.match(/<button[^>]*data-theme-choice="light"[^>]*>/)?.[0] || '';
  const oled = html.match(/<button[^>]*data-theme-choice="oled"[^>]*>/)?.[0] || '';
  assert.match(dark, /theme-choice active/);
  assert.match(dark, /aria-checked="true"/);
  assert.match(light, /aria-checked="false"/);
  assert.doesNotMatch(light, /theme-choice active/);
  assert.match(oled, /aria-checked="false"/);
  assert.doesNotMatch(oled, /theme-choice active/);
  assert.match(html, /if \(theme !== 'light' && theme !== 'dark' && theme !== 'oled'\) theme = 'dark'/);
  assert.match(html, /applySettingsTheme\(s\.theme \|\| 'dark'\)/);
});

test('theme switching sets the document palette and radio state', () => {
  const source = [
    extract(/^const APP_THEMES = new Set\(\[[^\]]*\]\);$/m, 'APP_THEMES'),
    extractFunction('normalizeAppTheme'),
    extractFunction('applySettingsTheme'),
  ].join('\n');
  const choices = ['dark', 'light', 'oled'].map(themeChoice);
  const document = {
    documentElement: { dataset: {}, style: {} },
    querySelectorAll: () => choices,
  };
  const context = { document };
  vm.createContext(context);
  vm.runInContext(source, context);

  assert.equal(context.normalizeAppTheme('OLED'), 'oled');
  assert.equal(context.normalizeAppTheme('sepia'), 'dark');

  context.applySettingsTheme('light');
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(document.documentElement.style.colorScheme, 'light');
  assert.equal(choices[1].attrs['aria-checked'], 'true');
  assert.equal(choices[0].attrs['aria-checked'], 'false');

  context.applySettingsTheme('oled');
  assert.equal(document.documentElement.dataset.theme, 'oled');
  assert.equal(document.documentElement.style.colorScheme, 'dark');
  assert.equal(choices[2].attrs['aria-checked'], 'true');

  context.applySettingsTheme('plasma');
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(choices[0].attrs['aria-checked'], 'true');
});

test('community packs are validated and keep only usable translations', () => {
  const source = [
    extract(/^const LOCALE_CODE_RE = .*;$/m, 'LOCALE_CODE_RE'),
    extract(/^const MAX_LOCALE_STRINGS = .*;$/m, 'MAX_LOCALE_STRINGS'),
    extractFunction('normalizeLocalePack'),
  ].join('\n');
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context);

  const pack = context.normalizeLocalePack({
    code: 'DE',
    name: ' German ',
    nativeName: 'Deutsch',
    strings: {
      ' Settings ': 'Einstellungen',
      Empty: '   ',
      '': 'ignored',
    },
  });
  assert.equal(pack.code, 'de');
  assert.equal(pack.name, 'German');
  assert.equal(pack.nativeName, 'Deutsch');
  assert.equal(pack.strings.Settings, 'Einstellungen');
  assert.deepEqual(Array.from(Object.keys(pack.strings)), ['Settings']);
  assert.equal(Object.getPrototypeOf(pack.strings), null);

  assert.equal(context.normalizeLocalePack({ code: 'en', strings: { Settings: 'Settings' } }), null);
  assert.equal(context.normalizeLocalePack({ code: 'd', strings: { Settings: 'Einstellungen' } }), null);
  assert.equal(context.normalizeLocalePack({ code: 'de', strings: [] }), null);
  assert.equal(context.normalizeLocalePack({ code: 'de', strings: {} }), null);

  assert.match(html, /code: 'es',[\s\S]*?'Settings': 'Ajustes'/);
});

test('missing translations restore the English source text', () => {
  const source = [
    extract(/^const _localeOriginalText = new WeakMap\(\);$/m, 'original-text cache'),
    'let _localeDictionary = Object.create(null);',
    extractFunction('localeOriginalText'),
    extractFunction('localeTranslation'),
    extractFunction('localeSkipped'),
    extractFunction('translateLocaleTextNode'),
  ].join('\n');
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context);

  const node = {
    nodeType: 3,
    nodeValue: 'Settings',
    parentElement: { tagName: 'DIV', closest: () => null },
  };
  vm.runInContext(
    "_localeDictionary = Object.assign(Object.create(null), { Settings: 'Ajustes' });",
    context,
  );
  context.translateLocaleTextNode(node);
  assert.equal(node.nodeValue, 'Ajustes');

  vm.runInContext('_localeDictionary = Object.create(null);', context);
  context.translateLocaleTextNode(node);
  assert.equal(node.nodeValue, 'Settings');
});

test('saved theme and language initialize on launch and controls stay wired', () => {
  const init = extractFunction('initializeSavedSettings');
  assert.match(init, /applySettingsTheme\(settings\.theme \|\| 'dark'\)/);
  assert.match(init, /settingsInitTranslations\(settings\)/);
  assert.match(html, /initializeSavedSettings\(\)\.catch/);

  assert.match(html, /onclick="settingsSetTheme\('dark'\)"/);
  assert.match(html, /onclick="settingsSetTheme\('light'\)"/);
  assert.match(html, /onclick="settingsSetTheme\('oled'\)"/);
  assert.match(html, /onclick="settingsCreateAppBackup\(\)"/);
  assert.match(html, /onclick="settingsScanUnusedDownloads\(\)"/);
  assert.match(html, /onchange="settingsImportLocaleFile\(this\)"/);
  assert.match(html, /id="settingsBackupStatus"/);
  assert.match(html, /id="settingsUnusedStats"/);

  assert.match(preload, /appData:\s*\{[\s\S]*?createBackup:[\s\S]*?cacheStats:[\s\S]*?cleanCache:/);
  assert.match(main, /ipcMain\.handle\('app-data-backup'/);
  assert.match(main, /ipcMain\.handle\('app-cache-stats'/);
  assert.match(main, /ipcMain\.handle\('app-cache-clean'/);
  assert.doesNotMatch(main, /^const \{[^}]*\} = require\('\.\/app-data-backup'\);/m);
  assert.doesNotMatch(main, /^const \{[^}]*\} = require\('\.\/app-cache'\);/m);
  assert.ok(pkg.build.files.includes('app-data-backup.js'));
  assert.ok(pkg.build.files.includes('app-cache.js'));
});

test('app version stays in sync across package and Tauri manifests', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const tauri = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const cargo = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
  const cargoLock = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.lock'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const version = pkg.version;

  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  assert.equal(tauri.version, version);
  assert.match(cargo, new RegExp(`^version = "${version.replace(/\./g, '\\.')}"$`, 'm'));
  assert.match(cargoLock, new RegExp(`name = "craftdock"\\r?\\nversion = "${version.replace(/\./g, '\\.')}"`));
  assert.match(html, new RegExp(`let APP_VERSION = '${version.replace(/\./g, '\\.')}';`));
  assert.match(readme, new RegExp(`version-${version.replace(/\./g, '\\.')}-`));
});
