// In-app updates: CraftDock picks the artifact that belongs to the way it was
// installed, downloads it, and hands it to the installer or swaps the portable
// exe in place.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
