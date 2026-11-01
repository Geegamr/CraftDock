// Multi-instance launching: two profiles can run at once, the same profile can
// run twice, and stopping one never touches another profile's process.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadApp, plain, prepareClientCache, withTempRoot, writeInstance,
} = require('./helpers/electron-app');

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
    const app = loadApp(root, { routes: manifestRoute });
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
    const app = loadApp(root, { routes: manifestRoute });
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
    const app = loadApp(root, { routes: manifestRoute });
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
    const app = loadApp(root, { routes: manifestRoute });
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
