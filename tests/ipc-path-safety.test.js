// Regression coverage for the file-operation boundary: every name the renderer
// can pass must stay inside the folder it belongs to, and a refused name must
// not touch anything outside it. Covers the sweep that also found the dormant
// auto-backup timer and the world-seed replacement-pattern bug.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, plain, makeZip, withTempRoot } = require('./helpers/electron-app');

async function createInstance(app, id, name = 'Alpha') {
  const created = plain(await app.exposed.craftdockInstance.create({ id, name, mcVersion: '1.21.4' }));
  assert.equal(created.success, true);
  return created.dir;
}

async function createServerFolder(app, id, name) {
  const slug = plain(await app.exposed.craftdockInstance.registerSlug(id, name, 'server')).slug;
  const dir = path.join(app.serversDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A directory link whose target can be removed, leaving a dangling entry.
function makeJunction(linkTarget, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(linkTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

test('an instance id of ".." cannot delete the launcher data root', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const marker = path.join(app.dataRoot, 'keep-me.txt');
    fs.writeFileSync(marker, 'still here');
    const dir = await createInstance(app, 'inst_guard', 'Guard');

    await assert.rejects(app.exposed.craftdockInstance.delete('..'));

    assert.equal(fs.readFileSync(marker, 'utf8'), 'still here');
    assert.equal(fs.existsSync(path.join(dir, 'instance.json')), true);
    assert.deepEqual(plain(await app.exposed.craftdockInstance.delete('inst_guard')), { success: true, removedPools: [] });
    assert.equal(fs.existsSync(dir), false);
  });
});

test('deleting a mod refuses a name that escapes the mods folder', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const dir = await createInstance(app, 'inst_mods', 'Mods');
    fs.writeFileSync(path.join(dir, 'mods', 'ok.jar'), 'jar bytes');

    const escaped = plain(await app.exposed.craftdockInstance.deleteMod('inst_mods', '../../keep-me.txt'));
    assert.equal(escaped.success, false);
    assert.equal(fs.existsSync(path.join(dir, 'instance.json')), true);
    assert.deepEqual(plain(await app.exposed.craftdockInstance.deleteMod('inst_mods', 'ok.jar')), { success: true });
    assert.equal(fs.existsSync(path.join(dir, 'mods', 'ok.jar')), false);
  });
});

test('downloading a mod refuses a filename outside the mods folder', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, { routes: { 'https://cdn.invalid/evil.jar': 'evil' } });
    const dir = await createInstance(app, 'inst_dl', 'Download');

    const escaped = plain(await app.exposed.craftdockInstance.downloadMod('inst_dl', 'https://cdn.invalid/evil.jar', '../../escaped.jar'));
    assert.equal(escaped.success, false);
    assert.equal(fs.existsSync(path.join(app.dataRoot, 'escaped.jar')), false);
    assert.equal(fs.existsSync(path.join(app.instancesDir, 'escaped.jar')), false);

    const inside = plain(await app.exposed.craftdockInstance.downloadMod('inst_dl', 'https://cdn.invalid/evil.jar', 'fine.jar'));
    assert.equal(inside.success, true);
    assert.equal(fs.readFileSync(path.join(dir, 'mods', 'fine.jar'), 'utf8'), 'evil');
  });
});

test('resource pack rename and delete refuse names outside their folder', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const dir = await createInstance(app, 'inst_res', 'Res');
    fs.writeFileSync(path.join(dir, 'resourcepacks', 'faithful.zip'), 'pack');
    const marker = path.join(app.dataRoot, 'keep-me.txt');
    fs.writeFileSync(marker, 'keep');

    assert.equal(plain(await app.exposed.craftdockInstance.deleteResFile('inst_res', 'resourcepacks', '../../keep-me.txt')).success, false);
    assert.equal(fs.existsSync(marker), true, 'the file inside the data root survives');

    const toggled = await app.exposed.craftdockInstance.toggleResFile('inst_res', '..', 'keep-me.txt', false);
    assert.equal(plain(toggled).success, false);
    assert.equal(fs.existsSync(marker), true);
    assert.equal(fs.existsSync(marker + '.disabled'), false);

    assert.deepEqual(plain(await app.exposed.craftdockInstance.toggleResFile('inst_res', 'resourcepacks', 'faithful.zip', false)), { success: true });
    assert.equal(fs.existsSync(path.join(dir, 'resourcepacks', 'faithful.zip.disabled')), true);
  });
});

test('config file editing stays inside the instances folder', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const dir = await createInstance(app, 'inst_cfg', 'Cfg');
    const configFile = path.join(dir, 'config', 'mod.toml');
    fs.writeFileSync(configFile, 'value = 1');

    const read = plain(await app.exposed.craftdockInstance.readConfigFile(configFile));
    assert.equal(read.success, true);
    assert.equal(read.text, 'value = 1');
    assert.deepEqual(plain(await app.exposed.craftdockInstance.writeConfigFile(configFile, 'value = 2')), { success: true });
    assert.equal(fs.readFileSync(configFile, 'utf8'), 'value = 2');

    const outside = path.join(app.dataDir, 'craftdock_accounts.json');
    fs.writeFileSync(outside, '[]');
    assert.equal(plain(await app.exposed.craftdockInstance.writeConfigFile(outside, '["pwned"]')).success, false);
    assert.equal(plain(await app.exposed.craftdockInstance.readConfigFile(outside)).success, false);
    assert.equal(fs.readFileSync(outside, 'utf8'), '[]');
  });
});

test('one unreadable folder entry does not hide the rest of the listing', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const dir = await createInstance(app, 'inst_list', 'List');
    fs.writeFileSync(path.join(dir, 'resourcepacks', 'faithful.zip'), 'pack');
    const target = path.join(app.dataRoot, 'vanishing-target');
    fs.mkdirSync(target, { recursive: true });
    makeJunction(target, path.join(dir, 'resourcepacks', 'stale'));
    fs.rmSync(target, { recursive: true, force: true });

    const files = plain(await app.exposed.craftdockInstance.listFolder('inst_list', 'resourcepacks'));
    assert.deepEqual(files.map(file => file.name), ['faithful.zip']);
    assert.deepEqual(plain(await app.exposed.craftdockInstance.listFolder('inst_list', '..')), []);
  });
});

test('a modpack that writes outside its instance is refused', async () => {
  await withTempRoot(async root => {
    const packUrl = 'https://packs.invalid/evil.mrpack';
    const index = {
      formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name: 'Evil',
      dependencies: { minecraft: '1.21.4', 'fabric-loader': '0.16.0' },
      files: [{ path: '../../escaped.jar', downloads: ['https://cdn.invalid/escaped.jar'], hashes: {}, fileSize: 1 }],
    };
    const app = loadApp(root, {
      routes: {
        [packUrl]: makeZip([['modrinth.index.json', JSON.stringify(index)]]),
        'https://cdn.invalid/escaped.jar': 'evil jar',
      },
    });
    const dir = await createInstance(app, 'inst_pack', 'Pack');

    const result = plain(await app.exposed.craftdockInstance.installModpack('inst_pack', packUrl));

    assert.equal(result.success, false);
    assert.match(result.error, /outside the instance/);
    assert.equal(fs.existsSync(path.join(app.dataRoot, 'escaped.jar')), false);
    assert.equal(fs.existsSync(path.join(app.instancesDir, 'escaped.jar')), false);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'mods')), []);
  });
});

test('server file operations refuse names outside the server folder', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const dir = await createServerFolder(app, 'srv_guard', 'Guard Server');
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=hi\n');
    const marker = path.join(app.dataRoot, 'keep-me.txt');
    fs.writeFileSync(marker, 'keep');

    assert.equal(plain(await app.exposed.craftdockServer.removeFile('srv_guard', 'plugins', '../../keep-me.txt')).success, false);
    assert.equal(plain(await app.exposed.craftdockServer.toggleFile('srv_guard', '..', 'keep-me.txt', false)).success, false);
    assert.equal(plain(await app.exposed.craftdockServer.patchJsonFile('srv_guard', '../keep-me.txt', ['pwned'])).success, false);
    assert.deepEqual(plain(await app.exposed.craftdockServer.readJsonFile('srv_guard', '../keep-me.txt')), []);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');

    const backups = path.join(dir, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(backups, 'world-backup-1.zip'), makeZip([['world/level.dat', 'world']]));
    assert.equal(plain(await app.exposed.craftdockServer.setBackupConfig('srv_guard', 0, 0)).success, true);
    assert.equal(plain(await app.exposed.craftdockServer.deleteBackup('srv_guard', '../../keep-me.txt')).success, false);
    assert.equal(fs.existsSync(marker), true);
    assert.deepEqual(plain(await app.exposed.craftdockServer.listBackups('srv_guard')).map(b => b.filename), ['world-backup-1.zip']);
    assert.deepEqual(plain(await app.exposed.craftdockServer.deleteBackup('srv_guard', 'world-backup-1.zip')), { success: true });
  });
});

test('a failed plugin download is reported instead of saving the error page', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, { routes: {} }); // every URL answers 404
    const dir = await createServerFolder(app, 'srv_plugin', 'Plugin Server');

    const result = plain(await app.exposed.craftdockServer.downloadToFolder(
      'srv_plugin', 'https://cdn.invalid/missing.jar', 'missing.jar', 'plugins',
    ));

    assert.equal(result.success, false);
    const dest = path.join(dir, 'plugins', 'missing.jar');
    assert.ok(!fs.existsSync(dest) || fs.statSync(dest).size === 0, 'no error page is kept as a plugin');

    const escaped = plain(await app.exposed.craftdockServer.downloadToFolder(
      'srv_plugin', 'https://cdn.invalid/missing.jar', 'missing.jar', '../..',
    ));
    assert.equal(escaped.success, false);
  });
});

test('scheduled auto-backups actually create a world zip', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, { javaVersion: () => 21 });
    const dir = await createServerFolder(app, 'srv_auto', 'Auto Server');
    fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'world bytes');
    fs.writeFileSync(path.join(dir, 'server.jar'), 'jar bytes');

    const started = plain(await app.exposed.craftdockServer.start({
      id: 'srv_auto', name: 'Auto Server', version: '1.21.4', software: 'vanilla',
      jarName: 'server.jar', javaPath: 'java',
    }));
    assert.equal(started.success, true);

    assert.deepEqual(plain(await app.exposed.craftdockServer.setBackupConfig('srv_auto', 60, 0)), { success: true });
    const timer = app.intervals.find(entry => entry.delay === 60 * 60 * 1000);
    assert.ok(timer, 'the auto-backup interval was scheduled');

    await timer.callback();

    const backups = plain(await app.exposed.craftdockServer.listBackups('srv_auto'));
    assert.equal(backups.length, 1);
    assert.match(backups[0].filename, /^world-backup-.+\.zip$/);
    assert.ok(app.events.some(([channel, id]) => channel === 'backup-created' && id === 'srv_auto'));
  });
});

test('a world seed is written literally, without replacement patterns', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const dir = await createServerFolder(app, 'srv_seed', 'Seed Server');
    fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
    const propertiesPath = path.join(dir, 'server.properties');
    fs.writeFileSync(propertiesPath, 'motd=hi\nlevel-seed=old\n');

    const result = plain(await app.exposed.craftdockServer.resetWorld('srv_seed', null, "$&-$'", false));

    assert.deepEqual(result, { success: true });
    const text = fs.readFileSync(propertiesPath, 'utf8');
    assert.match(text, /^motd=hi$/m);
    assert.match(text, /^level-seed=\$&-\$'$/m);
    assert.equal(text.split('\n').filter(line => line.startsWith('level-seed=')).length, 1);
    assert.equal(fs.existsSync(path.join(dir, 'world')), false);
  });
});

test('absolute, UNC, drive-relative and backslash names cannot escape either', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const instanceDir = await createInstance(app, 'inst_abs', 'Abs');
    const marker = path.join(app.dataRoot, 'keep-me.txt');
    fs.writeFileSync(marker, 'keep');

    const names = [
      marker,                        // absolute path
      '\\\\localhost\\share\\x.jar',  // UNC share
      '..\\..\\keep-me.txt',         // backslash traversal
    ];
    for (const name of names) {
      assert.equal(plain(await app.exposed.craftdockInstance.deleteMod('inst_abs', name)).success, false, `delete refused: ${name}`);
      assert.equal(plain(await app.exposed.craftdockInstance.deleteResFile('inst_abs', 'resourcepacks', name)).success, false, `delete refused: ${name}`);
      assert.equal(plain(await app.exposed.craftdockInstance.downloadMod('inst_abs', 'https://cdn.invalid/x.jar', name)).success, false, `download refused: ${name}`);
    }

    assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(instanceDir, 'instance.json')), true);

    // A drive-relative name is not an escape: Windows resolves it to a literal
    // name inside the folder, so nothing outside the instance is reachable.
    await app.exposed.craftdockInstance.deleteMod('inst_abs', 'C:escape.jar');
    assert.equal(fs.existsSync(marker), true);
    assert.equal(fs.existsSync(path.join(app.dataRoot, 'escape.jar')), false);
    assert.equal(fs.existsSync(path.join(app.instancesDir, 'escape.jar')), false);

    for (const id of ['..', '../..', null]) {
      await assert.rejects(app.exposed.craftdockInstance.readServersDat(id), /Invalid id/);
    }
    // A non-string id is coerced to a harmless folder name, never the data root.
    for (const id of [42, {}]) {
      assert.deepEqual(plain(await app.exposed.craftdockInstance.readServersDat(id)), []);
    }
  });
});
