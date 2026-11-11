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

test('launch is refused when no Microsoft account is signed in', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    writeInstance(app, 'inst_no_account');

    const result = await app.exposed.craftdockInstance.launch({ id: 'inst_no_account' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'NO_ACCOUNT');
    assert.equal(
      app.spawnCalls.filter(call => Array.isArray(call.args) && call.args.includes('--gameDir')).length,
      0,
      'no Java process was spawned',
    );

    const statuses = app.events.filter(([channel]) => channel === 'instance-launch-status');
    assert.ok(statuses.some(([, , status]) => status === 'error'), 'the UI is told the launch failed');
    assert.ok(!statuses.some(([, , status]) => status === 'starting'), 'the launch never started');
  });
});

test('account heads use the in-game UUID or username and the account card no longer prints the identifier', () => {
  const start = renderer.indexOf('function accountHeadUrl');
  const end = renderer.indexOf('const InstanceStore = {', start);
  assert.ok(start >= 0 && end > start, 'the renderer defines its Minecraft head helper');
  const sandbox = {};
  vm.runInNewContext(`${renderer.slice(start, end)}\nglobalThis.accountHeadUrl = accountHeadUrl;`, sandbox);

  assert.equal(
    sandbox.accountHeadUrl({ minecraftUuid: 'abc-123', minecraftUsername: 'Steve' }),
    'https://mc-heads.net/avatar/abc-123/64',
    'the profile UUID is preferred for the in-game head',
  );
  assert.equal(
    sandbox.accountHeadUrl({ minecraftUsername: 'A B' }),
    'https://mc-heads.net/avatar/A%20B/64',
    'the in-game username is the fallback when no UUID is stored',
  );
  assert.equal(sandbox.accountHeadUrl(null), '');

  const cardStart = renderer.indexOf('grid.innerHTML = accounts.map');
  const cardEnd = renderer.indexOf('async function renderInstanceAccountPicker', cardStart);
  const cards = renderer.slice(cardStart, cardEnd);
  assert.match(cards, /accountHeadMarkup\(a\)/);
  assert.doesNotMatch(cards, /\$\{a\.id\}<\/div>/);
  assert.match(renderer, /id="instanceAccountPicker"/);
  assert.match(renderer, /id="libraryAccountPicker"/);
  assert.match(renderer, /id="homeAccountPicker"/);
  assert.match(renderer, /data-account-id/);
  assert.match(renderer, /querySelectorAll\('\[data-account-picker\]'\)/);

  const homeStart = renderer.indexOf('<div class="page active" id="page-home">');
  const homeEnd = renderer.indexOf('<!-- ── INSTANCES ── -->', homeStart);
  const home = renderer.slice(homeStart, homeEnd);
  assert.match(home, /id="homeAccountPicker"/, 'the home stat slot holds the account picker');
  assert.doesNotMatch(home, /id="statAccounts"/, 'the home account count is gone');
  assert.doesNotMatch(renderer, /statAccounts/, 'nothing still updates a home account count');
  assert.match(renderer, /function refreshHomePage\(\) \{[\s\S]*?renderInstanceAccountPicker\(\)/,
    'refreshing Home hydrates its account picker');
  assert.doesNotMatch(renderer, /\.library-account-picker \.instance-account-head\{[^}]*border-radius:50%/,
    'the library account head is a rounded square, not a circle');
  assert.match(renderer, /\.home-account-picker \.home-account-head\{width:38px;height:38px;border-radius:9px\}/,
    'the home account head is a rounded square');

  const toolbarStart = renderer.indexOf('<div class="library-toolbar">');
  const toolbarEnd = renderer.indexOf('<div class="library-scroll">', toolbarStart);
  assert.match(renderer.slice(toolbarStart, toolbarEnd), /id="libraryAccountPicker"/,
    'the library toolbar carries its own account picker');
  assert.match(renderer, /function showLibraryView\(\) \{[\s\S]*?renderInstanceAccountPicker\(\)/,
    'opening the library refreshes the picker');
});

test('selecting an expired account from the picker starts the Microsoft sign-in flow', async () => {
  const start = renderer.indexOf('async function selectInstanceAccount');
  const end = renderer.indexOf('\ndocument.addEventListener', start);
  assert.ok(start >= 0 && end > start, 'the picker selection helper exists');
  const source = renderer.slice(start, end);

  const calls = [];
  const accounts = [
    { id: 'ms_healthy', name: 'Healthy', active: true },
    { id: 'ms_expired', name: 'Expired', needsReauth: true },
  ];
  const sandbox = {
    closeInstanceAccountMenu: () => calls.push('close'),
    AccountStore: { getAll: async () => accounts },
    setActiveAccount: async id => calls.push(`active:${id}`),
    signInAgain: async id => calls.push(`signin:${id}`),
  };
  vm.runInNewContext(`${source}\nglobalThis.selectInstanceAccount = selectInstanceAccount;`, sandbox);

  await sandbox.selectInstanceAccount('ms_expired');
  assert.deepEqual(calls, ['close', 'active:ms_expired', 'signin:ms_expired']);

  calls.length = 0;
  await sandbox.selectInstanceAccount('ms_healthy');
  assert.deepEqual(calls, ['close'], 'a healthy active account needs no extra work');

  calls.length = 0;
  accounts[0].needsReauth = true;
  await sandbox.selectInstanceAccount('ms_healthy');
  assert.deepEqual(calls, ['close', 'signin:ms_healthy'], 'an expired active account goes straight to sign-in');
});

test('signed-in accounts place the sign-in explainer in a right-hand three-row column', () => {
  const start = renderer.indexOf('<div class="page" id="page-accounts">');
  const end = renderer.indexOf('<!-- MICROSOFT LOGIN MODAL -->', start);
  assert.ok(start >= 0 && end > start, 'the Accounts page exists');
  const accountPage = renderer.slice(start, end);

  assert.match(accountPage, /<div class="accounts-view">/);
  assert.match(accountPage, /<div class="accounts-layout" id="acctLayout">/);
  assert.match(accountPage, /<aside class="auth-flow" id="acctAuthFlow" aria-label="How Microsoft sign-in works" hidden>/);
  assert.equal((accountPage.match(/class="auth-flow-step"/g) || []).length, 3, 'the explainer has three steps');
  assert.ok(
    accountPage.indexOf('id="acctGrid"') < accountPage.indexOf('id="acctAuthFlow"'),
    'the explainer follows the account list and sits in the right-hand column',
  );

  assert.match(renderer, /\.accounts-layout\.signed-in\{grid-template-columns:minmax\(0,1fr\) 300px\}/);
  assert.match(renderer, /\.auth-flow\{display:grid;grid-template-columns:1fr;gap:12px;min-width:0\}/);
  assert.match(
    renderer,
    /const signedIn = accounts\.length > 0;[\s\S]*?if \(authFlow\) authFlow\.hidden = !signedIn;/,
    'the explainer is only revealed for a stored account',
  );
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
