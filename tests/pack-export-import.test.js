// Pack export and import: CurseForge manifest zips, Modrinth .mrpack files,
// share codes/links, and importing a pack file into a new instance.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadApp, makeZip, plain, readZip, withTempRoot,
} = require('./helpers/electron-app');

const instanceMeta = {
  id: 'inst_export',
  name: 'Export Pack',
  mcVersion: '1.21.4',
  loader: 'fabric',
  loaderVersion: '0.15.11',
  sourceId: 'aether',
};

async function createExportInstance(app, root) {
  const instanceDir = path.join(app.instancesDir, 'inst_export');
  fs.mkdirSync(path.join(instanceDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(instanceDir, 'instance.json'), JSON.stringify(instanceMeta));
  fs.writeFileSync(path.join(instanceDir, 'mods', 'sodium.jar'), 'sodium bytes');
  fs.writeFileSync(path.join(instanceDir, 'mods', 'iris.jar'), 'iris bytes');
  fs.writeFileSync(path.join(instanceDir, 'mods', 'disabled.jar.disabled'), 'disabled bytes');
  fs.writeFileSync(path.join(instanceDir, 'mods', 'notes.txt'), 'not a jar');
  return { instanceDir, root };
}

test('exporting a CurseForge zip writes a manifest plus mod overrides', async () => {
  await withTempRoot(async root => {
    const outPath = path.join(root, 'export-cf.zip');
    const app = loadApp(root, { savePath: outPath });
    await createExportInstance(app, root);

    const result = await app.exposed.craftdockInstance.exportPack('inst_export', 'cf-zip');

    assert.deepEqual(plain(result), { success: true, path: outPath });
    const entries = readZip(fs.readFileSync(outPath));
    const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
    assert.equal(manifest.name, 'Export Pack');
    assert.equal(manifest.version, '1.0.0');
    assert.equal(manifest.author, 'CraftDock');
    assert.equal(manifest.manifestType, 'minecraftModpack');
    assert.equal(manifest.manifestVersion, 1);
    assert.deepEqual(manifest.minecraft, {
      version: '1.21.4',
      modLoaders: [{ id: 'fabric-latest', primary: true }],
    });
    assert.equal(entries.get('overrides/mods/sodium.jar').toString('utf8'), 'sodium bytes');
    assert.equal(entries.get('overrides/mods/iris.jar').toString('utf8'), 'iris bytes');
    assert.equal(entries.has('overrides/mods/disabled.jar.disabled'), false);
    assert.equal(entries.has('overrides/mods/notes.txt'), false);
    assert.deepEqual([...entries.keys()].sort(), [
      'manifest.json', 'overrides/mods/iris.jar', 'overrides/mods/sodium.jar',
    ]);
  });
});

test('exporting a .mrpack writes a Modrinth index plus mod overrides', async () => {
  await withTempRoot(async root => {
    const outPath = path.join(root, 'export.mrpack');
    const app = loadApp(root, { savePath: outPath });
    await createExportInstance(app, root);

    const result = await app.exposed.craftdockInstance.exportPack('inst_export', 'mrpack');

    assert.deepEqual(plain(result), { success: true, path: outPath });
    const entries = readZip(fs.readFileSync(outPath));
    const index = JSON.parse(entries.get('modrinth.index.json').toString('utf8'));
    assert.equal(index.formatVersion, 1);
    assert.equal(index.game, 'minecraft');
    assert.equal(index.name, 'Export Pack');
    assert.equal(index.versionId, '1.0.0');
    assert.deepEqual(index.dependencies, { minecraft: '1.21.4', 'fabric-loader': '*' });
    assert.deepEqual(index.files, []);
    assert.equal(entries.get('overrides/mods/sodium.jar').toString('utf8'), 'sodium bytes');
    assert.equal(entries.has('overrides/mods/disabled.jar.disabled'), false);
  });
});

test('the CurseForge share code and Modrinth link are generated without a file dialog', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    await createExportInstance(app, root);

    const coded = await app.exposed.craftdockInstance.exportPack('inst_export', 'cf-code');
    assert.equal(coded.success, true);
    const manifest = JSON.parse(Buffer.from(coded.code, 'base64').toString('utf8'));
    assert.equal(manifest.name, 'Export Pack');
    assert.equal(manifest.minecraft.version, '1.21.4');
    assert.equal(manifest.override, undefined);
    assert.equal(manifest.overrides, 'overrides');
    assert.equal(app.dialogs.length, 0, 'share codes do not prompt for a path');

    const linked = await app.exposed.craftdockInstance.exportPack('inst_export', 'mr-link');
    assert.deepEqual(plain(linked), { success: true, url: 'https://modrinth.com/modpack/aether' });

    const unknown = await app.exposed.craftdockInstance.exportPack('inst_export', 'zip');
    assert.deepEqual(plain(unknown), { success: false, error: 'Unknown format' });

    const missing = await app.exposed.craftdockInstance.exportPack('inst_missing', 'cf-zip');
    assert.deepEqual(plain(missing), { success: false, error: 'Instance not found' });
  });
});

test('cancelling the save dialog reports cancellation and writes nothing', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    await createExportInstance(app, root);

    const result = await app.exposed.craftdockInstance.exportPack('inst_export', 'cf-zip');

    assert.deepEqual(plain(result), { success: false, cancelled: true });
    assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.zip')), []);
  });
});

function curseForgePack(overrides = []) {
  return makeZip([
    ['manifest.json', JSON.stringify({
      minecraft: {
        version: '1.20.1',
        modLoaders: [{ id: 'fabric-0.15.0', primary: true }],
      },
      manifestType: 'minecraftModpack',
      manifestVersion: 1,
      name: 'CurseForge Import',
      version: '1.2.0',
      author: 'Someone',
      files: [
        { projectID: 238222, fileID: 4567, required: true },
        { projectID: 306612, fileID: 8910, required: false },
      ],
      overrides: 'overrides',
    })],
    ...overrides,
  ]);
}

test('importing a CurseForge pack creates an instance with its metadata and pending mods', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const packPath = path.join(root, 'curseforge-pack.zip');
    fs.writeFileSync(packPath, curseForgePack());

    const result = await app.exposed.craftdockInstance.importPack(packPath, 'cf');

    assert.equal(result.success, true);
    assert.equal(result.name, 'CurseForge Import');
    assert.equal(result.mcVersion, '1.20.1');
    assert.equal(result.loader, 'fabric');
    assert.equal(result.modCount, 2);

    const instanceDir = path.join(app.instancesDir, result.id);
    const meta = JSON.parse(fs.readFileSync(path.join(instanceDir, 'instance.json'), 'utf8'));
    assert.equal(meta.source, 'curseforge');
    assert.equal(meta.downloadStatus, 'imported');
    assert.equal(meta.mcVersion, '1.20.1');
    assert.equal(meta.loader, 'fabric');
    assert.equal(meta.loaderVersion, '0.15.0');
    assert.deepEqual(plain(meta.mods), []);
    assert.deepEqual(plain(meta._pendingMods), [
      { projectId: 238222, fileId: 4567, required: true },
      { projectId: 306612, fileId: 8910, required: false },
    ]);
    assert.ok(fs.existsSync(path.join(instanceDir, 'mods')), 'the mods folder is ready for the pending files');
  });
});

test('importing a Modrinth pack records the loader and creates an empty mods folder', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const packPath = path.join(root, 'modrinth-pack.mrpack');
    fs.writeFileSync(packPath, makeZip([
      ['modrinth.index.json', JSON.stringify({
        formatVersion: 1,
        game: 'minecraft',
        name: 'Modrinth Import',
        dependencies: { minecraft: '1.21.1', 'neoforge': '21.1.9' },
        files: [{ path: 'mods/example.jar', downloads: ['https://cdn.example/example.jar'] }],
      })],
    ]));

    const result = await app.exposed.craftdockInstance.importPack(packPath, 'mr');

    assert.equal(result.success, true);
    assert.equal(result.name, 'Modrinth Import');
    assert.equal(result.mcVersion, '1.21.1');
    assert.equal(result.loader, 'neoforge');
    const meta = JSON.parse(fs.readFileSync(path.join(app.instancesDir, result.id, 'instance.json'), 'utf8'));
    assert.equal(meta.source, 'modrinth');
    assert.deepEqual(plain(meta._pendingMods), []);
    assert.ok(fs.existsSync(path.join(app.instancesDir, result.id, 'mods')));
  });
});

test('a pack with override files is refused and leaves no partial instance', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root);
    const packPath = path.join(root, 'with-overrides.zip');
    fs.writeFileSync(packPath, curseForgePack([
      ['overrides/config/mod.toml', 'a = 1'],
      ['overrides/mods/embedded.jar', 'jar bytes'],
    ]));

    const result = await app.exposed.craftdockInstance.importPack(packPath, 'cf');

    assert.equal(result.success, false);
    assert.match(result.error, /2 override file\(s\)/);
    const remaining = fs.existsSync(app.instancesDir) ? fs.readdirSync(app.instancesDir) : [];
    assert.deepEqual(remaining, [], 'the created instance folder is cleaned up');
  });
});
