const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');
const rustEntry = fs.readFileSync(path.join(projectRoot, 'src-tauri', 'src', 'main.rs'), 'utf8');
const capability = JSON.parse(fs.readFileSync(path.join(projectRoot, 'src-tauri', 'capabilities', 'main.json'), 'utf8'));
const tauriConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const functionStart = renderer.indexOf('function settingsOpenGithub() {');
const windowControlStart = renderer.indexOf('function winCtrl(action) {');
const windowControlMatch = renderer.slice(windowControlStart).match(/^function winCtrl\(action\) \{[\s\S]*?\r?\n\}/);
assert.notEqual(windowControlStart, -1, 'winCtrl() exists in the renderer');
assert.ok(windowControlMatch, 'winCtrl() has a closing brace');
const winCtrl = windowControlMatch[0];
const functionMatch = renderer.slice(functionStart).match(/^function settingsOpenGithub\(\) \{[\s\S]*?\r?\n\}/);
assert.notEqual(functionStart, -1, 'settingsOpenGithub() exists in the renderer');
assert.ok(functionMatch, 'settingsOpenGithub() has a closing brace');
const settingsOpenGithub = functionMatch[0];

function runBridge({ window, isCraftDock = false, console = { error() {} } }) {
  vm.runInNewContext(`${settingsOpenGithub}\nsettingsOpenGithub();`, {
    window,
    isCraftDock,
    console,
  });
}

test('Tauri reuses the renderer title bar without native decorations', () => {
  assert.equal(tauriConfig.app.windows.find(window => window.label === 'main')?.decorations, false);
  assert.match(renderer, /class="titlebar-logo" data-tauri-drag-region/);
  assert.match(renderer, /class="titlebar-center" data-tauri-drag-region/);
});

test('Tauri reports issues through the registered Rust command', () => {
  const calls = [];
  const window = {
    __TAURI__: { core: { invoke: (...args) => { calls.push(args); return Promise.resolve(); } } },
    craftdock: { openExternal: () => assert.fail('Electron bridge must not run in Tauri') },
    open: () => assert.fail('browser fallback must not run in Tauri'),
  };

  runBridge({ window, isCraftDock: true });

  assert.deepEqual(calls, [['report_issue']]);
});

test('Tauri titlebar buttons invoke only their specific window commands', () => {
  const calls = [];
  const window = {
    __TAURI__: { core: { invoke: (...args) => { calls.push(args); return Promise.resolve(); } } },
    craftdock: {
      minimize: () => assert.fail('Electron minimize must not run in Tauri'),
      maximize: () => assert.fail('Electron maximize must not run in Tauri'),
      close: () => assert.fail('Electron close must not run in Tauri'),
    },
  };
  vm.runInNewContext(`${winCtrl}; winCtrl('minimize'); winCtrl('maximize'); winCtrl('close');`, {
    window,
    isCraftDock: true,
    console: { error() {} },
  });
  assert.deepEqual(calls, [
    ['window_minimize'],
    ['window_toggle_maximize'],
    ['window_close'],
  ]);
});

test('Electron titlebar controls retain their existing bridge', () => {
  const calls = [];
  const window = { craftdock: {
    minimize: () => calls.push('minimize'),
    maximize: () => calls.push('maximize'),
    close: () => calls.push('close'),
  } };
  vm.runInNewContext(`${winCtrl}; winCtrl('minimize'); winCtrl('maximize'); winCtrl('close');`, {
    window,
    isCraftDock: true,
    console: { error() {} },
  });
  assert.deepEqual(calls, ['minimize', 'maximize', 'close']);
});

test('Electron retains its existing external-link bridge', () => {
  const opened = [];
  const window = {
    craftdock: { openExternal: url => opened.push(url) },
    open: () => assert.fail('browser fallback must not run in Electron'),
  };

  runBridge({ window, isCraftDock: true });

  assert.deepEqual(opened, ['https://github.com/Geegamr/CraftDock/issues']);
});

test('Rust command and opener capability restrict Tauri to the issue tracker', () => {
  assert.match(rustEntry, /fn window_minimize\(window: tauri::WebviewWindow\)/);
  assert.match(rustEntry, /fn window_toggle_maximize\(window: tauri::WebviewWindow\)/);
  assert.match(rustEntry, /fn window_close\(window: tauri::WebviewWindow\)/);
  assert.match(rustEntry, /generate_handler!\[([\s\S]*?)window_minimize[\s\S]*?window_toggle_maximize[\s\S]*?window_close[\s\S]*?report_issue/);
  assert.match(rustEntry, /fn report_issue\(app: tauri::AppHandle\)/);
  assert.match(rustEntry, /open_url\("https:\/\/github\.com\/Geegamr\/CraftDock\/issues", None::<&str>\)/);
  assert.match(rustEntry, /generate_handler!\[[\s\S]*?report_issue[\s\S]*?\]/);

  const openerPermission = capability.permissions.find(permission =>
    typeof permission === 'object' && permission.identifier === 'opener:allow-open-url');
  assert.deepEqual(openerPermission.allow, [{ url: 'https://github.com/Geegamr/CraftDock/issues' }]);
});

test('browser fallback opens the issue tracker in a new tab', () => {
  const opened = [];
  const window = {
    open: (...args) => opened.push(args),
  };

  runBridge({ window });

  assert.deepEqual(opened, [['https://github.com/Geegamr/CraftDock/issues', '_blank']]);
});
