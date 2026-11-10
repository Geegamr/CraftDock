const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  convertInstanceToServer,
  detectClientOnlyJar,
} = require('../instance-server-conversion');

async function makeTemp() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'craftdock-convert-'));
}

async function write(file, contents) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, contents);
}

test('conversion copies only server-compatible mods and server config folders', async () => {
  const root = await makeTemp();
  const instanceDir = path.join(root, 'instance');
  const serverDir = path.join(root, 'server');
  await write(path.join(instanceDir, 'mods', 'keep.jar'), 'server mod');
  await write(path.join(instanceDir, 'mods', 'client.jar'), 'client mod');
  await write(path.join(instanceDir, 'mods', 'fabric-client.jar'), 'fabric client');
  await write(path.join(instanceDir, 'mods', 'disabled.jar.disabled'), 'disabled');
  await write(path.join(instanceDir, 'config', 'server.toml'), 'enabled=true');
  await write(path.join(instanceDir, 'config', 'client.toml'), 'client=true');
  await write(path.join(instanceDir, 'kubejs', 'server_scripts', 'boot.js'), 'console.info(1)');
  await write(path.join(instanceDir, 'resourcepacks', 'pack.zip'), 'not a server file');
  await write(path.join(instanceDir, 'saves', 'world', 'level.dat'), 'not copied');
  await write(path.join(instanceDir, 'options.txt'), 'not copied');

  const result = await convertInstanceToServer({
    instanceDir,
    serverDir,
    clientOnlyFiles: ['client.jar'],
    inspectJar: async file => path.basename(file) === 'fabric-client.jar',
  });

  assert.deepEqual(result.copiedMods, ['keep.jar']);
  assert.deepEqual(result.skippedClientMods.sort(), ['client.jar', 'fabric-client.jar']);
  assert.deepEqual(result.skippedDisabledMods, ['disabled.jar.disabled']);
  assert.deepEqual(result.copiedConfigDirs.sort(), ['config', 'kubejs']);
  assert.equal(await fsp.readFile(path.join(serverDir, 'mods', 'keep.jar'), 'utf8'), 'server mod');
  assert.equal(await fsp.readFile(path.join(serverDir, 'config', 'server.toml'), 'utf8'), 'enabled=true');
  assert.equal(await fsp.readFile(path.join(serverDir, 'config', 'client.toml'), 'utf8'), 'client=true');
  assert.equal(await fsp.readFile(path.join(serverDir, 'kubejs', 'server_scripts', 'boot.js'), 'utf8'), 'console.info(1)');
  assert.equal(fs.existsSync(path.join(serverDir, 'mods', 'client.jar')), false);
  assert.equal(fs.existsSync(path.join(serverDir, 'mods', 'fabric-client.jar')), false);
  assert.equal(fs.existsSync(path.join(serverDir, 'mods', 'disabled.jar')), false);
  assert.equal(fs.existsSync(path.join(serverDir, 'resourcepacks')), false);
  assert.equal(fs.existsSync(path.join(serverDir, 'saves')), false);
  assert.equal(fs.existsSync(path.join(serverDir, 'options.txt')), false);

  await fsp.rm(root, { recursive: true, force: true });
});

test('conversion refuses an existing server folder and cleans up on failure', async () => {
  const root = await makeTemp();
  const instanceDir = path.join(root, 'instance');
  const serverDir = path.join(root, 'server');
  await write(path.join(instanceDir, 'mods', 'keep.jar'), 'server mod');
  await fsp.mkdir(serverDir);

  await assert.rejects(
    convertInstanceToServer({ instanceDir, serverDir }),
    /EEXIST|already exists/i,
  );
  assert.equal(fs.existsSync(serverDir), true);

  await fsp.rm(serverDir, { recursive: true, force: true });
  await fsp.rm(instanceDir, { recursive: true, force: true });
  await fsp.rm(root, { recursive: true, force: true });
});

test('a jar with an unrecognized layout is treated as server-compatible', () => {
  const fakeZip = () => new Map();
  assert.equal(detectClientOnlyJar('unknown.jar', fakeZip), false);
});

test('Fabric, Quilt and Forge client-only jars are detected from their metadata', () => {
  const rail = entries => () => new Map(Object.entries(entries).map(([name, text]) => [name, Buffer.from(text)]));

  assert.equal(detectClientOnlyJar('fabric.jar', rail({
    'fabric.mod.json': JSON.stringify({ environment: 'client' }),
  })), true);
  assert.equal(detectClientOnlyJar('fabric-server.jar', rail({
    'fabric.mod.json': JSON.stringify({ environment: '*' }),
  })), false);
  assert.equal(detectClientOnlyJar('quilt.jar', rail({
    'quilt.mod.json': JSON.stringify({ quilt_loader: { metadata: { environment: 'client' } } }),
  })), true);
  assert.equal(detectClientOnlyJar('forge.jar', rail({
    'META-INF/mods.toml': 'modLoader="javafml"\nclientSideOnly=true\n',
  })), true);
  assert.equal(detectClientOnlyJar('broken.jar', () => { throw new Error('bad zip'); }), false);
});
