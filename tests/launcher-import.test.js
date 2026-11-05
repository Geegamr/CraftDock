// Importing instances from other launchers: detection of each on-disk format,
// and the copy + metadata translation that keeps pack and mod updates working.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLauncherImporter } = require('../launcher-import');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-launcher-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function sha1(contents) {
  return crypto.createHash('sha1').update(contents).digest('hex');
}

function makeImporter(root, options = {}) {
  const instancesBase = path.join(root, 'craftdock', 'instances');
  fs.mkdirSync(instancesBase, { recursive: true });
  const metaById = new Map();
  const importer = createLauncherImporter({
    instancesBase,
    registerSlug: () => {},
    ensureInstance: () => {},
    instDir: id => path.join(instancesBase, id),
    writeInstMeta: (id, meta) => {
      metaById.set(id, meta);
      write(path.join(instancesBase, id, 'instance.json'), JSON.stringify(meta, null, 2));
    },
    home: path.join(root, 'home'),
    env: {},
    platform: 'win32',
    log: { warn: () => {} },
    ...options,
  });
  return { importer, instancesBase, metaById };
}

// ── Prism / MultiMC ────────────────────────────────────────────────────────
function makePrismInstance(root, name) {
  const instanceDir = path.join(root, 'home', 'AppData', 'Roaming', 'PrismLauncher', 'instances', name);
  write(path.join(instanceDir, 'instance.cfg'), [
    'InstanceType=OneSix',
    `name=${name} Display`,
    'iconKey=cobblemon.png',
    'totalTimePlayed=5400',
    'ManagedPack=true',
    'ManagedPackType=modrinth',
    'ManagedPackID=5YJ7XmGZ',
    'ManagedPackVersionID=abc123',
    'ManagedPackVersionName=1.6.1',
    'ManagedPackName=Cobblemon',
    '',
  ].join('\n'));
  write(path.join(instanceDir, 'mmc-pack.json'), JSON.stringify({
    formatVersion: 1,
    components: [
      { uid: 'net.minecraft', version: '1.21.1', important: true },
      { uid: 'net.fabricmc.fabric-loader', version: '0.16.5' },
    ],
  }));
  write(path.join(instanceDir, '.minecraft', 'mods', 'cobblemon.jar'), 'cobblemon');
  write(path.join(instanceDir, '.minecraft', 'mods', 'jei.jar.disabled'), 'jei');
  write(path.join(instanceDir, '.minecraft', 'config', 'cobblemon.json'), '{"spawn":true}');
  write(path.join(instanceDir, '.minecraft', 'saves', 'Starter', 'level.dat'), 'world');
  write(path.join(instanceDir, '.minecraft', 'options.txt'), 'fov:0.5');
  // Heavy folders that must not be copied.
  write(path.join(instanceDir, '.minecraft', 'libraries', 'huge.jar'), 'x'.repeat(2048));
  write(path.join(instanceDir, '.minecraft', 'assets', 'indexes', '1.json'), '{}');
  write(path.join(instanceDir, 'icons', 'unused.txt'), '');
  write(path.join(root, 'home', 'AppData', 'Roaming', 'PrismLauncher', 'icons', 'cobblemon.png'), 'PNG');
  return instanceDir;
}

test('a Prism / MultiMC instance reports version, loader, pack and playtime', t => {
  const root = tempRoot(t);
  makePrismInstance(root, 'Cobblemon');
  const { importer } = makeImporter(root);

  const scan = importer.scan('prism');
  assert.equal(scan.instances.length, 1);
  const instance = scan.instances[0];
  assert.equal(instance.name, 'Cobblemon Display');
  assert.equal(instance.mcVersion, '1.21.1');
  assert.equal(instance.loader, 'fabric');
  assert.equal(instance.loaderVersion, '0.16.5');
  assert.equal(instance.modCount, 2);
  assert.equal(instance.worldCount, 1);
  assert.equal(instance.playMinutes, 90);
  assert.deepEqual(instance.pack, {
    type: 'modrinth',
    id: '5YJ7XmGZ',
    versionId: 'abc123',
    versionName: '1.6.1',
    name: 'Cobblemon',
  });
});

test('Prism Forge components lose the glued Minecraft version, and flame means CurseForge', t => {
  const root = tempRoot(t);
  const instanceDir = path.join(root, 'home', 'AppData', 'Roaming', 'PrismLauncher', 'instances', 'Forgey');
  write(path.join(instanceDir, 'instance.cfg'), [
    'name=Forgey',
    'ManagedPack=true',
    'ManagedPackType=flame',
    'ManagedPackID=123456',
    'ManagedPackVersionID=789',
    'ManagedPackVersionName=2.0.1',
    '',
  ].join('\n'));
  write(path.join(instanceDir, 'mmc-pack.json'), JSON.stringify({
    formatVersion: 1,
    components: [
      { uid: 'net.minecraft', version: '1.20.1' },
      { uid: 'net.minecraftforge', version: '1.20.1-47.2.0' },
    ],
  }));
  const { importer } = makeImporter(root);
  const instance = importer.scan('prism').instances[0];
  assert.equal(instance.loader, 'forge');
  assert.equal(instance.loaderVersion, '47.2.0');
  assert.equal(instance.pack.type, 'curseforge');
});

// ── CurseForge app ─────────────────────────────────────────────────────────
function makeCurseForgeInstance(root, name) {
  const instanceDir = path.join(root, 'home', 'curseforge', 'minecraft', 'Instances', name);
  write(path.join(instanceDir, 'minecraftinstance.json'), JSON.stringify({
    name,
    gameVersion: '1.21.1',
    baseModLoader: { name: 'neoforge-21.1.209', forgeVersion: '21.1.209', type: 6, minecraftVersion: '1.21.1' },
    manifest: { manifestType: 'minecraftModpack', name: 'All the Mods 10', version: '2.1.0' },
    installedMods: [
      { projectID: 238222, fileID: 5246076, fileNameOnDisk: 'jei-1.21.1.jar', name: 'Just Enough Items' },
      { projectID: 0, fileID: 0, fileNameOnDisk: 'custom-fix.jar', name: 'Custom Fix' },
    ],
  }));
  write(path.join(instanceDir, 'mods', 'jei-1.21.1.jar'), 'jei');
  write(path.join(instanceDir, 'mods', 'custom-fix.jar'), 'custom');
  return instanceDir;
}

test('a CurseForge instance keeps its pack name/version and each mod project id', t => {
  const root = tempRoot(t);
  makeCurseForgeInstance(root, 'All the Mods 10');
  const { importer } = makeImporter(root);

  const scan = importer.scan('curseforge');
  assert.equal(scan.instances.length, 1);
  const instance = scan.instances[0];
  assert.equal(instance.mcVersion, '1.21.1');
  assert.equal(instance.loader, 'neoforge');
  assert.equal(instance.loaderVersion, '21.1.209');
  assert.equal(instance.pack.name, 'All the Mods 10');
  assert.equal(instance.pack.versionName, '2.1.0');
  assert.equal(instance.mods.length, 2);
  assert.equal(instance.mods[0].projectId, '238222');
  assert.equal(instance.mods[0].fileId, '5246076');
});

// ── ATLauncher ─────────────────────────────────────────────────────────────
test('an ATLauncher instance reads its loader, pack ids and mod list', t => {
  const root = tempRoot(t);
  const instanceDir = path.join(root, 'home', 'AppData', 'Roaming', '.atlauncher', 'instances', 'VaultHunters');
  write(path.join(instanceDir, 'instance.json'), JSON.stringify({
    id: '1.18.2',
    launcher: {
      name: 'Vault Hunters',
      pack: 'Vault Hunters 3',
      version: '3.12.0',
      loaderVersion: { version: '40.2.1', type: 'Forge' },
      curseForgeProject: { id: 1000 },
      curseForgeFile: { id: 2000, displayName: '3.12.0' },
      mods: [
        { name: 'AppleSkin', file: 'appleskin.jar', type: 'mods', curseForgeProjectId: 248787, curseForgeFileId: 4000 },
        { name: 'Off', file: 'off.jar', type: 'mods', disabled: true },
      ],
    },
  }));
  write(path.join(instanceDir, 'mods', 'appleskin.jar'), 'apple');
  const { importer } = makeImporter(root);

  const instance = importer.scan('atlauncher').instances[0];
  assert.equal(instance.mcVersion, '1.18.2');
  assert.equal(instance.loader, 'forge');
  assert.equal(instance.loaderVersion, '40.2.1');
  assert.equal(instance.pack.id, '1000');
  assert.equal(instance.pack.versionName, '3.12.0');
  assert.equal(instance.mods[0].projectId, '248787');
  assert.equal(instance.mods[1].fileName, 'off.jar.disabled');
});

// ── Modrinth App (filesystem fallback) ─────────────────────────────────────
test('a Modrinth App profile is found without its database', t => {
  const root = tempRoot(t);
  const profileDir = path.join(root, 'home', 'AppData', 'Roaming', 'ModrinthApp', 'profiles', 'Adventure');
  write(path.join(profileDir, 'mods', 'sodium.jar'), 'sodium');
  write(path.join(profileDir, 'logs', 'latest.log'),
    '[12:00:00] [Render thread/INFO]: Loading Minecraft 1.21.4 with Fabric Loader 0.16.9\n');
  const { importer } = makeImporter(root);

  const instance = importer.scan('modrinth').instances[0];
  assert.equal(instance.name, 'Adventure');
  assert.equal(instance.mcVersion, '1.21.4');
  assert.equal(instance.loader, 'fabric');
  assert.equal(instance.loaderVersion, '0.16.9');
  assert.equal(instance.modCount, 1);
});

// ── Import ─────────────────────────────────────────────────────────────────
test('import copies the game files, skips game assets, and records update sources', async t => {
  const root = tempRoot(t);
  const prismDir = makePrismInstance(root, 'Cobblemon');

  const cobblemon = fs.readFileSync(path.join(prismDir, '.minecraft', 'mods', 'cobblemon.jar'));
  const jei = fs.readFileSync(path.join(prismDir, '.minecraft', 'mods', 'jei.jar.disabled'));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('/version_files')) {
      const body = JSON.parse(init.body);
      const data = {};
      if (body.hashes.includes(sha1(cobblemon))) {
        data[sha1(cobblemon)] = {
          id: 'ver-cobblemon',
          project_id: 'proj-cobblemon',
          version_number: '1.6.1',
          game_versions: ['1.21.1'],
          loaders: ['fabric'],
          files: [{ primary: true, url: 'https://cdn.example/cobblemon.jar', filename: 'cobblemon-1.6.1.jar' }],
        };
      }
      if (body.hashes.includes(sha1(jei))) {
        data[sha1(jei)] = {
          id: 'ver-jei',
          project_id: 'proj-jei',
          version_number: '19.0.0',
          game_versions: ['1.21.1'],
          loaders: ['fabric'],
          files: [{ primary: true, url: 'https://cdn.example/jei.jar', filename: 'jei-19.jar' }],
        };
      }
      return { ok: true, json: async () => data };
    }
    if (String(url).includes('/projects?')) {
      return {
        ok: true,
        json: async () => ([
          { id: 'proj-cobblemon', title: 'Cobblemon', slug: 'cobblemon', icon_url: 'https://cdn.example/cobblemon.png' },
          { id: 'proj-jei', title: 'Just Enough Items', slug: 'jei', icon_url: 'https://cdn.example/jei.png' },
        ]),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const { importer, metaById, instancesBase } = makeImporter(root, { fetchImpl });
  const progress = [];
  const result = await importer.importInstance(
    { launcherId: 'prism', externalId: 'Cobblemon' },
    payload => progress.push(payload),
  );

  assert.equal(result.success, true);
  assert.equal(result.mcVersion, '1.21.1');
  assert.equal(result.loader, 'fabric');
  assert.equal(result.importedFromPackName, undefined);
  assert.equal(result.pack.tracked, true);
  assert.equal(result.mods.mapped, 2);
  assert.equal(result.mods.local, 0);

  const instanceDir = path.join(instancesBase, result.id);
  assert.equal(fs.readFileSync(path.join(instanceDir, 'mods', 'cobblemon.jar'), 'utf8'), 'cobblemon');
  assert.equal(fs.existsSync(path.join(instanceDir, 'mods', 'jei.jar.disabled')), true, 'a disabled mod stays disabled');
  assert.equal(fs.readFileSync(path.join(instanceDir, 'config', 'cobblemon.json'), 'utf8'), '{"spawn":true}');
  assert.equal(fs.readFileSync(path.join(instanceDir, 'saves', 'Starter', 'level.dat'), 'utf8'), 'world');
  assert.equal(fs.readFileSync(path.join(instanceDir, 'options.txt'), 'utf8'), 'fov:0.5');
  assert.equal(fs.existsSync(path.join(instanceDir, 'libraries')), false, 'game libraries are not copied');
  assert.equal(fs.existsSync(path.join(instanceDir, 'assets')), false, 'game assets are not copied');

  const meta = metaById.get(result.id);
  assert.equal(meta.source, 'modrinth');
  assert.equal(meta.sourceId, '5YJ7XmGZ', 'the pack project id is what update checks read');
  assert.equal(meta.sourceVersionId, 'abc123');
  assert.equal(meta.sourceVersionName, '1.6.1');
  assert.equal(meta.importedFrom.launcher, 'prism');
  assert.equal(meta.totalPlayMinutes, 90);
  assert.equal(meta.mods.length, 2);
  assert.deepEqual(meta.mods.map(mod => mod.source), ['modrinth', 'modrinth']);
  assert.equal(meta.mods[0].name, 'Cobblemon');
  assert.equal(meta.mods[0].versionName, '1.6.1');
  assert.equal(meta.mods[0].iconUrl, 'https://cdn.example/cobblemon.png');
  assert.equal(meta.mods[1].fileName, 'jei.jar.disabled');

  assert.ok(progress.length > 2, 'progress is reported while copying');
  assert.equal(progress.at(-1).pct, 100);
});

test('a jar the old launcher never tracked falls back to its hash, then to local', async t => {
  const root = tempRoot(t);
  const instanceDir = makeCurseForgeInstance(root, 'Packed');
  write(path.join(instanceDir, 'mods', 'mystery.jar'), 'mystery');
  const mystery = fs.readFileSync(path.join(instanceDir, 'mods', 'mystery.jar'));

  const fetchImpl = async (url, init) => {
    if (String(url).includes('/version_files')) {
      const body = JSON.parse(init.body);
      const data = {};
      if (body.hashes.includes(sha1(mystery))) {
        data[sha1(mystery)] = {
          id: 'ver-mystery',
          project_id: 'proj-mystery',
          version_number: '3.0.0',
          game_versions: ['1.21.1'],
          loaders: ['neoforge'],
          files: [{ primary: true, url: 'https://cdn.example/mystery.jar', filename: 'mystery-3.jar' }],
        };
      }
      return { ok: true, json: async () => data };
    }
    if (String(url).includes('/projects?')) {
      return { ok: true, json: async () => ([{ id: 'proj-mystery', title: 'Mystery Mod', slug: 'mystery' }]) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const { importer, metaById } = makeImporter(root, { fetchImpl });
  const result = await importer.importInstance({ launcherId: 'curseforge', externalId: 'Packed' }, () => {});
  const meta = metaById.get(result.id);

  // JEI and the custom fix come from the CurseForge metadata, mystery from its hash.
  const byFile = Object.fromEntries(meta.mods.map(mod => [mod.fileName, mod]));
  assert.equal(byFile['jei-1.21.1.jar'].source, 'curseforge');
  assert.equal(byFile['jei-1.21.1.jar'].id, '238222');
  assert.equal(byFile['mystery.jar'].source, 'modrinth');
  assert.equal(byFile['mystery.jar'].versionName, '3.0.0');
  // A CurseForge pack without its own project id cannot be checked for pack updates.
  assert.equal(meta.packName, 'All the Mods 10');
  assert.equal(meta.sourceId, undefined);
  assert.equal(meta.source, 'imported');
});

test('CurseForge mods get their logo from the injected lookup', async t => {
  const root = tempRoot(t);
  makeCurseForgeInstance(root, 'Packed');
  // No Modrinth hashes resolve here, so every tracked mod keeps its CurseForge
  // hint — the case that used to leave the mods page with blank tiles.
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const asked = [];
  const curseForgeIcons = async ids => {
    asked.push(ids);
    return new Map([['238222', 'https://media.example/jei-logo.png']]);
  };

  const { importer, metaById } = makeImporter(root, { fetchImpl, curseForgeIcons });
  const result = await importer.importInstance({ launcherId: 'curseforge', externalId: 'Packed' }, () => {});
  const meta = metaById.get(result.id);
  const jei = meta.mods.find(mod => mod.id === '238222');

  assert.equal(jei.source, 'curseforge');
  assert.equal(jei.iconUrl, 'https://media.example/jei-logo.png');
  assert.deepEqual(asked, [['238222']], 'only projects still missing a logo are asked for');
  // A mod with no project id is local, so nothing is asked about it.
  assert.equal(meta.mods.find(mod => mod.source === 'local').iconUrl, null);
});

test('a failing logo lookup leaves the import intact', async t => {
  const root = tempRoot(t);
  makeCurseForgeInstance(root, 'Packed');
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const curseForgeIcons = async () => { throw new Error('no key configured'); };

  const { importer, metaById } = makeImporter(root, { fetchImpl, curseForgeIcons });
  const result = await importer.importInstance({ launcherId: 'curseforge', externalId: 'Packed' }, () => {});

  assert.equal(result.success, true);
  assert.equal(metaById.get(result.id).mods.find(mod => mod.id === '238222').iconUrl, null);
});

test('importing an instance that was removed meanwhile creates nothing', async t => {
  const root = tempRoot(t);
  const instanceDir = makePrismInstance(root, 'Gone');
  const { importer, instancesBase } = makeImporter(root);

  // The other launcher deleted the instance between the scan and the click.
  fs.rmSync(instanceDir, { recursive: true, force: true });

  await assert.rejects(
    () => importer.importInstance({ launcherId: 'prism', externalId: 'Gone' }, () => {}),
    /no longer in the other launcher/,
  );
  assert.deepEqual(fs.readdirSync(instancesBase), []);
});

test('the importer module ships inside the packaged app', () => {
  // The main process requires ./launcher-import at startup, so leaving it out
  // of the electron-builder file list ships an exe that cannot launch.
  const packageConfig = require('../package.json');
  assert.ok(packageConfig.build.files.includes('launcher-import.js'));
});

// Pasted worlds are only trusted when the copy reproduces the digest of the file
// it came from. Size alone proves nothing: a half-written region file or a stale
// level.dat can match the original byte for byte in length and still be corrupt.
test('a copy is trusted only when it reproduces the original digest', t => {
  const root = tempRoot(t);
  const original  = path.join(root, 'level.dat');
  const identical = path.join(root, 'level-copy.dat');
  const rewritten = path.join(root, 'level-rewritten.dat');

  write(original, 'world header v1');
  write(identical, 'world header v1');
  write(rewritten, 'world header v2'); // same length, different bytes

  const { sameBytes, hashFileSync } = require('../launcher-import');

  assert.equal(fs.statSync(original).size, fs.statSync(rewritten).size,
    'the case that matters is a same-size file with different contents');
  assert.equal(sameBytes(original, identical), true, 'an identical copy passes');
  assert.equal(sameBytes(original, rewritten), false, 'equal size alone is not proof');
  assert.equal(hashFileSync(original), hashFileSync(identical), 'the digest comes from the files');
  assert.notEqual(hashFileSync(original), hashFileSync(rewritten));
  assert.equal(sameBytes(original, path.join(root, 'missing.dat')), false,
    'a copy that is not there never passes');
});

// The original is hashed again after the copy: a file that changed while it was
// being read produced a torn copy, and that must not be accepted as an import.
test('a file that changes while it is copied is not accepted', t => {
  const root = tempRoot(t);
  const original = path.join(root, 'region.mca');
  const copy = path.join(root, 'region-copy.mca');
  write(original, 'unchanged chunks');

  const { sameBytes, hashFileSync } = require('../launcher-import');

  // A digest taken before a later write cannot match the file as it stands now.
  const before = hashFileSync(original);
  write(copy, 'unchanged chunks');
  assert.equal(hashFileSync(copy) === hashFileSync(original), true);

  fs.appendFileSync(original, 'more chunks');
  assert.equal(sameBytes(original, copy, before), false,
    'a digest that no longer describes the original is rejected');
  assert.notEqual(hashFileSync(copy), hashFileSync(original));
});
