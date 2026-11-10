// End-to-end check for the Library's right-click "Convert to server" action:
// the real IPC handler creates a server folder and copies only server jars and
// server config folders.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadApp, makeZip, plain, withTempRoot, writeInstance,
} = require('./helpers/electron-app');

test('Convert to server copies server-compatible mods through the preload IPC bridge', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const instanceDir = writeInstance(app, 'inst_convert', {
      name: 'Convert Me',
      loader: 'fabric',
      mcVersion: '1.21.1',
    });
    const modsDir = path.join(instanceDir, 'mods');
    fs.writeFileSync(path.join(modsDir, 'server.jar'), makeZip([
      ['fabric.mod.json', JSON.stringify({ environment: '*' })],
    ]));
    fs.writeFileSync(path.join(modsDir, 'client.jar'), makeZip([
      ['fabric.mod.json', JSON.stringify({ environment: 'client' })],
    ]));
    fs.mkdirSync(path.join(instanceDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(instanceDir, 'config', 'server.toml'), 'enabled=true');
    fs.mkdirSync(path.join(instanceDir, 'resourcepacks'), { recursive: true });
    fs.writeFileSync(path.join(instanceDir, 'resourcepacks', 'pack.zip'), 'not a server file');

    const result = plain(await app.exposed.craftdockInstance.convertToServer(
      'inst_convert', 'srv_convert', 'Converted Server',
    ));

    assert.equal(result.success, true);
    assert.deepEqual(result.copiedMods, ['server.jar']);
    assert.deepEqual(result.skippedClientMods, ['client.jar']);
    assert.deepEqual(result.copiedConfigDirs, ['config']);

    const serverFolder = fs.readdirSync(app.serversDir, { withFileTypes: true })
      .find(entry => entry.isDirectory()).name;
    const serverDir = path.join(app.serversDir, serverFolder);
    assert.equal(fs.readFileSync(path.join(serverDir, 'mods', 'server.jar'), 'utf8').length > 0, true);
    assert.equal(fs.existsSync(path.join(serverDir, 'mods', 'client.jar')), false);
    assert.equal(fs.readFileSync(path.join(serverDir, 'config', 'server.toml'), 'utf8'), 'enabled=true');
    assert.equal(fs.existsSync(path.join(serverDir, 'resourcepacks')), false);
  });
});
