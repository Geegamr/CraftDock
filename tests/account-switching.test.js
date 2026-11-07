// Multi-account switching: the renderer's real AccountStore writes through the
// file store, and the launcher picks the active account's identity/token.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  loadApp, plain, prepareClientCache, projectRoot, withTempRoot, writeInstance,
} = require('./helpers/electron-app');

const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');

function accountStoreSource() {
  const start = renderer.indexOf('const AccountStore = {');
  const end = renderer.indexOf('const InstanceStore = {', start);
  assert.ok(start >= 0 && end > start, 'the renderer defines AccountStore');
  return renderer.slice(start, end);
}

// Evaluates the renderer's AccountStore against the production file store.
function loadAccountStore(store) {
  const sandbox = {
    Store: store,
    console: { warn() {}, error() {}, log() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${accountStoreSource()}\nglobalThis.AccountStore = AccountStore;`, sandbox);
  return sandbox.AccountStore;
}

const accountFile = app => path.join(app.dataDir, 'craftdock_accounts.json');

function account(id, name, token) {
  return {
    id,
    name,
    minecraftUsername: name,
    minecraftUuid: `uuid-${id}`,
    minecraftToken: token,
    mcTokenExpiry: Date.now() + 60 * 60 * 1000,
    type: 'microsoft',
    active: false,
  };
}

function javaArgs(app) {
  const call = [...app.spawnCalls].reverse().find(candidate =>
    Array.isArray(candidate.args) && candidate.args.includes('--username'));
  assert.ok(call, 'Java was launched with a username');
  const valueAfter = flag => call.args[call.args.indexOf(flag) + 1];
  return { call, username: valueAfter('--username'), token: valueAfter('--accessToken'), uuid: valueAfter('--uuid') };
}

test('AccountStore keeps several accounts and exactly one active account', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const store = app.exposed.craftdock.store;
    const AccountStore = loadAccountStore({
      get: key => store.get(key),
      set: (key, value) => store.set(key, value),
      delete: key => store.delete(key),
    });

    const first = account('ms_alpha', 'Alpha', 'token-alpha');
    first.active = true;
    await AccountStore.save(first);
    await AccountStore.save(account('ms_beta', 'Beta', 'token-beta'));

    assert.equal((await AccountStore.getAll()).length, 2);
    assert.equal((await AccountStore.getActive()).name, 'Alpha');

    await AccountStore.setActive('ms_beta');
    const accounts = await AccountStore.getAll();
    assert.deepEqual(plain(accounts.filter(item => item.active).map(item => item.name)), ['Beta']);
    assert.equal((await AccountStore.getActive()).name, 'Beta');

    // The file on disk holds the same choice, with tokens encrypted at rest.
    const onDisk = JSON.parse(fs.readFileSync(accountFile(app), 'utf8'));
    assert.deepEqual(onDisk.filter(item => item.active).map(item => item.id), ['ms_beta']);
    assert.ok(!fs.readFileSync(accountFile(app), 'utf8').includes('token-beta'));
    assert.equal(onDisk.find(item => item.id === 'ms_beta').minecraftToken, undefined);

    // Reading through the store decrypts tokens again for the renderer.
    const decrypted = await store.get('craftdock:accounts');
    assert.equal(decrypted.find(item => item.id === 'ms_beta').minecraftToken, 'token-beta');

    await AccountStore.remove('ms_beta');
    assert.deepEqual(plain(await AccountStore.getAll()).map(item => item.id), ['ms_alpha']);
    assert.equal((await AccountStore.getActive()).name, 'Alpha');
  });
});

test('AccountStore falls back to the first account when none is marked active', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const store = app.exposed.craftdock.store;
    const AccountStore = loadAccountStore({
      get: key => store.get(key),
      set: (key, value) => store.set(key, value),
      delete: key => store.delete(key),
    });

    await store.set('craftdock:accounts', [
      { id: 'ms_one', name: 'One' },
      { id: 'ms_two', name: 'Two' },
    ]);

    assert.equal((await AccountStore.getActive()).name, 'One');

    // Activating an unknown id leaves no active account, so lookup falls back.
    await AccountStore.setActive('ms_missing');
    assert.deepEqual(plain((await AccountStore.getAll()).map(item => item.active)), [false, false]);
    assert.equal((await AccountStore.getActive()).name, 'One');
  });
});

test('switching the active account changes the next launch identity and token', async () => {
  await withTempRoot(async root => {
    prepareClientCache(root);
    const app = loadApp(root, {
      routes: {
        'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json': {
          versions: [{ id: '1.16.5', url: 'https://fixture.invalid/1.16.5.json' }],
        },
      },
    });
    writeInstance(app, 'inst_play');
    await app.exposed.craftdockInstance.create({ id: 'inst_account', name: 'Account Pack', mcVersion: '1.16.5' });

    const store = app.exposed.craftdock.store;
    const AccountStore = loadAccountStore({
      get: key => store.get(key),
      set: (key, value) => store.set(key, value),
      delete: key => store.delete(key),
    });

    const alpha = account('ms_alpha', 'Alpha', 'token-alpha');
    alpha.active = true;
    await AccountStore.save(alpha);
    await AccountStore.save(account('ms_beta', 'Beta', 'token-beta'));

    const firstLaunch = await app.exposed.craftdockInstance.launch({ id: 'inst_play' });
    assert.equal(firstLaunch.success, true);
    const firstArgs = javaArgs(app);
    assert.equal(firstArgs.username, 'Alpha');
    assert.equal(firstArgs.token, 'token-alpha');
    assert.equal(firstArgs.uuid, 'uuid-ms_alpha');

    await AccountStore.setActive('ms_beta');
    const secondLaunch = await app.exposed.craftdockInstance.launch({ id: 'inst_account' });
    assert.equal(secondLaunch.success, true);

    const secondArgs = javaArgs(app);
    assert.equal(secondArgs.username, 'Beta');
    assert.equal(secondArgs.token, 'token-beta');
    assert.equal(secondArgs.uuid, 'uuid-ms_beta');
    assert.deepEqual(
      plain(app.invocations.map(([channel]) => channel).filter(channel => channel === 'instance-launch')),
      ['instance-launch', 'instance-launch'],
    );
  });
});

test('accounts signed in under another client ID are flagged for a fresh sign-in', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, { env: { MS_CLIENT_ID: 'client-current' } });
    const store = app.exposed.craftdock.store;

    await store.set('craftdock:accounts', [
      { id: 'ms_old', name: 'Old', authClientId: 'client-legacy', active: true },
      { id: 'ms_new', name: 'New', authClientId: 'client-current' },
      { id: 'ms_unknown', name: 'Unknown' },
    ]);

    const accounts = await store.get('craftdock:accounts');
    const byId = id => accounts.find(item => item.id === id);

    assert.equal(byId('ms_old').needsReauth, true);
    assert.equal(byId('ms_old').reauthReason, 'client_changed');
    assert.equal(byId('ms_new').needsReauth, undefined);
    assert.equal(byId('ms_unknown').needsReauth, undefined);
  });
});
