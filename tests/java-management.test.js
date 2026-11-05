// Local Java management: the launcher uses the Java the machine already has,
// and only installs a private copy when a version is genuinely missing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  loadApp, plain, prepareClientCache, projectRoot, withTempRoot, writeInstance,
} = require('./helpers/electron-app');

const MANIFEST_ROUTE = {
  'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json': {
    versions: [
      { id: '1.20.4', url: 'https://fixture.invalid/1.20.4.json' },
      { id: '1.17', url: 'https://fixture.invalid/1.17.json' },
      { id: '1.16.5', url: 'https://fixture.invalid/1.16.5.json' },
    ],
  },
};

function adoptiumUrl(feature, os = 'linux', imageType = 'jre') {
  return `https://api.adoptium.net/v3/assets/feature_releases/${feature}/ga`
    + `?image_type=${imageType}&os=${os}&architecture=x64&jvm_impl=hotspot&page_size=1`;
}

function adoptiumResponse(feature) {
  return [{
    binaries: [{
      package: {
        name: `OpenJDK${feature}U-jre_x64.tar.gz`,
        link: `https://fixture.invalid/jre-${feature}.tar.gz`,
        size: 4096,
      },
    }],
  }];
}

// A `tar -xzf … -C <dir>` call that really produces an extracted launcher Java.
function extractWithTar() {
  return (command, args) => {
    if (command !== 'tar' || !Array.isArray(args)) return '';
    const destination = args[args.indexOf('-C') + 1];
    const exe = path.join(destination, 'bin', 'java');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'extracted jre');
    return '';
  };
}

function makeJava(root, relative, contents = 'java binary') {
  const exe = path.join(root, relative);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, contents);
  return exe;
}

function launchCommand(app) {
  const call = app.spawnCalls.find(entry =>
    Array.isArray(entry.args) && entry.args.includes('--gameDir'));
  assert.ok(call, 'the instance was launched');
  return call.command;
}

const adoptiumRequests = app => app.network.requested.filter(url => url.includes('api.adoptium.net'));

test('a matching Java already on the machine is used and nothing is downloaded', async () => {
  await withTempRoot(async root => {
    prepareClientCache(root, '1.20.4');
    prepareClientCache(root, '1.16.5');
    const jdk = path.join(root, 'jdk-21');
    const systemJava = makeJava(root, path.join('jdk-21', 'bin', 'java.exe'));

    const app = loadApp(root, {
      platform: 'win32',
      env: { JAVA_HOME: jdk },
      javaVersion: command => (command === systemJava ? 21 : 0),
      routes: MANIFEST_ROUTE,
    });

    writeInstance(app, 'inst_j21', { mcVersion: '1.20.4' });
    writeInstance(app, 'inst_j8', { mcVersion: '1.16.5' });

    const modern = await app.exposed.craftdockInstance.launch({ id: 'inst_j21' });
    const older  = await app.exposed.craftdockInstance.launch({ id: 'inst_j8' });

    assert.equal(modern.success, true);
    assert.equal(older.success, true);
    assert.equal(launchCommand(app), systemJava, 'the user\'s own Java runs the game');
    assert.deepEqual(adoptiumRequests(app), [], 'no Java download was attempted');
    assert.equal(fs.existsSync(path.join(app.dataDir, 'java')), false, 'no private Java was installed');
  });
});

test('without system Java the launcher reuses the private Java it installed earlier', async () => {
  await withTempRoot(async root => {
    prepareClientCache(root, '1.20.4');
    const app = loadApp(root, {
      platform: 'win32',
      env: { JAVA_HOME: '' },
      javaVersion: command => (command.includes(`${path.sep}java21${path.sep}`) ? 21 : 0),
      routes: MANIFEST_ROUTE,
    });
    const managed = makeJava(app.dataDir, path.join('java', 'java21', 'bin', 'java.exe'));

    writeInstance(app, 'inst_managed', { mcVersion: '1.20.4' });
    const result = await app.exposed.craftdockInstance.launch({ id: 'inst_managed' });

    assert.equal(result.success, true);
    assert.equal(launchCommand(app), managed);
    assert.deepEqual(adoptiumRequests(app), []);
  });
});

test('a launch installs the missing Java once, then reuses it without downloading again', async () => {
  await withTempRoot(async root => {
    prepareClientCache(root, '1.20.4');
    const app = loadApp(root, {
      platform: 'linux',
      env: { JAVA_HOME: '' },
      javaVersion: command => (command.includes(`${path.sep}java21${path.sep}`) ? 21 : 0),
      execFileSync: extractWithTar(),
      routes: {
        ...MANIFEST_ROUTE,
        [adoptiumUrl(21)]: adoptiumResponse(21),
        'https://fixture.invalid/jre-21.tar.gz': Buffer.from('jre tarball'),
      },
    });

    writeInstance(app, 'inst_auto', { mcVersion: '1.20.4' });

    const first = await app.exposed.craftdockInstance.launch({ id: 'inst_auto' });
    assert.equal(first.success, true);

    const installedExe = path.join(app.dataDir, 'java', 'java21', 'bin', 'java');
    assert.equal(launchCommand(app), installedExe, 'the freshly installed Java runs the game');
    assert.equal(fs.existsSync(installedExe), true, 'the download is saved for later launches');
    assert.deepEqual(adoptiumRequests(app), [adoptiumUrl(21)]);

    // Second launch is served by the saved install — no new Temurin request.
    await app.exposed.craftdockInstance.launch({ id: 'inst_auto' });
    assert.deepEqual(adoptiumRequests(app), [adoptiumUrl(21)]);
  });
});

// 1.17 needs Java 16, and Temurin only ever published JRE images from 17 on:
// the JRE lookup answers HTTP 404. The install must fall back to the JDK build
// rather than failing with the raw 404.
test('a Java 16 install falls back to the JDK build when there is no JRE image', async () => {
  await withTempRoot(async root => {
    prepareClientCache(root, '1.17');
    const app = loadApp(root, {
      platform: 'linux',
      env: { JAVA_HOME: '' },
      javaVersion: command => (command.includes(`${path.sep}java16${path.sep}`) ? 16 : 0),
      execFileSync: extractWithTar(),
      routes: {
        ...MANIFEST_ROUTE,
        // Deliberately no JRE 16 route: the mock answers 404, like the real API.
        [adoptiumUrl(16, 'linux', 'jdk')]: adoptiumResponse(16),
        'https://fixture.invalid/jre-16.tar.gz': Buffer.from('jdk tarball'),
      },
    });

    writeInstance(app, 'inst_117', { mcVersion: '1.17' });
    const result = await app.exposed.craftdockInstance.launch({ id: 'inst_117' });

    assert.equal(result.success, true, result.error);
    const installedExe = path.join(app.dataDir, 'java', 'java16', 'bin', 'java');
    assert.equal(fs.existsSync(installedExe), true, 'the JDK download is unpacked into java16');
    assert.equal(launchCommand(app), installedExe);
    assert.deepEqual(adoptiumRequests(app), [
      adoptiumUrl(16), adoptiumUrl(16, 'linux', 'jdk'),
    ], 'the JRE lookup is tried first, then the JDK');
  });
});

test('the startup Java check reports what is available and never downloads', async () => {
  await withTempRoot(async root => {
    const empty = loadApp(root, {
      platform: 'win32',
      env: { JAVA_HOME: '' },
      javaVersion: () => 0,
    });

    const bare = await empty.exposed.craftdockInstance.javaStatus();
    assert.deepEqual(plain(bare), {
      systemCount: 0,
      launcherCount: 0,
      preferredSource: 'none',
      bestSystemVersion: 0,
      bestLauncherVersion: 0,
      missingMajors: [8, 16, 17, 21, 25],
    });
    assert.deepEqual(adoptiumRequests(empty), [], 'detection does not install anything');
    assert.deepEqual(empty.fetchCalls, [], 'detection does not touch the network');
  });

  await withTempRoot(async root => {
    const jdk = path.join(root, 'jdk-21');
    const systemJava = makeJava(root, path.join('jdk-21', 'bin', 'java.exe'));
    const app = loadApp(root, {
      platform: 'win32',
      env: { JAVA_HOME: jdk },
      javaVersion: command => (command === systemJava ? 21 : 0),
    });

    const status = plain(await app.exposed.craftdockInstance.javaStatus());
    assert.equal(status.systemCount, 1);
    assert.equal(status.preferredSource, 'system', 'the user\'s Java is preferred');
    assert.equal(status.bestSystemVersion, 21);
    assert.deepEqual(status.missingMajors, [25],
      'a Java 21 still leaves Java 25, which the 26.x calendar versions need');
    assert.deepEqual(app.fetchCalls, []);
  });
});

test('install-missing downloads only the versions this machine cannot run', async () => {
  await withTempRoot(async root => {
    const jdk = path.join(root, 'jdk-8');
    const systemJava = makeJava(root, path.join('jdk-8', 'bin', 'java'));
    const app = loadApp(root, {
      platform: 'linux',
      env: { JAVA_HOME: jdk },
      javaVersion: command => (command === systemJava ? 8 : 0),
      execFileSync: extractWithTar(),
      routes: {
        // Temurin publishes no JRE 16, so the installer has to take the JDK.
        [adoptiumUrl(16, 'linux', 'jdk')]: adoptiumResponse(16),
        [adoptiumUrl(17)]: adoptiumResponse(17),
        [adoptiumUrl(21)]: adoptiumResponse(21),
        [adoptiumUrl(25)]: adoptiumResponse(25),
        'https://fixture.invalid/jre-16.tar.gz': Buffer.from('16'),
        'https://fixture.invalid/jre-17.tar.gz': Buffer.from('17'),
        'https://fixture.invalid/jre-21.tar.gz': Buffer.from('21'),
        'https://fixture.invalid/jre-25.tar.gz': Buffer.from('25'),
      },
    });

    const result = plain(await app.exposed.craftdockInstance.installMissingJava());
    assert.equal(result.success, true);
    assert.deepEqual(
      result.results.map(entry => [entry.major, entry.status]),
      [[8, 'system'], [16, 'installed'], [17, 'installed'], [21, 'installed'], [25, 'installed']],
    );
    assert.deepEqual(adoptiumRequests(app), [
      adoptiumUrl(16), adoptiumUrl(16, 'linux', 'jdk'), adoptiumUrl(17), adoptiumUrl(21), adoptiumUrl(25),
    ], 'Java 8 is already provided by the user and is not downloaded');

    for (const major of [16, 17, 21, 25]) {
      assert.equal(fs.existsSync(path.join(app.dataDir, 'java', `java${major}`, 'bin', 'java')), true);
    }
    assert.equal(fs.existsSync(path.join(app.dataDir, 'java', 'java8')), false);
  });
});

test('install-missing reports progress for each Java version it downloads', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, {
      platform: 'linux',
      env: { JAVA_HOME: '' },
      javaVersion: () => 0,
      execFileSync: extractWithTar(),
      routes: {
        [adoptiumUrl(8)]: adoptiumResponse(8),
        // Temurin publishes no JRE 16, so the installer has to take the JDK.
        [adoptiumUrl(16, 'linux', 'jdk')]: adoptiumResponse(16),
        [adoptiumUrl(17)]: adoptiumResponse(17),
        [adoptiumUrl(21)]: adoptiumResponse(21),
        [adoptiumUrl(25)]: adoptiumResponse(25),
        'https://fixture.invalid/jre-8.tar.gz': Buffer.from('8'),
        'https://fixture.invalid/jre-16.tar.gz': Buffer.from('16'),
        'https://fixture.invalid/jre-17.tar.gz': Buffer.from('17'),
        'https://fixture.invalid/jre-21.tar.gz': Buffer.from('21'),
        'https://fixture.invalid/jre-25.tar.gz': Buffer.from('25'),
      },
    });

    const result = plain(await app.exposed.craftdockInstance.installMissingJava());
    assert.equal(result.success, true);
    assert.equal(result.cancelled, false);

    const progress = app.events
      .filter(([channel]) => channel === 'java-install-progress')
      .map(([, payload]) => plain(payload));

    assert.deepEqual(
      progress.filter(entry => entry.type === 'start').map(entry => entry.major),
      [8, 16, 17, 21, 25], 'each version starts in order');
    assert.deepEqual(
      progress.filter(entry => entry.type === 'done').map(entry => [entry.major, entry.status]),
      [[8, 'installed'], [16, 'installed'], [17, 'installed'], [21, 'installed'], [25, 'installed']]);

    const percents = progress.filter(entry => entry.type === 'percent');
    assert.ok(percents.length >= 4, 'download percentages are reported');
    assert.ok(percents.every(entry => entry.percent === 100 && [8, 16, 17, 21, 25].includes(entry.major)));
    assert.ok(
      percents.every(entry => entry.received === entry.total && entry.received > 0),
      'each progress event carries the byte counts used for the time estimate');
  });
});

test('a slow Java download reports throughput before it finishes', async () => {
  await withTempRoot(async root => {
    // Twelve 8 KB pieces 60 ms apart: the download lasts longer than one rate
    // sample window, so a measurement lands while kilobytes still remain.
    const chunk = Buffer.alloc(8192, 7);
    const app = loadApp(root, {
      platform: 'linux',
      env: { JAVA_HOME: '' },
      javaVersion: () => 0,
      execFileSync: extractWithTar(),
      routes: {
        [adoptiumUrl(8)]: adoptiumResponse(8),
        // Temurin publishes no JRE 16, so the installer has to take the JDK.
        [adoptiumUrl(16, 'linux', 'jdk')]: adoptiumResponse(16),
        [adoptiumUrl(17)]: adoptiumResponse(17),
        [adoptiumUrl(21)]: adoptiumResponse(21),
        [adoptiumUrl(25)]: adoptiumResponse(25),
        'https://fixture.invalid/jre-8.tar.gz': { chunks: Array(12).fill(chunk), gapMs: 60 },
        'https://fixture.invalid/jre-16.tar.gz': Buffer.from('16'),
        'https://fixture.invalid/jre-17.tar.gz': Buffer.from('17'),
        'https://fixture.invalid/jre-21.tar.gz': Buffer.from('21'),
        'https://fixture.invalid/jre-25.tar.gz': Buffer.from('25'),
      },
    });

    const result = plain(await app.exposed.craftdockInstance.installMissingJava());
    assert.equal(result.success, true);

    const percents = app.events
      .filter(([channel]) => channel === 'java-install-progress')
      .map(([, payload]) => plain(payload))
      .filter(entry => entry.type === 'percent' && entry.major === 8);

    assert.ok(percents.some(entry => entry.percent < 100), 'intermediate progress was reported');
    const withRate = percents.filter(entry => entry.percent < 100 && entry.bytesPerSecond > 0);
    assert.ok(withRate.length > 0, 'a mid-download event carries a measured bytes/sec rate');
    assert.ok(
      withRate.every(entry => entry.received < entry.total),
      'the rate arrives while bytes are still outstanding, so an ETA is possible');
  });
});

test('a Java install can be cancelled while a download is in flight', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, {
      platform: 'linux',
      env: { JAVA_HOME: '' },
      javaVersion: () => 0,
      execFileSync: extractWithTar(),
      routes: {
        [adoptiumUrl(8)]: adoptiumResponse(8),
        'https://fixture.invalid/jre-8.tar.gz': Buffer.from('8'),
      },
    });
    assert.equal(plain(await app.exposed.craftdockInstance.cancelJavaInstall()).success, false,
      'nothing to cancel before an install starts');

    const installing = app.exposed.craftdockInstance.installMissingJava();
    const cancelled = plain(await app.exposed.craftdockInstance.cancelJavaInstall());
    assert.equal(cancelled.success, true);

    const result = plain(await installing);
    assert.equal(result.cancelled, true);
    assert.equal(result.success, false);
    assert.deepEqual(result.results.map(entry => entry.status),
      ['cancelled', 'cancelled', 'cancelled', 'cancelled', 'cancelled']);
    assert.deepEqual(adoptiumRequests(app), [], 'no download starts after a cancel');
    assert.equal(fs.existsSync(path.join(app.dataDir, 'java')), false, 'no partial Java is kept');

    assert.deepEqual(
      app.events.filter(([channel]) => channel === 'java-install-progress')
        .map(([, payload]) => plain(payload))
        .filter(entry => entry.type === 'done'),
      [{ type: 'done', major: 8, status: 'cancelled' }]);
  });
});

test('install-missing reports a failed download without throwing', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, {
      platform: 'linux',
      env: { JAVA_HOME: '' },
      javaVersion: () => 0,
      execFileSync: extractWithTar(),
      routes: {
        [adoptiumUrl(21)]: adoptiumResponse(21),
        'https://fixture.invalid/jre-21.tar.gz': Buffer.from('21'),
      },
    });

    const result = plain(await app.exposed.craftdockInstance.installMissingJava());
    assert.equal(result.success, false);
    const failed = result.results.filter(entry => entry.status === 'error');
    // Only Java 21 has a download route here; every other major fails, including 25.
    assert.deepEqual(result.results.map(entry => entry.status), ['error', 'error', 'error', 'installed', 'error']);
    assert.ok(failed.every(entry => typeof entry.error === 'string' && entry.error.length > 0));
  });
});

test('the settings panel installs missing Java and re-scans without a dialog', async () => {
  const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');
  const match = renderer.match(/^async function settingsInstallMissingJava\(\) \{[\s\S]*?\r?\n\}/m);
  assert.ok(match, 'settingsInstallMissingJava() exists in the renderer');

  async function run(results, options = {}) {
    const context = vm.createContext({});
    vm.runInContext(`
      var notifications = [];
      var scanned = 0;
      var buttonClicks = [];
      function showNotif(title, message) { notifications.push([title, message]); }
      async function settingsScanJava() { scanned += 1; }
      function instanceBridge() {
        return { installMissingJava: async () => { if (window.fail) throw new Error('offline'); return { results: window.results }; } };
      }
      var document = {
        getElementById: () => ({ disabled: false, textContent: '', clicks: buttonClicks }),
        querySelectorAll: () => [],
      };
      var stubResults = ${JSON.stringify(results)};
      var stubCancelled = ${Boolean(options.cancelled)};
      var failing = ${results === null};
      var _javaStatusCache = { stale: true };
      ${match[0]}
      function instanceBridgeStub() {
        return { installMissingJava: async () => {
          if (failing) throw new Error('offline');
          return { results: stubResults, cancelled: stubCancelled };
        } };
      }
      var runInstall = settingsInstallMissingJava;
    `, context);
    vm.runInContext('instanceBridge = instanceBridgeStub;', context);
    await vm.runInContext('runInstall()', context);
    return {
      notifications: JSON.parse(JSON.stringify(context.notifications)),
      scanned: context.scanned,
    };
  }

  const ok = await run([
    { major: 8, status: 'system' }, { major: 16, status: 'installed' },
    { major: 17, status: 'installed' }, { major: 21, status: 'launcher' },
  ]);
  assert.deepEqual(ok.notifications.at(-1), ['Java Ready', 'Installed 2 Java versions']);
  assert.equal(ok.scanned, 1, 'the settings list refreshes after installing');

  const failed = await run([
    { major: 16, status: 'error', error: 'HTTP 404' }, { major: 21, status: 'installed' },
  ]);
  assert.deepEqual(failed.notifications.at(-1), ['Java install failed', 'Could not download Java 16']);

  const offline = await run(null);
  assert.deepEqual(offline.notifications.at(-1), ['Java install failed', 'offline']);
  assert.equal(offline.scanned, 1, 'the panel still re-scans after a failure');

  const stopped = await run([
    { major: 8, status: 'cancelled' }, { major: 16, status: 'cancelled' },
  ], { cancelled: true });
  assert.deepEqual(stopped.notifications.at(-1), ['Java install cancelled', 'Nothing was installed']);
  assert.equal(stopped.scanned, 1, 'the panel re-scans after a cancelled install');
});

test('the settings panel shows per-version install progress and can cancel it', async () => {
  const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');
  const preload = fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf8');

  const progressSource = renderer.match(/^function settingsJavaProgress\(payload\) \{[\s\S]*?\r?\n\}/m);
  const cancelSource   = renderer.match(/^async function settingsCancelJavaInstall\(\) \{[\s\S]*?\r?\n\}/m);
  const speedSource    = renderer.match(/^function formatDownloadSpeed\(bytesPerSecond\) \{[\s\S]*?\r?\n\}/m);
  const etaSource      = renderer.match(/^function formatDownloadEta\(seconds\) \{[\s\S]*?\r?\n\}/m);
  const statsSource    = renderer.match(/^function downloadSpeedLine\(stats\) \{[\s\S]*?\r?\n\}/m);
  assert.ok(progressSource, 'settingsJavaProgress() exists in the renderer');
  assert.ok(cancelSource, 'settingsCancelJavaInstall() exists in the renderer');
  assert.ok(speedSource, 'formatDownloadSpeed() exists in the renderer');
  assert.ok(etaSource, 'formatDownloadEta() exists in the renderer');
  assert.ok(statsSource, 'downloadSpeedLine() exists in the renderer');

  // The progress strip, its bar and the cancel button are in the Java section.
  assert.match(renderer, /id="settingsJavaProgress"/);
  assert.match(renderer, /id="settingsJavaProgressBar"/);
  assert.match(renderer, /id="settingsJavaCancelBtn"[^>]*onclick="settingsCancelJavaInstall\(\)"/);
  assert.match(renderer, /onJavaInstallProgress\(payload => settingsJavaProgress\(payload\)\)/);

  assert.match(preload, /cancelJavaInstall:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('java-install-cancel'\)/);
  assert.match(preload, /onJavaInstallProgress:\s*\(cb\)\s*=>\s*ipcRenderer\.on\('java-install-progress'/);

  const elements = {
    settingsJavaProgress: { style: {} },
    settingsJavaProgressLabel: { textContent: '' },
    settingsJavaProgressBar: { style: {} },
    settingsJavaProgressDetail: { textContent: '' },
    settingsJavaCancelBtn: { disabled: false, textContent: 'Cancel' },
  };
  const cancelled = [];
  const context = vm.createContext({
    document: { getElementById: id => elements[id] || null },
    instanceBridge: () => ({
      cancelJavaInstall: async () => { cancelled.push('cancel'); return { success: true }; },
    }),
  });
  vm.runInContext(
    `${speedSource[0]}\n${etaSource[0]}\n${statsSource[0]}\n${progressSource[0]}\n${cancelSource[0]}`,
    context);

  vm.runInContext('settingsJavaProgress({ type: "start", major: 17 })', context);
  assert.equal(elements.settingsJavaProgress.style.display, 'block');
  assert.equal(elements.settingsJavaProgressLabel.textContent, 'Installing Java 17…');
  assert.equal(elements.settingsJavaProgressBar.style.width, '0%');

  vm.runInContext('settingsJavaProgress({ type: "progress", major: 17, message: "Downloading Java 17 (~40MB)…" })', context);
  assert.equal(elements.settingsJavaProgressDetail.textContent, 'Downloading Java 17 (~40MB)…');

  vm.runInContext('settingsJavaProgress({ type: "percent", major: 17, percent: 42 })', context);
  assert.equal(elements.settingsJavaProgressLabel.textContent, 'Installing Java 17 — 42%');
  assert.equal(elements.settingsJavaProgressBar.style.width, '42%');
  assert.equal(elements.settingsJavaProgressDetail.textContent, '',
    'a percent without throughput clears the previous download message');

  // 16 MB of a 40 MB file at ~4.2 MB/s: about six seconds left.
  vm.runInContext('settingsJavaProgress({ type: "percent", major: 17, percent: 40, received: 16777216, total: 41943040, bytesPerSecond: 4404019 })', context);
  assert.equal(elements.settingsJavaProgressLabel.textContent, 'Installing Java 17 — 40%');
  assert.equal(elements.settingsJavaProgressBar.style.width, '40%');
  assert.equal(elements.settingsJavaProgressDetail.textContent, '4.2 MB/s · 6s left');

  vm.runInContext('settingsJavaProgress({ type: "percent", major: 17, percent: 100, received: 41943040, total: 41943040, bytesPerSecond: 4404019 })', context);
  assert.equal(elements.settingsJavaProgressDetail.textContent, '4.2 MB/s',
    'no countdown once the download is complete');

  vm.runInContext('settingsJavaProgress({ type: "percent", major: 17, percent: 180 })', context);
  assert.equal(elements.settingsJavaProgressBar.style.width, '100%', 'percentages are clamped');

  assert.equal(vm.runInContext('formatDownloadSpeed(0)', context), '');
  assert.equal(vm.runInContext('formatDownloadSpeed(2048)', context), '2.0 KB/s');
  assert.equal(vm.runInContext('formatDownloadSpeed(512 * 1024 * 1024)', context), '512.0 MB/s');
  assert.equal(vm.runInContext('formatDownloadEta(0.4)', context), 'almost done');
  assert.equal(vm.runInContext('formatDownloadEta(9.2)', context), '9s left');
  assert.equal(vm.runInContext('formatDownloadEta(125)', context), '2m 5s left');
  assert.equal(vm.runInContext('formatDownloadEta(120)', context), '2m left');
  assert.equal(vm.runInContext('formatDownloadEta(0)', context), '');
  assert.equal(vm.runInContext('downloadSpeedLine(null)', context), '');
  assert.equal(vm.runInContext('downloadSpeedLine({ bytesPerSecond: 0 })', context), '');

  vm.runInContext('settingsJavaProgress({ type: "done", major: 17, status: "installed" })', context);
  assert.equal(elements.settingsJavaProgressLabel.textContent, 'Java 17 installed');
  assert.equal(elements.settingsJavaProgressBar.style.width, '100%');

  vm.runInContext('settingsJavaProgress({ type: "done", major: 21, status: "launcher" })', context);
  assert.equal(elements.settingsJavaProgressLabel.textContent, 'Java 21 already available');

  await vm.runInContext('settingsCancelJavaInstall()', context);
  assert.deepEqual(cancelled, ['cancel']);
  assert.equal(elements.settingsJavaCancelBtn.disabled, true);
  assert.equal(elements.settingsJavaCancelBtn.textContent, 'Cancelling…');
  assert.equal(elements.settingsJavaProgressLabel.textContent, 'Cancelling after the current file…');
});

// Minecraft switched to calendar version numbers at 26.1, and that release is the
// first to require Java 25. Read as "1.<minor>", 26.2 looked like a 1.2 pack and
// got Java 8, which died with "class file version 69.0, only recognises 52.0".
test('a 26.2 instance gets Java 25 instead of falling through to Java 8', async () => {
  await withTempRoot(async root => {
    prepareClientCache(root, '26.2');
    const app = loadApp(root, {
      platform: 'linux',
      env: { JAVA_HOME: '' },
      javaVersion: command => (command.includes(`${path.sep}java25${path.sep}`) ? 25 : 0),
      execFileSync: extractWithTar(),
      routes: {
        'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json': {
          versions: [{ id: '26.2', url: 'https://fixture.invalid/26.2.json' }],
        },
        [adoptiumUrl(25)]: adoptiumResponse(25),
        'https://fixture.invalid/jre-25.tar.gz': Buffer.from('25'),
      },
    });

    writeInstance(app, 'inst_262', { mcVersion: '26.2' });
    const result = await app.exposed.craftdockInstance.launch({ id: 'inst_262' });

    assert.equal(result.success, true, result.error);
    assert.deepEqual(adoptiumRequests(app), [adoptiumUrl(25)],
      'a 26.x pack asks for Java 25, not Java 8');
    assert.equal(launchCommand(app), path.join(app.dataDir, 'java', 'java25', 'bin', 'java'));
  });
});

// The runtime Mojang states per release wins over any local table, which is the
// only reliable answer for snapshots.
test('the Java stated in the version JSON is used when it differs', async () => {
  await withTempRoot(async root => {
    const { versionDir } = prepareClientCache(root, '26.2');
    fs.writeFileSync(path.join(versionDir, 'version.json'), JSON.stringify({
      mainClass: 'net.minecraft.client.main.Main',
      downloads: { client: { url: 'https://fixture.invalid/26.2-client.jar' } },
      libraries: [],
      javaVersion: { component: 'java-runtime-epsilon', majorVersion: 21 },
      assetIndex: { id: 'fixture', url: 'https://fixture.invalid/asset-index.json' },
    }));

    const jdk = path.join(root, 'jdk-21');
    const systemJava = makeJava(root, path.join('jdk-21', 'bin', 'java'));
    const app = loadApp(root, {
      platform: 'linux',
      env: { JAVA_HOME: jdk },
      javaVersion: command => (command === systemJava ? 21 : 0),
      routes: {
        'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json': {
          versions: [{ id: '26.2', url: 'https://fixture.invalid/26.2.json' }],
        },
      },
    });

    writeInstance(app, 'inst_stated', { mcVersion: '26.2' });
    const result = await app.exposed.craftdockInstance.launch({ id: 'inst_stated' });

    assert.equal(result.success, true, result.error);
    assert.equal(launchCommand(app), systemJava, 'the release itself named Java 21');
    assert.deepEqual(adoptiumRequests(app), [], 'nothing had to be downloaded');
  });
});

// The renderer keeps its own copy of the table for the pickers; it has to agree.
test('the renderer picker table matches the calendar versions', () => {
  const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');
  const match = renderer.match(/^function javaRequiredForMc\(mcVersion\) \{[\s\S]*?\r?\n\}/m);
  assert.ok(match, 'javaRequiredForMc() exists in the renderer');

  const context = vm.createContext({});
  vm.runInContext(`${match[0]}\nvar pick = javaRequiredForMc;`, context);
  const required = version => vm.runInContext(`pick(${JSON.stringify(version)})`, context);

  assert.equal(required('26.2'), 25);
  assert.equal(required('26.1'), 25);
  assert.equal(required('26.2-snapshot-8'), 25);
  assert.equal(required('1.21.4'), 21);
  assert.equal(required('1.20.4'), 21);
  assert.equal(required('1.19.2'), 17);
  assert.equal(required('1.17'), 16);
  assert.equal(required('1.16.5'), 8);
});

test('java detection prefers the user\'s Java over a launcher copy and never downloads', async () => {
  await withTempRoot(async root => {
    const jdk = path.join(root, 'jdk-17');
    const systemJava = makeJava(root, path.join('jdk-17', 'bin', 'java.exe'));
    const app = loadApp(root, {
      platform: 'win32',
      env: { JAVA_HOME: jdk },
      javaVersion: command => {
        if (command === systemJava) return 17;
        if (command.includes(`${path.sep}java21${path.sep}`)) return 21;
        return 0;
      },
    });
    const managed = makeJava(app.dataDir, path.join('java', 'java21', 'bin', 'java.exe'));

    const detected = plain(await app.exposed.craftdockServer.detectJava());
    const byExe = new Map(detected.map(entry => [entry.exe, entry]));

    assert.equal(byExe.get(systemJava)?.source, 'system');
    assert.equal(byExe.get(managed)?.source, 'launcher-bundled');
    assert.deepEqual(adoptiumRequests(app), []);
    assert.deepEqual(app.fetchCalls, []);
  });
});
