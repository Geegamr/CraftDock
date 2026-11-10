// Multi-instance launching: two profiles can run at once, the same profile can
// run twice, and stopping one never touches another profile's process.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadApp, seedAccount, plain, prepareClientCache, withTempRoot, writeInstance,
} = require('./helpers/electron-app');

function loadLaunchApp(root, options) {
  const app = loadApp(root, options);
  seedAccount(root);
  return app;
}

const manifestRoute = {
  'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json': {
    versions: [{ id: '1.16.5', url: 'https://fixture.invalid/1.16.5.json' }],
  },
};

function launchCall(app, gameDir) {
  return app.spawnCalls.find(call =>
    Array.isArray(call.args)
    && call.args.includes('--gameDir')
    && call.args[call.args.indexOf('--gameDir') + 1] === gameDir);
}

function gameDirs(app) {
  return app.spawnCalls
    .filter(call => Array.isArray(call.args) && call.args.includes('--gameDir'))
    .map(call => call.args[call.args.indexOf('--gameDir') + 1]);
}

test('two simultaneously running instances each launch with their own game directory', async () => {
  await withTempRoot(async root => {
    prepareClientCache(root);
    const app = loadLaunchApp(root, { routes: manifestRoute });
    const alphaDir = writeInstance(app, 'inst_alpha', { name: 'Alpha' });
    const betaDir = writeInstance(app, 'inst_beta', { name: 'Beta' });

    const [alpha, beta] = await Promise.all([
      app.exposed.craftdockInstance.launch({ id: 'inst_alpha' }),
      app.exposed.craftdockInstance.launch({ id: 'inst_beta' }),
    ]);

    assert.equal(alpha.success, true);
    assert.equal(beta.success, true);
    assert.notEqual(alpha.pid, beta.pid, 'each instance gets its own process');
    assert.deepEqual(gameDirs(app).sort(), [alphaDir, betaDir].sort());
    assert.equal(launchCall(app, alphaDir).args.filter(arg => arg === '--username').length, 1);

    // Each instance's meta records its own last-played timestamp.
    for (const dir of [alphaDir, betaDir]) {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
      assert.equal(typeof meta.lastPlayed, 'number');
    }
  });
});

test('the same instance can run twice and both copies are tracked', async () => {
  await withTempRoot(async root => {
    prepareClientCache(root);
    const app = loadLaunchApp(root, { routes: manifestRoute });
    writeInstance(app, 'inst_twice');

    const first = await app.exposed.craftdockInstance.launch({ id: 'inst_twice' });
    const second = await app.exposed.craftdockInstance.launch({ id: 'inst_twice' });
    assert.equal(first.success, true);
    assert.equal(second.success, true);

    const stopped = await app.exposed.craftdockInstance.stopInstance('inst_twice');
    assert.deepEqual(plain(stopped), { success: true, killed: 2 });
    assert.equal(app.kills.length, 2);
    assert.deepEqual(app.kills.map(kill => kill.signal), ['SIGTERM', 'SIGTERM']);

    assert.deepEqual(plain(await app.exposed.craftdockInstance.stopInstance('inst_twice')), {
      success: false, error: 'Not running',
    });
  });
});

test('stopping one instance leaves another instance running', async () => {
  await withTempRoot(async root => {
    prepareClientCache(root);
    const app = loadLaunchApp(root, { routes: manifestRoute });
    writeInstance(app, 'inst_one');
    writeInstance(app, 'inst_two');

    const one = await app.exposed.craftdockInstance.launch({ id: 'inst_one' });
    const two = await app.exposed.craftdockInstance.launch({ id: 'inst_two' });

    assert.deepEqual(plain(await app.exposed.craftdockInstance.stopInstance('inst_one')), { success: true, killed: 1 });
    assert.deepEqual(app.kills.map(kill => kill.pid), [one.pid]);

    assert.deepEqual(plain(await app.exposed.craftdockInstance.stopInstance('inst_two')), { success: true, killed: 1 });
    assert.deepEqual(app.kills.map(kill => kill.pid), [one.pid, two.pid]);
  });
});

test('a launch reports progress and success status for the instance it launched', async () => {
  await withTempRoot(async root => {
    prepareClientCache(root);
    const app = loadLaunchApp(root, { routes: manifestRoute });
    writeInstance(app, 'inst_status');

    await app.exposed.craftdockInstance.launch({ id: 'inst_status' });

    const statuses = app.events.filter(([channel]) => channel === 'instance-launch-status');
    assert.ok(statuses.every(([, id]) => id === 'inst_status'));
    assert.ok(statuses.some(([, , status]) => status === 'starting'));
    assert.ok(statuses.some(([, , status]) => status === 'launched'));
    assert.deepEqual(
      plain(app.invocations).map(([channel]) => channel),
      ['instance-launch'],
    );
  });
});

test('copying an instance creates a separate verified instance', async () => {
  await withTempRoot(async root => {
    const app = loadLaunchApp(root);
    const sourceDir = writeInstance(app, 'inst_copy_src', {
      name: 'Copy Source',
      totalPlayMinutes: 120,
      lastPlayed: 123456,
    });
    fs.mkdirSync(path.join(sourceDir, 'config', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'mods', 'example.jar'), 'mod bytes');
    fs.writeFileSync(path.join(sourceDir, 'config', 'nested', 'settings.toml'), 'enabled = true\n');

    const result = await app.exposed.craftdockInstance.copy('inst_copy_src');

    assert.equal(result.success, true);
    assert.notEqual(result.id, 'inst_copy_src');
    assert.equal(result.name, 'Copy Source (Copy)');
    assert.equal(result.files, 3);

    const slugMap = JSON.parse(fs.readFileSync(path.join(app.dataDir, 'slug-map.json'), 'utf8'));
    const copiedDir = path.join(app.instancesDir, slugMap[result.id]);
    assert.notEqual(copiedDir, sourceDir);
    assert.equal(fs.readFileSync(path.join(copiedDir, 'mods', 'example.jar'), 'utf8'), 'mod bytes');
    assert.equal(fs.readFileSync(path.join(copiedDir, 'config', 'nested', 'settings.toml'), 'utf8'), 'enabled = true\n');

    const meta = JSON.parse(fs.readFileSync(path.join(copiedDir, 'instance.json'), 'utf8'));
    assert.equal(meta.id, result.id);
    assert.equal(meta.name, 'Copy Source (Copy)');
    assert.equal(meta.totalPlayMinutes, 0);
    assert.equal(meta.lastPlayed, null);
    assert.ok(app.events.some(([channel]) => channel === 'instance-copy-progress'));
  });
});

test('NeoForge ignores both cached client jar names so they cannot become duplicate modules', async () => {
  await withTempRoot(async root => {
    prepareClientCache(root);
    const app = loadLaunchApp(root, { routes: manifestRoute });
    const dir = writeInstance(app, 'inst_ignore', {
      loader: 'neoforge',
      loaderVersion: '21.1.233',
    });

    const profileDir = path.join(
      root, 'craftdock-data', 'client-cache', 'loaders', 'neoforge-1.16.5',
      'versions', 'neoforge-21.1.233',
    );
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'neoforge-21.1.233.json'), JSON.stringify({
      id: 'neoforge-21.1.233',
      mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
      arguments: {
        jvm: ['-DignoreList=client-extra,${version_name}.jar', '--add-modules', 'ALL-MODULE-PATH'],
        game: [],
      },
      libraries: [],
    }));

    const result = await app.exposed.craftdockInstance.launch({ id: 'inst_ignore' });
    assert.equal(result.success, true);
    const args = launchCall(app, dir).args;
    const ignoreList = args.find(arg => arg.startsWith('-DignoreList='));
    assert.ok(ignoreList, 'the loader must receive an ignore list');
    assert.ok(ignoreList.includes('client-1.16.5.jar'));
    assert.ok(ignoreList.includes('minecraft-1.16.5-client.jar'));
    assert.equal(ignoreList.includes('neoforge-21.1.233.jar'), false);
  });
});

test('per-instance Java arguments are passed to the JVM as separate, quote-aware arguments', async () => {
  await withTempRoot(async root => {
    prepareClientCache(root);
    const app = loadLaunchApp(root, { routes: manifestRoute });
    const dir = writeInstance(app, 'inst_args', {
      javaArgs: '-XX:+UseZGC -Dexample="hello world" -Xss2M',
    });

    const result = await app.exposed.craftdockInstance.launch({ id: 'inst_args' });

    assert.equal(result.success, true);
    const args = launchCall(app, dir).args;
    assert.ok(args.includes('-XX:+UseZGC'));
    assert.ok(args.includes('-Dexample=hello world'), 'quoted values stay one argument');
    assert.ok(args.includes('-Xss2M'));
    assert.ok(args.indexOf('-Xss2M') < args.indexOf('-cp'), 'custom flags are JVM arguments');
  });
});
