// Shared tags: two instances that carry the same tag must point at the same
// saves/, servers.dat and resourcepacks/ folders, and switching or clearing the
// tag must re-point or restore the instance's own folder.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadApp, plain, withTempRoot,
} = require('./helpers/electron-app');

// Stands in for the Windows shell commands: `fsutil` reports a reparse point,
// `mklink /J|/D` makes a real directory junction, `mklink` makes a hard link
// (like the file symlink it emulates, removing it leaves the shared file), and
// `rmdir` removes the link without touching its target.
function junctionMock() {
  const linked = new Set();
  const run = command => {
    const fsutil = command.match(/^fsutil reparsepoint query "(.+?)"/);
    if (fsutil) return linked.has(fsutil[1]) ? 'Tag value: 0xa0000003' : 'ERROR: not a reparse point';
    const link = command.match(/^mklink (\/J |\/D )?"(.+?)" "(.+?)"$/);
    if (link) {
      const [, flag, target, source] = link;
      fs.mkdirSync(path.dirname(source), { recursive: true });
      if (flag) {
        fs.mkdirSync(source, { recursive: true });
        if (!fs.existsSync(target)) {
          fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
        }
      } else if (!fs.existsSync(target)) {
        fs.linkSync(source, target);
      }
      linked.add(target);
      return '';
    }
    const removed = command.match(/^rmdir "(.+?)"$/);
    if (removed) {
      if (linked.has(removed[1])) {
        fs.rmdirSync(removed[1]);
        linked.delete(removed[1]);
      }
      return '';
    }
    return '';
  };
  return { run, linked };
}

async function makeInstance(app, id, name) {
  const created = await app.exposed.craftdockInstance.create({ id, name, mcVersion: '1.21.4' });
  assert.equal(created.success, true);
  return created.dir;
}

function linkCommands(app) {
  return app.spawnCalls
    .filter(call => typeof call.execSync === 'string' && call.execSync.startsWith('mklink'))
    .map(call => call.execSync);
}

test('tagging an instance moves its worlds into the shared folder and links saves', async () => {
  await withTempRoot(async root => {
    const junctions = junctionMock();
    const app = loadApp(root, { execSync: junctions.run, platform: 'win32' });
    const instanceDir = await makeInstance(app, 'inst_a', 'Alpha');
    fs.mkdirSync(path.join(instanceDir, 'saves', 'Survival'), { recursive: true });
    fs.writeFileSync(path.join(instanceDir, 'saves', 'Survival', 'level.dat'), 'survival world');
    fs.mkdirSync(path.join(instanceDir, 'saves', 'Creative'), { recursive: true });

    const updated = await app.exposed.craftdockInstance.update({
      id: 'inst_a', name: 'Alpha', worldTag: 'Survival SMP',
    });
    assert.deepEqual(plain(updated), { success: true });

    const sharedDir = path.join(app.sharedWorldsDir, 'survival_smp');
    assert.equal(fs.readFileSync(path.join(sharedDir, 'Survival', 'level.dat'), 'utf8'), 'survival world');
    assert.ok(fs.existsSync(path.join(sharedDir, 'Creative')));
    assert.deepEqual(linkCommands(app), [`mklink /J "${path.join(instanceDir, 'saves')}" "${sharedDir}"`]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(instanceDir, 'instance.json'), 'utf8')).worldTag, 'Survival SMP');
  });
});

test('two instances with the same world tag share one folder', async () => {
  await withTempRoot(async root => {
    const junctions = junctionMock();
    const app = loadApp(root, { execSync: junctions.run, platform: 'win32' });
    const alpha = await makeInstance(app, 'inst_alpha', 'Alpha');
    const beta = await makeInstance(app, 'inst_beta', 'Beta');

    await app.exposed.craftdockInstance.update({ id: 'inst_alpha', name: 'Alpha', worldTag: 'coop' });
    fs.mkdirSync(path.join(alpha, 'saves', 'Alpha World'), { recursive: true });
    fs.writeFileSync(path.join(alpha, 'saves', 'Alpha World', 'level.dat'), 'alpha world');
    await app.exposed.craftdockInstance.update({ id: 'inst_beta', name: 'Beta', worldTag: 'coop' });
    fs.mkdirSync(path.join(beta, 'saves', 'Beta World'), { recursive: true });
    fs.writeFileSync(path.join(beta, 'saves', 'Beta World', 'level.dat'), 'beta world');

    const sharedDir = path.join(app.sharedWorldsDir, 'coop');
    assert.deepEqual(fs.readdirSync(sharedDir).sort(), ['Alpha World', 'Beta World']);
    assert.deepEqual(linkCommands(app), [
      `mklink /J "${path.join(alpha, 'saves')}" "${sharedDir}"`,
      `mklink /J "${path.join(beta, 'saves')}" "${sharedDir}"`,
    ]);
  });
});

test('changing the tag relinks saves and clearing it restores a real folder', async () => {
  await withTempRoot(async root => {
    const junctions = junctionMock();
    const app = loadApp(root, { execSync: junctions.run, platform: 'win32' });
    const instanceDir = await makeInstance(app, 'inst_switch', 'Switch');
    const saves = path.join(instanceDir, 'saves');

    await app.exposed.craftdockInstance.update({ id: 'inst_switch', name: 'Switch', worldTag: 'first' });
    await app.exposed.craftdockInstance.update({ id: 'inst_switch', name: 'Switch', worldTag: 'second' });

    assert.deepEqual(linkCommands(app), [
      `mklink /J "${saves}" "${path.join(app.sharedWorldsDir, 'first')}"`,
      `mklink /J "${saves}" "${path.join(app.sharedWorldsDir, 'second')}"`,
    ]);
    assert.ok(junctions.linked.has(saves));

    await app.exposed.craftdockInstance.update({ id: 'inst_switch', name: 'Switch', worldTag: null });

    assert.equal(junctions.linked.has(saves), false);
    assert.equal(fs.statSync(saves).isDirectory(), true, 'saves is a real folder again');
    assert.deepEqual(fs.readdirSync(saves), []);
  });
});

test('re-saving an instance without changing its tag does not relink', async () => {
  await withTempRoot(async root => {
    const junctions = junctionMock();
    const app = loadApp(root, { execSync: junctions.run, platform: 'win32' });
    const instanceDir = await makeInstance(app, 'inst_same', 'Same');
    fs.mkdirSync(path.join(instanceDir, 'saves', 'World'), { recursive: true });

    await app.exposed.craftdockInstance.update({ id: 'inst_same', name: 'Same', worldTag: 'stable' });
    await app.exposed.craftdockInstance.update({ id: 'inst_same', name: 'Renamed', worldTag: 'stable' });

    assert.equal(linkCommands(app).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(instanceDir, 'instance.json'), 'utf8')).name, 'Renamed');
  });
});

test('the server tag shares servers.dat between instances', async () => {
  await withTempRoot(async root => {
    const junctions = junctionMock();
    const app = loadApp(root, { execSync: junctions.run, platform: 'win32' });
    const alpha = await makeInstance(app, 'inst_srv_a', 'Server Alpha');
    const beta = await makeInstance(app, 'inst_srv_b', 'Server Beta');
    fs.writeFileSync(path.join(alpha, 'servers.dat'), 'alpha server list');

    await app.exposed.craftdockInstance.update({ id: 'inst_srv_a', name: 'Server Alpha', serverTag: 'Our SMP' });
    await app.exposed.craftdockInstance.update({ id: 'inst_srv_b', name: 'Server Beta', serverTag: 'Our SMP' });

    const sharedFile = path.join(app.sharedServersDir, 'our_smp', 'servers.dat');
    assert.equal(fs.readFileSync(sharedFile, 'utf8'), 'alpha server list');
    assert.deepEqual(linkCommands(app), [
      `mklink "${path.join(alpha, 'servers.dat')}" "${sharedFile}"`,
      `mklink "${path.join(beta, 'servers.dat')}" "${sharedFile}"`,
    ]);
  });
});

test('the resource tag shares resourcepacks between instances', async () => {
  await withTempRoot(async root => {
    const junctions = junctionMock();
    const app = loadApp(root, { execSync: junctions.run, platform: 'win32' });
    const alpha = await makeInstance(app, 'inst_res_a', 'Res Alpha');
    const beta = await makeInstance(app, 'inst_res_b', 'Res Beta');
    fs.writeFileSync(path.join(alpha, 'resourcepacks', 'faithful.zip'), 'pack bytes');

    await app.exposed.craftdockInstance.update({ id: 'inst_res_a', name: 'Res Alpha', resourceTag: 'Our Pack!' });
    await app.exposed.craftdockInstance.update({ id: 'inst_res_b', name: 'Res Beta', resourceTag: 'Our Pack!' });

    const sharedDir = path.join(app.sharedResourcesDir, 'Our-Pack-');
    assert.equal(fs.readFileSync(path.join(sharedDir, 'faithful.zip'), 'utf8'), 'pack bytes');
    assert.deepEqual(linkCommands(app), [
      `mklink /D "${path.join(alpha, 'resourcepacks')}" "${sharedDir}"`,
      `mklink /D "${path.join(beta, 'resourcepacks')}" "${sharedDir}"`,
    ]);
  });
});

test('the shader tag shares shaderpacks between instances', async () => {
  await withTempRoot(async root => {
    const junctions = junctionMock();
    const app = loadApp(root, { execSync: junctions.run, platform: 'win32' });
    const alpha = await makeInstance(app, 'inst_shd_a', 'Shader Alpha');
    const beta = await makeInstance(app, 'inst_shd_b', 'Shader Beta');
    fs.mkdirSync(path.join(alpha, 'shaderpacks'), { recursive: true });
    fs.writeFileSync(path.join(alpha, 'shaderpacks', 'Complementary.zip'), 'shader bytes');

    await app.exposed.craftdockInstance.update({ id: 'inst_shd_a', name: 'Shader Alpha', shaderTag: 'Our Shaders' });
    await app.exposed.craftdockInstance.update({ id: 'inst_shd_b', name: 'Shader Beta', shaderTag: 'Our Shaders' });

    const sharedDir = path.join(app.sharedShadersDir, 'Our-Shaders');
    assert.equal(fs.readFileSync(path.join(sharedDir, 'Complementary.zip'), 'utf8'), 'shader bytes');
    assert.deepEqual(linkCommands(app), [
      `mklink /D "${path.join(alpha, 'shaderpacks')}" "${sharedDir}"`,
      `mklink /D "${path.join(beta, 'shaderpacks')}" "${sharedDir}"`,
    ]);
  });
});

test('changing the shader tag relinks shaderpacks and clearing it restores a real folder', async () => {
  await withTempRoot(async root => {
    const junctions = junctionMock();
    const app = loadApp(root, { execSync: junctions.run, platform: 'win32' });
    const instanceDir = await makeInstance(app, 'inst_shd_switch', 'Shader Switch');
    const shaders = path.join(instanceDir, 'shaderpacks');

    await app.exposed.craftdockInstance.update({ id: 'inst_shd_switch', name: 'Switch', shaderTag: 'first' });
    await app.exposed.craftdockInstance.update({ id: 'inst_shd_switch', name: 'Switch', shaderTag: 'second' });

    assert.deepEqual(linkCommands(app), [
      `mklink /D "${shaders}" "${path.join(app.sharedShadersDir, 'first')}"`,
      `mklink /D "${shaders}" "${path.join(app.sharedShadersDir, 'second')}"`,
    ]);
    assert.ok(junctions.linked.has(shaders));

    await app.exposed.craftdockInstance.update({ id: 'inst_shd_switch', name: 'Switch', shaderTag: null });

    assert.equal(fs.lstatSync(shaders).isSymbolicLink(), false, 'the link is removed');
    assert.equal(fs.statSync(shaders).isDirectory(), true, 'shaderpacks is a real folder again');
    assert.deepEqual(fs.readdirSync(shaders), []);
  });
});

test('the apply-shader-tag handler links and unlinks shaderpacks directly', async () => {
  await withTempRoot(async root => {
    const junctions = junctionMock();
    const app = loadApp(root, { execSync: junctions.run, platform: 'win32' });
    const instanceDir = await makeInstance(app, 'inst_shd_ipc', 'Shader IPC');
    const shaders = path.join(instanceDir, 'shaderpacks');

    assert.deepEqual(plain(await app.exposed.craftdockInstance.applyShaderTag('inst_shd_ipc', 'solo')), { success: true });
    assert.deepEqual(linkCommands(app), [`mklink /D "${shaders}" "${path.join(app.sharedShadersDir, 'solo')}"`]);

    assert.deepEqual(plain(await app.exposed.craftdockInstance.applyShaderTag('inst_shd_ipc', null)), { success: true });
    assert.equal(fs.lstatSync(shaders).isSymbolicLink(), false);
    assert.equal(fs.statSync(shaders).isDirectory(), true);
  });
});

test('all four tags can be set on one instance at once', async () => {
  await withTempRoot(async root => {
    const junctions = junctionMock();
    const app = loadApp(root, { execSync: junctions.run, platform: 'win32' });
    const instanceDir = await makeInstance(app, 'inst_all', 'All Tags');
    fs.writeFileSync(path.join(instanceDir, 'servers.dat'), 'servers');
    fs.writeFileSync(path.join(instanceDir, 'resourcepacks', 'p.zip'), 'pack');
    fs.writeFileSync(path.join(instanceDir, 'shaderpacks', 's.zip'), 'shader');

    await app.exposed.craftdockInstance.update({
      id: 'inst_all', name: 'All Tags', worldTag: 'w', serverTag: 's', resourceTag: 'r', shaderTag: 'sh',
    });

    assert.deepEqual(linkCommands(app).sort(), [
      `mklink /D "${path.join(instanceDir, 'resourcepacks')}" "${path.join(app.sharedResourcesDir, 'r')}"`,
      `mklink /D "${path.join(instanceDir, 'shaderpacks')}" "${path.join(app.sharedShadersDir, 'sh')}"`,
      `mklink "${path.join(instanceDir, 'servers.dat')}" "${path.join(app.sharedServersDir, 's', 'servers.dat')}"`,
      `mklink /J "${path.join(instanceDir, 'saves')}" "${path.join(app.sharedWorldsDir, 'w')}"`,
    ].sort());
    assert.ok(fs.existsSync(path.join(app.sharedWorldsDir, 'w')));
    assert.ok(fs.existsSync(path.join(app.sharedServersDir, 's', 'servers.dat')));
    assert.ok(fs.existsSync(path.join(app.sharedResourcesDir, 'r')));
    assert.ok(fs.existsSync(path.join(app.sharedShadersDir, 'sh')));
  });
});
