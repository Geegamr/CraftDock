// In-app updates: CraftDock picks the artifact that belongs to the way it was
// installed, downloads it, and hands it to the installer or swaps the portable
// exe in place.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadApp, plain, projectRoot, withTempRoot } = require('./helpers/electron-app');

const RELEASE_API = 'https://api.github.com/repos/Geegamr/CraftDock/releases/latest';

const appVersion = require('../package.json').version;
const [majorPart, minorPart] = appVersion.split('.');

// The fixture release has to be newer than the build under test, so it is
// derived from package.json by bumping the minor part (0.8.1 -> 0.9.0), so a
// version bump never quietly turns these tests into "already up to date"
// no-ops. The bumped minor also keeps the numeric compare honest once the
// minor reaches two digits, since "0.10.0" sorts before "0.9.0" as a string.
const NEXT_VERSION = `${majorPart}.${Number(minorPart) + 1}.0`;
// Older than any release this repository has shipped.
const OLD_VERSION = '0.0.1';

// GitHub rewrites the spaces in uploaded asset names to dots, so the release
// carries "CraftDock.Setup.0.10.0.exe" for the file built as
// "CraftDock Setup 0.10.0.exe".
const installerAsset = tag => `CraftDock.Setup.${tag}.exe`;
const portableAsset = tag => `CraftDock.${tag}.exe`;
const assetUrl = name => `https://fixture.invalid/${name}`;

const INSTALLER_URL = assetUrl(installerAsset(NEXT_VERSION));
const PORTABLE_URL = assetUrl(portableAsset(NEXT_VERSION));

function release(tag, body = 'update body') {
  return {
    tag_name: `v${tag}`,
    name: `CraftDock v${tag}`,
    body,
    html_url: `https://github.com/Geegamr/CraftDock/releases/tag/v${tag}`,
    assets: [
      { name: installerAsset(tag), size: 8, browser_download_url: assetUrl(installerAsset(tag)) },
      { name: `${installerAsset(tag)}.blockmap`, size: 2, browser_download_url: 'https://fixture.invalid/latest.yml.blockmap' },
      { name: portableAsset(tag), size: 8, browser_download_url: assetUrl(portableAsset(tag)) },
    ],
  };
}

test('a check reports the release and the artifact that matches this install', async () => {
  await withTempRoot(async root => {
    const installed = loadApp(root, {
      platform: 'win32',
      routes: { [RELEASE_API]: release(NEXT_VERSION) },
    });
    const forInstalled = plain(await installed.exposed.craftdockInstance.checkAppUpdate());

    assert.equal(forInstalled.success, true);
    assert.equal(forInstalled.current, appVersion);
    assert.equal(forInstalled.latest, NEXT_VERSION);
    assert.equal(forInstalled.hasUpdate, true);
    assert.equal(forInstalled.canInstall, true);
    assert.equal(forInstalled.asset.name, installerAsset(NEXT_VERSION), 'an installed build runs the setup again');
    assert.equal(forInstalled.asset.size, 8);
    assert.equal(forInstalled.asset.url, INSTALLER_URL);
  });

  await withTempRoot(async root => {
    const portable = loadApp(root, {
      platform: 'win32',
      env: {
        PORTABLE_EXECUTABLE_DIR: root,
        PORTABLE_EXECUTABLE_FILE: path.join(root, 'CraftDock.exe'),
      },
      routes: { [RELEASE_API]: release(NEXT_VERSION) },
    });
    const forPortable = plain(await portable.exposed.craftdockInstance.checkAppUpdate());

    assert.equal(forPortable.portable, true);
    assert.equal(forPortable.asset.name, portableAsset(NEXT_VERSION), 'a portable build replaces its own exe');
    assert.equal(forPortable.asset.url, PORTABLE_URL);
  });
});

test('the version compare is numeric, so a two-digit minor beats a one-digit one and old releases stay quiet', async () => {
  await withTempRoot(async root => {
    const newer = loadApp(root, {
      platform: 'win32',
      routes: { [RELEASE_API]: release(NEXT_VERSION) },
    });
    assert.equal(plain(await newer.exposed.craftdockInstance.checkAppUpdate()).hasUpdate, true);
  });

  await withTempRoot(async root => {
    const older = loadApp(root, {
      platform: 'win32',
      routes: { [RELEASE_API]: release(OLD_VERSION) },
    });
    const info = plain(await older.exposed.craftdockInstance.checkAppUpdate());
    assert.equal(info.hasUpdate, false, 'an older release is not an update');
    assert.equal(info.asset, null, 'nothing is offered for download');
  });

  await withTempRoot(async root => {
    // Same version, different string form: still not an update.
    const same = loadApp(root, {
      platform: 'win32',
      routes: { [RELEASE_API]: release(`v${appVersion}`) },
    });
    assert.equal(plain(await same.exposed.craftdockInstance.checkAppUpdate()).hasUpdate, false);
  });
});

test('a failed release lookup is reported, not thrown', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, { platform: 'win32', routes: {} });
    const info = plain(await app.exposed.craftdockInstance.checkAppUpdate());
    assert.equal(info.success, false);
    assert.match(info.error, /404/);
  });
});

test('the update is downloaded into a staging folder and checked against its size', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, {
      platform: 'win32',
      routes: {
        [RELEASE_API]: release(NEXT_VERSION),
        [INSTALLER_URL]: Buffer.from('setup!!!'),
      },
    });

    const result = plain(await app.exposed.craftdockInstance.appUpdateDownload());
    assert.equal(result.success, true, result.error);
    assert.equal(result.version, NEXT_VERSION);
    assert.equal(result.kind, 'installer');

    // app.getPath('temp') is the temp root in the harness.
    const staged = path.join(root, 'craftdock-update', installerAsset(NEXT_VERSION));
    assert.equal(fs.existsSync(staged), true);
    assert.equal(fs.readFileSync(staged, 'utf8'), 'setup!!!');

    // A second call reuses the file instead of pulling 112 MB again.
    const again = plain(await app.exposed.craftdockInstance.appUpdateDownload());
    assert.equal(again.cached, true);
    assert.equal(again.path, staged);
  });

  await withTempRoot(async root => {
    // Six bytes on the wire, eight promised by the API: a truncated download.
    const app = loadApp(root, {
      platform: 'win32',
      routes: {
        [RELEASE_API]: release(NEXT_VERSION),
        [INSTALLER_URL]: Buffer.from('short!'),
      },
    });
    const result = plain(await app.exposed.craftdockInstance.appUpdateDownload());
    assert.equal(result.success, false);
    assert.match(result.error, /6 of 8 bytes/);
    assert.equal(fs.existsSync(path.join(root, 'craftdock-update', installerAsset(NEXT_VERSION))), false);
  });
});

test('installing an update on an installed build runs the setup silently', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, {
      platform: 'win32',
      routes: {
        [RELEASE_API]: release(NEXT_VERSION),
        [INSTALLER_URL]: Buffer.from('setup!!!'),
      },
    });

    const before = plain(await app.exposed.craftdockInstance.appUpdateInstall());
    assert.equal(before.success, false, 'nothing has been downloaded yet');

    await app.exposed.craftdockInstance.appUpdateDownload();
    const result = plain(await app.exposed.craftdockInstance.appUpdateInstall());
    assert.equal(result.success, true, result.error);

    const installer = app.spawnCalls.find(call => String(call.command).endsWith(installerAsset(NEXT_VERSION)));
    assert.ok(installer, 'the downloaded setup is started');
    assert.deepEqual(plain(installer.args), ['--updated'], 'the update flag installs without pages and reopens the app');
    assert.equal(installer.options.detached, true);
  });
});

test('the startup update check runs before the first token refresh attempt', () => {
  const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');
  const checkStart = renderer.indexOf('async function _startupUpdateCheck()');
  const checkEnd = renderer.indexOf('\nasync function _runUpdateCheck', checkStart);
  assert.ok(checkStart >= 0 && checkEnd > checkStart, 'the startup update check exists');
  const checkSource = renderer.slice(checkStart, checkEnd);
  assert.match(checkSource, /finally\s*\{\s*_refreshTokensAfterStartupCheck\(\);\s*\}/);
  assert.match(renderer, /async function _refreshTokensAfterStartupCheck\(attempt = 0\) \{[\s\S]*?await window\.craftdockInstance\.refreshTokensNow\(\)/);

  const main = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
  assert.match(main, /return \{ retryable \};/);
  assert.match(main, /retryable: !!result\?\.retryable/);
  const timerStart = main.indexOf('function startBackgroundTokenRefresh()');
  const timerEnd = main.indexOf('\nasync function doCompleteLogin', timerStart);
  assert.ok(timerStart >= 0 && timerEnd > timerStart, 'the background refresh timer exists');
  const timerSource = main.slice(timerStart, timerEnd);
  assert.match(timerSource, /setInterval/);
  const timerSetup = timerSource.slice(0, timerSource.indexOf('_bgRefreshTimer = setInterval'));
  assert.doesNotMatch(timerSetup, /backgroundRefreshAllAccounts\(\)/,
    'the startup refresh must not run before the update check');
});

test('startup token refresh waits for the check, and still runs when it fails or is disabled', async () => {
  const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');
  const start = renderer.indexOf('async function _startupUpdateCheck()');
  const end = renderer.indexOf('\nasync function _runUpdateCheck', start);
  assert.ok(start >= 0 && end > start, 'the startup update check exists');
  const source = renderer.slice(start, end);

  async function callsFor(settings, checkBehavior) {
    const calls = [];
    const sandbox = {
      isCraftDock: true,
      window: {
        craftdockInstance: {
          refreshTokensNow: async () => { calls.push('refresh'); },
        },
      },
      getSettings: async () => settings,
      _runUpdateCheck: async () => {
        calls.push('check');
        if (checkBehavior === 'throw') throw new Error('offline');
      },
    };
    vm.runInNewContext(source, sandbox);
    await sandbox._startupUpdateCheck();
    return calls;
  }

  assert.deepEqual(await callsFor({ checkUpdatesOnStartup: true }), ['check', 'refresh']);
  assert.deepEqual(await callsFor({ checkUpdatesOnStartup: true }, 'throw'), ['check', 'refresh']);
  assert.deepEqual(await callsFor({ checkUpdatesOnStartup: false }), ['refresh']);
});

test('startup token refresh retries transient failures with bounded backoff', async () => {
  const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');
  const start = renderer.indexOf('const STARTUP_REFRESH_RETRY_DELAYS');
  const end = renderer.indexOf('\nasync function _runUpdateCheck', start);
  assert.ok(start >= 0 && end > start, 'the startup refresh retry helper exists');
  const source = renderer.slice(start, end);

  let calls = 0;
  const timers = [];
  const sandbox = {
    isCraftDock: true,
    window: {
      craftdockInstance: {
        refreshTokensNow: async () => {
          calls++;
          return { success: true, retryable: calls < 3 };
        },
      },
    },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
  };
  vm.runInNewContext(source, sandbox);

  await sandbox._refreshTokensAfterStartupCheck();
  assert.equal(calls, 1);
  assert.deepEqual(timers.map(timer => timer.delay), [15000], 'the first retry waits 15 seconds');

  await timers[0].fn();
  assert.equal(calls, 2);
  assert.deepEqual(timers.map(timer => timer.delay), [15000, 60000], 'the second retry backs off to a minute');

  await timers[1].fn();
  assert.equal(calls, 3);
  assert.equal(timers.length, 2, 'a successful recovery stops the retry chain');
});

test('startup token refresh retries an IPC rejection and gives up after the bounded delays', async () => {
  const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');
  const start = renderer.indexOf('const STARTUP_REFRESH_RETRY_DELAYS');
  const end = renderer.indexOf('\nasync function _runUpdateCheck', start);
  const source = renderer.slice(start, end);

  let calls = 0;
  const timers = [];
  const sandbox = {
    isCraftDock: true,
    window: {
      craftdockInstance: {
        refreshTokensNow: async () => { calls++; throw new Error('offline'); },
      },
    },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
  };
  vm.runInNewContext(source, sandbox);

  await sandbox._refreshTokensAfterStartupCheck();
  for (let i = 0; i < 3; i++) await timers[i].fn();

  assert.equal(calls, 4, 'the initial attempt plus all three retries run');
  assert.deepEqual(timers.map(timer => timer.delay), [15000, 60000, 300000]);
});

test('startup token refresh retries immediately when the connection comes back', async () => {
  const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');
  const start = renderer.indexOf('const STARTUP_REFRESH_RETRY_DELAYS');
  const end = renderer.indexOf('\nasync function _runUpdateCheck', start);
  const source = renderer.slice(start, end);

  let calls = 0;
  let offline = true;
  const timers = [];
  const cancelled = [];
  const listeners = {};
  const sandbox = {
    isCraftDock: true,
    window: {
      craftdockInstance: {
        refreshTokensNow: async () => {
          calls++;
          return { success: true, retryable: offline };
        },
      },
      addEventListener: (type, handler) => { listeners[type] = handler; },
    },
    setTimeout: (fn, delay) => {
      const timer = { fn, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout: timer => cancelled.push(timer),
  };
  vm.runInNewContext(source, sandbox);

  await sandbox._refreshTokensAfterStartupCheck();
  assert.equal(calls, 1);
  assert.equal(timers.length, 1, 'an offline failure schedules a backoff retry');

  offline = false;
  await listeners.online();
  assert.equal(calls, 2, 'the reconnect refreshes immediately instead of waiting for the timer');
  assert.deepEqual(cancelled, [timers[0]], 'the pending backoff is cancelled');
  assert.equal(timers.length, 1, 'a successful reconnect does not schedule another retry');
});

test('installing a portable update hands the swap to a helper that waits for the app to exit', async () => {
  await withTempRoot(async root => {
    const target = path.join(root, 'CraftDock.exe');
    const app = loadApp(root, {
      platform: 'win32',
      env: { PORTABLE_EXECUTABLE_DIR: root, PORTABLE_EXECUTABLE_FILE: target },
      routes: {
        [RELEASE_API]: release(NEXT_VERSION),
        [PORTABLE_URL]: Buffer.from('portable'),
      },
    });

    const downloaded = plain(await app.exposed.craftdockInstance.appUpdateDownload());
    assert.equal(downloaded.kind, 'portable', downloaded.error);

    const result = plain(await app.exposed.craftdockInstance.appUpdateInstall());
    assert.equal(result.success, true, result.error);

    const helper = app.spawnCalls.find(call => call.command === 'cmd.exe');
    assert.ok(helper, 'a helper process is started');
    const scriptPath = helper.args[helper.args.indexOf('/c') + 1];
    const script = fs.readFileSync(scriptPath, 'utf8');

    assert.match(script, /tasklist \/FI "PID eq %PID%"/, 'it waits for CraftDock to exit');
    assert.ok(script.includes(`set "TARGET=${target}"`), 'it targets the exe the user launched');
    assert.match(script, /copy \/Y "%SOURCE%" "%TARGET%"/, 'it copies the new build over the old one');
    assert.match(script, /start "" "%TARGET%"/, 'it starts the new build afterwards');
    assert.ok(script.includes('GEQ 60'), 'it gives up instead of looping forever');
  });
});
