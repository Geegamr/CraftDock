const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const {
  createSkinLibraryAccess,
  getAllFallback,
  removeFallback,
  runRustBinary,
  saveFallback,
} = require('../skin-library');

const projectRoot = path.resolve(__dirname, '..');
const packageConfig = require('../package.json');
const fixtureRoot = path.join(__dirname, 'fixtures', 'skin-library');
const binaryName = process.platform === 'win32' ? 'craftdock-skin-library.exe' : 'craftdock-skin-library';
const binaryPath = path.join(projectRoot, 'rust', 'target', 'debug', binaryName);
const fixtureSkins = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'skins.json'), 'utf8'));
const useNativePath = root => path.join(root, 'rust', 'target', 'debug', binaryName);
function expectedFixtureSkins(directory) {
  return [
    { id: 'fixture-existing', name: 'Existing image', filePath: path.join(directory, 'fixture-image.png'), model: 'classic', dataUrl: 'data:image/png;base64,' + fs.readFileSync(path.join(fixtureRoot, 'fixture-image.png')).toString('base64') },
    { id: 'fixture-missing', name: 'Missing image', filePath: path.join(directory, 'missing-image.png'), model: 'slim' },
    { id: 'fixture-inline', name: 'Inline data', dataUrl: 'data:text/plain;base64,SGVsbG8=', model: 'classic' },
  ];
}

function normalizeSkinPaths(skins) {
  return skins.map(skin => ({
    ...skin,
    ...(skin.filePath && path.isAbsolute(skin.filePath) ? { filePath: path.basename(skin.filePath) } : {}),
  }));
}

async function withTempRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdock-skin-library-'));
  try { await callback(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function access(root, isPackaged = false, runNative) {
  return createSkinLibraryAccess({
    isPackaged,
    appDir: root,
    resourcesPath: path.join(root, 'resources'),
    platform: process.platform,
    runNative,
  });
}

function buildRustBinary() {
  const result = spawnSync('cargo', [
    'build', '--manifest-path', 'rust/Cargo.toml', '--locked', '--bin', 'craftdock-skin-library',
  ], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, `Rust skin library build failed:\n${result.stderr}`);
  assert.ok(fs.existsSync(binaryPath), `Rust executable not found: ${binaryPath}`);
}

function nativeAccess(root, isPackaged = false, runNative) {
  const localBinary = useNativePath(root);
  fs.mkdirSync(path.dirname(localBinary), { recursive: true });
  fs.copyFileSync(binaryPath, localBinary);
  return access(root, isPackaged, runNative);
}

function loadProductionIpc(tempRoot, handlers, skinModule = require('../skin-library')) {
  const exposed = {};
  const app = {
    isPackaged: false, setAppUserModelId() {}, setName() {}, on() {},
    whenReady: () => ({ then() {} }),
  };
  const electronMain = {
    app, BrowserWindow: class {},
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    dialog: {}, shell: {}, Tray: class {}, Menu: {}, nativeImage: {},
  };
  const mockMainRequire = name => {
    if (name === 'electron') return electronMain;
    if (name === './servers-dat') return require('../servers-dat');
    if (name === './server-jar-list') return require('../server-jar-list');
    if (name === './screenshot-list') return require('../screenshot-list');
    if (name === './config-file-list') return require('../config-file-list');
    if (name === './server-properties') return require('../server-properties');
    if (name === './skin-library') return skinModule;
    if (name === './modpack-metadata') return { createModpackMetadataReader: () => async () => ({}) };
    if (name === './browse-cache') return require('../browse-cache');
    if (name === './launcher-import') return require('../launcher-import');
    if (name === './package.json') return packageConfig;
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8'), {
    Buffer, __dirname: tempRoot, console: { log() {}, warn() {}, error() {} }, fetch,
    module: { exports: {} }, process: { ...process, resourcesPath: path.join(tempRoot, 'resources') },
    require: mockMainRequire, setInterval: () => 0, clearInterval() {},
  }, { filename: 'main.js' });

  const invocations = [];
  const electronPreload = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      invoke: (channel, ...args) => {
        invocations.push([channel, ...structuredClone(args)]);
        const handler = handlers.get(channel);
        assert.ok(handler, `No main handler registered for ${channel}`);
        return Promise.resolve(handler({ sender: 'preload-test' }, ...structuredClone(args)));
      },
      send() {}, on() {},
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf8'), {
    require: name => name === 'electron' ? electronPreload : require(name),
  }, { filename: 'preload.js' });
  return { exposed, invocations };
}

function writeFixture(directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(path.join(fixtureRoot, 'fixture-image.png'), path.join(directory, 'fixture-image.png'));
  const skins = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'skins.json'), 'utf8'));
  skins[0].filePath = path.join(directory, 'fixture-image.png');
  skins[1].filePath = path.join(directory, 'missing-image.png');
  fs.writeFileSync(path.join(directory, 'skins.json'), JSON.stringify(skins, null, 2));
}

test('shared fixture hydration and missing metadata match between Rust and fallback', async () => {
  buildRustBinary();
  await withTempRoot(async root => {
    const nativeDirectory = path.join(root, 'native');
    const fallbackDirectory = path.join(root, 'fallback');
    writeFixture(nativeDirectory);
    writeFixture(fallbackDirectory);
    fs.writeFileSync(path.join(nativeDirectory, 'skins.json'), JSON.stringify(fixtureSkins.map(skin => ({
      ...skin,
      ...(skin.filePath ? { filePath: path.join(nativeDirectory, skin.filePath) } : {}),
    })), null, 2));
    const fallbackSkins = fixtureSkins.map(skin => ({
      ...skin,
      ...(skin.filePath ? { filePath: path.join(fallbackDirectory, skin.filePath) } : {}),
    }));
    fs.writeFileSync(path.join(fallbackDirectory, 'skins.json'), JSON.stringify(fallbackSkins, null, 2));
    const native = await nativeAccess(nativeDirectory).getAll(nativeDirectory);
    const fallback = getAllFallback(fallbackDirectory);
    assert.deepEqual(native, expectedFixtureSkins(nativeDirectory));
    assert.deepEqual(fallback, expectedFixtureSkins(fallbackDirectory));

    assert.deepEqual(await nativeAccess(path.join(root, 'missing-native')).getAll(path.join(root, 'missing-native')), []);
    assert.deepEqual(getAllFallback(path.join(root, 'missing-fallback')), []);
  });
});

test('Rust and fallback save upsert data URLs and delete only the matching image and metadata', async () => {
  buildRustBinary();
  await withTempRoot(async root => {
    const nativeDirectory = path.join(root, 'native');
    const fallbackDirectory = path.join(root, 'fallback');
    for (const directory of [nativeDirectory, fallbackDirectory]) writeFixture(directory);
    const outfitCape = { id: 'cape-migrator', alias: 'Migrator', name: 'Migrator Cape', url: 'https://textures.minecraft.net/texture/example' };
    const firstSkin = { id: 'fixture-existing', name: 'Updated skin', model: 'slim', dataUrl: 'data:image/png;base64,AQIDBA==', addedAt: 7, cape: outfitCape };
    assert.deepEqual(await nativeAccess(nativeDirectory).save(nativeDirectory, structuredClone(firstSkin)), { success: true });
    assert.deepEqual(saveFallback(fallbackDirectory, structuredClone(firstSkin)), { success: true });
    for (const directory of [nativeDirectory, fallbackDirectory]) {
      assert.deepEqual(fs.readFileSync(path.join(directory, 'fixture-existing.png')), Buffer.from([1, 2, 3, 4]));
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'skins.json'), 'utf8'));
      assert.equal(metadata.length, fixtureSkins.length);
      assert.equal(metadata[0].name, 'Updated skin');
      assert.deepEqual(metadata[0].cape, outfitCape, 'the outfit cape is stored next to the skin');
      assert.equal(metadata[0].filePath, path.join(directory, 'fixture-existing.png'));
      assert.equal('dataUrl' in metadata[0], false);
    }
    assert.deepEqual(
      normalizeSkinPaths(await nativeAccess(nativeDirectory).getAll(nativeDirectory)),
      normalizeSkinPaths(getAllFallback(fallbackDirectory)),
    );

    assert.deepEqual(await nativeAccess(nativeDirectory).remove(nativeDirectory, 'fixture-existing'), { success: true });
    assert.deepEqual(removeFallback(fallbackDirectory, 'fixture-existing'), { success: true });
    for (const directory of [nativeDirectory, fallbackDirectory]) {
      assert.equal(fs.existsSync(path.join(directory, 'fixture-existing.png')), false);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'skins.json'), 'utf8')).map(skin => skin.id), ['fixture-missing', 'fixture-inline']);
      assert.equal(fs.existsSync(path.join(directory, 'fixture-image.png')), true);
    }

    const noMetadata = path.join(root, 'no-metadata');
    fs.mkdirSync(noMetadata);
    assert.equal(await nativeAccess(noMetadata).remove(noMetadata, 'absent'), undefined);
    assert.equal(removeFallback(noMetadata, 'absent'), undefined);
  });
});

test('legacy ID coercion stays in sync while path escapes are rejected by Rust and fallback', async () => {
  buildRustBinary();
  await withTempRoot(async root => {
    const ids = [undefined, null, 0, false, ["a", null, 2], { key: 'value' }];
    for (const id of ids) {
      const nativeDirectory = path.join(root, `native-${Math.random()}`);
      const fallbackDirectory = path.join(root, `fallback-${Math.random()}`);
      for (const directory of [nativeDirectory, fallbackDirectory]) fs.mkdirSync(directory, { recursive: true });
      const skin = { id, name: 'Coerced legacy ID', dataUrl: 'data:image/png;base64,AQ==' };
      assert.deepEqual(await nativeAccess(nativeDirectory).save(nativeDirectory, structuredClone(skin)), { success: true });
      assert.deepEqual(saveFallback(fallbackDirectory, structuredClone(skin)), { success: true });
      const filename = String(id);
      const expectedFile = path.join(nativeDirectory, `${filename}.png`);
      const fallbackFile = path.join(fallbackDirectory, `${filename}.png`);
      assert.deepEqual(fs.readFileSync(expectedFile), Buffer.from([1]));
      assert.deepEqual(fs.readFileSync(fallbackFile), Buffer.from([1]));
      const secondSkin = { id, name: 'Second save', dataUrl: 'data:image/png;base64,Ag==' };
      await nativeAccess(nativeDirectory).save(nativeDirectory, structuredClone(secondSkin));
      saveFallback(fallbackDirectory, structuredClone(secondSkin));
      const nativeMetadata = JSON.parse(fs.readFileSync(path.join(nativeDirectory, 'skins.json'), 'utf8'));
      const fallbackMetadata = JSON.parse(fs.readFileSync(path.join(fallbackDirectory, 'skins.json'), 'utf8'));
      const structuredId = Array.isArray(id) || (id !== null && typeof id === 'object');
      assert.equal(nativeMetadata.length, structuredId ? 2 : 1);
      assert.equal(fallbackMetadata.length, structuredId ? 2 : 1);
      assert.deepEqual(nativeMetadata.at(-1).id, id);
      assert.deepEqual(fallbackMetadata.at(-1).id, id);
      assert.deepEqual(await nativeAccess(nativeDirectory).remove(nativeDirectory, id), { success: true });
      assert.deepEqual(removeFallback(fallbackDirectory, id), { success: true });
      assert.equal(fs.existsSync(expectedFile), false);
      assert.equal(fs.existsSync(fallbackFile), false);
      const remainingNative = JSON.parse(fs.readFileSync(path.join(nativeDirectory, 'skins.json'), 'utf8'));
      const remainingFallback = JSON.parse(fs.readFileSync(path.join(fallbackDirectory, 'skins.json'), 'utf8'));
      assert.equal(remainingNative.length, structuredId ? 2 : 0);
      assert.equal(remainingFallback.length, structuredId ? 2 : 0);
    }

    const escapeIds = ['../outside', 'C:/outside', 'C:\\outside', '\\\\server\\share', '/absolute'];
    for (const id of escapeIds) {
      for (const method of ['save', 'remove']) {
        const nativeDirectory = path.join(root, `reject-native-${Math.random()}`);
        const fallbackDirectory = path.join(root, `reject-fallback-${Math.random()}`);
        for (const directory of [nativeDirectory, fallbackDirectory]) {
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(path.join(directory, 'skins.json'), '[]');
        }
        if (method === 'save') {
          const skin = { id, dataUrl: 'data:image/png;base64,AQ==' };
          await assert.rejects(nativeAccess(nativeDirectory)[method](nativeDirectory, structuredClone(skin)));
          assert.throws(() => saveFallback(fallbackDirectory, structuredClone(skin)));
        } else {
          await assert.rejects(nativeAccess(nativeDirectory)[method](nativeDirectory, id));
          assert.throws(() => removeFallback(fallbackDirectory, id));
        }
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(nativeDirectory, 'skins.json'), 'utf8')), []);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fallbackDirectory, 'skins.json'), 'utf8')), []);
        assert.equal(fs.existsSync(path.join(root, 'outside.png')), false);
      }
    }

    for (const directory of [path.join(root, 'dotdot-native'), path.join(root, 'dotdot-fallback')]) {
      fs.mkdirSync(directory, { recursive: true });
      const skin = { id: '..', dataUrl: 'data:image/png;base64,AQ==' };
      if (directory.endsWith('native')) {
        assert.deepEqual(await nativeAccess(directory).save(directory, structuredClone(skin)), { success: true });
      } else {
        assert.deepEqual(saveFallback(directory, structuredClone(skin)), { success: true });
      }
      assert.deepEqual(fs.readFileSync(path.join(directory, '...png')), Buffer.from([1]));
    }
  });
});

test('hydration keeps legacy absolute file paths but refuses symlink escapes', async () => {
  buildRustBinary();
  await withTempRoot(async root => {
    const outside = path.join(root, 'outside');
    const nativeDirectory = path.join(root, 'native-skins');
    const fallbackDirectory = path.join(root, 'fallback-skins');
    for (const directory of [outside, nativeDirectory, fallbackDirectory]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.png'), Buffer.from([0, 1, 2, 255]));
    const outsideFile = path.join(outside, 'secret.png');
    const outsidePaths = [
      outsideFile,
      path.relative(nativeDirectory, outsideFile),
      'C:\\outside\\secret.png',
      '\\\\server\\share\\secret.png',
    ];
    for (const filePath of outsidePaths) {
      for (const directory of [nativeDirectory, fallbackDirectory]) {
        fs.writeFileSync(path.join(directory, 'skins.json'), JSON.stringify([{ id: 'external-legacy', filePath }]));
      }
      const nativeSkin = (await nativeAccess(nativeDirectory).getAll(nativeDirectory))[0];
      const fallbackSkin = getAllFallback(fallbackDirectory)[0];
      assert.equal(nativeSkin.filePath, filePath);
      assert.equal(fallbackSkin.filePath, filePath);
      assert.equal(nativeSkin.dataUrl, undefined);
      assert.equal(fallbackSkin.dataUrl, undefined);
    }

    const linkNativeDir = path.join(root, 'link-native');
    const linkFallbackDir = path.join(root, 'link-fallback');
    for (const directory of [linkNativeDir, linkFallbackDir]) fs.mkdirSync(directory, { recursive: true });
    const linkName = path.join(linkNativeDir, 'linked.png');
    let nativeLinkPath = linkName;
    let fallbackLinkPath = path.join(linkFallbackDir, 'linked.png');
    try {
      fs.symlinkSync(path.join(outside, 'secret.png'), linkName, 'file');
      fs.symlinkSync(path.join(outside, 'secret.png'), fallbackLinkPath, 'file');
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
      const nativeJunction = path.join(linkNativeDir, 'dir-link');
      const fallbackJunction = path.join(linkFallbackDir, 'dir-link');
      fs.symlinkSync(outside, nativeJunction, 'junction');
      fs.symlinkSync(outside, fallbackJunction, 'junction');
      nativeLinkPath = path.join(nativeJunction, 'secret.png');
      fallbackLinkPath = path.join(fallbackJunction, 'secret.png');
    }
    for (const [directory, filePath] of [[linkNativeDir, nativeLinkPath], [linkFallbackDir, fallbackLinkPath]]) {
      fs.writeFileSync(path.join(directory, 'skins.json'), JSON.stringify([{ id: 'linked', filePath }]));
    }
    assert.equal((await nativeAccess(linkNativeDir).getAll(linkNativeDir))[0].dataUrl, undefined);
    assert.equal(getAllFallback(linkFallbackDir)[0].dataUrl, undefined);
  });
});

test('native runner falls back on outputs over 64 MiB and commands beyond 10 seconds', async () => {
  const runner = path.join(__dirname, 'fixtures', 'skin-library', 'runner-child.js');
  await assert.rejects(runRustBinary(process.execPath, [runner, 'oversize']), /output exceeded limit/);
  await assert.rejects(runRustBinary(process.execPath, [runner, 'oversize-stderr']), /error output exceeded limit/);
  assert.equal(await runRustBinary(process.execPath, [runner, 'limit-output']), '[]' + ' '.repeat(64 * 1024 * 1024 - 2));
  assert.equal(await runRustBinary(process.execPath, [runner, 'near-timeout']), '[]');
  await assert.rejects(runRustBinary(process.execPath, [runner, 'timeout']), /timed out/);

  await withTempRoot(async root => {
    const binary = useNativePath(root);
    const nativeDir = path.join(root, 'native-skins');
    const fallbackDir = path.join(root, 'fallback-skins');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, 'stub');
    fs.mkdirSync(nativeDir);
    fs.mkdirSync(fallbackDir);
    fs.writeFileSync(path.join(nativeDir, 'skins.json'), JSON.stringify([{ id: 'kept', name: 'Native fallback' }]));
    fs.writeFileSync(path.join(fallbackDir, 'skins.json'), JSON.stringify([{ id: 'kept', name: 'Native fallback' }]));
    const oversized = access(root, false, () => runRustBinary(process.execPath, [runner, 'oversize']));
    const timedOut = access(root, false, () => runRustBinary(process.execPath, [runner, 'timeout']));
    assert.deepEqual(await oversized.getAll(nativeDir), [{ id: 'kept', name: 'Native fallback' }]);
    assert.deepEqual(await timedOut.getAll(nativeDir), [{ id: 'kept', name: 'Native fallback' }]);
    assert.deepEqual(getAllFallback(fallbackDir), [{ id: 'kept', name: 'Native fallback' }]);
    assert.equal(fs.existsSync(binary), true);
  });
});

test('near-64 MiB image payload and actual Rust output fallback match JavaScript', async () => {
  buildRustBinary();
  await withTempRoot(async root => {
    const nativeDirectory = path.join(root, 'large-native');
    const fallbackDirectory = path.join(root, 'large-fallback');
    fs.mkdirSync(nativeDirectory);
    fs.mkdirSync(fallbackDirectory);
    const bytes = Buffer.alloc(47 * 1024 * 1024, 0xa5);
    const skin = { id: 'near-limit', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
    assert.deepEqual(await nativeAccess(nativeDirectory).save(nativeDirectory, structuredClone(skin)), { success: true });
    assert.deepEqual(saveFallback(fallbackDirectory, structuredClone(skin)), { success: true });
    assert.deepEqual(fs.readFileSync(path.join(nativeDirectory, 'near-limit.png')), bytes);
    assert.deepEqual(fs.readFileSync(path.join(fallbackDirectory, 'near-limit.png')), bytes);
    const nativeSkins = await nativeAccess(nativeDirectory).getAll(nativeDirectory);
    const fallbackSkins = getAllFallback(fallbackDirectory);
    assert.equal(nativeSkins[0].dataUrl.length, skin.dataUrl.length);
    assert.equal(nativeSkins[0].dataUrl, skin.dataUrl);
    assert.equal(fallbackSkins[0].dataUrl, skin.dataUrl);

    const largeImage = Buffer.alloc(48 * 1024 * 1024, 0x5a);
    fs.writeFileSync(path.join(nativeDirectory, 'large.png'), largeImage);
    fs.writeFileSync(path.join(fallbackDirectory, 'large.png'), largeImage);
    const largeMetadata = JSON.stringify([{ id: 'large', filePath: path.join(nativeDirectory, 'large.png') }]);
    fs.writeFileSync(path.join(nativeDirectory, 'skins.json'), largeMetadata);
    fs.writeFileSync(path.join(fallbackDirectory, 'skins.json'), JSON.stringify([{ id: 'large', filePath: path.join(fallbackDirectory, 'large.png') }]));
    const oversizedNative = await nativeAccess(nativeDirectory).getAll(nativeDirectory);
    const oversizedFallback = getAllFallback(fallbackDirectory);
    assert.equal(oversizedNative[0].dataUrl.length, 64 * 1024 * 1024 + 'data:image/png;base64,'.length);
    assert.equal(oversizedNative[0].dataUrl, oversizedFallback[0].dataUrl);
  });
});

test('resolver chooses dev release, debug and packaged resources with package declarations', async () => {
  await withTempRoot(async root => {
    const skinDirectory = path.join(root, 'skins');
    writeFixture(skinDirectory);
    const release = path.join(root, 'rust', 'target', 'release', binaryName);
    const debug = path.join(root, 'rust', 'target', 'debug', binaryName);
    const packaged = path.join(root, 'resources', 'native', binaryName);
    for (const candidate of [release, debug, packaged]) {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.writeFileSync(candidate, 'stub');
    }
    const selected = [];
    const expected = expectedFixtureSkins(skinDirectory);
    const runNative = async binary => { selected.push(binary); return JSON.stringify(expected); };
    assert.deepEqual(await access(root, false, runNative).getAll(skinDirectory), expected);
    assert.equal(selected.at(-1), release);
    fs.rmSync(release);
    assert.deepEqual(await access(root, false, runNative).getAll(skinDirectory), expected);
    assert.equal(selected.at(-1), debug);
    assert.deepEqual(await access(root, true, runNative).getAll(skinDirectory), expected);
    assert.equal(selected.at(-1), packaged);

    const resources = packageConfig.build.extraResources[0].filter;
    assert.ok(resources.includes('craftdock-skin-library'));
    assert.ok(resources.includes('craftdock-skin-library.exe'));
    assert.ok(packageConfig.build.files.includes('skin-library.js'));
  });
});

test('production preload invokes unchanged skins IPC for fallback and actual Rust operations', async () => {
  buildRustBinary();
  for (const useRust of [false, true]) {
    await withTempRoot(async root => {
      const skinDirectory = path.join(root, 'craftdock-data', 'skins');
      fs.mkdirSync(skinDirectory, { recursive: true });
      if (useRust) {
        const devBinary = path.join(root, 'rust', 'target', 'debug', binaryName);
        fs.mkdirSync(path.dirname(devBinary), { recursive: true });
        fs.copyFileSync(binaryPath, devBinary);
      }

      const executions = [];
      const baseModule = require('../skin-library');
      const skinModule = useRust
        ? {
          ...baseModule,
          createSkinLibraryAccess: options => baseModule.createSkinLibraryAccess({
            ...options,
            runNative: (binary, args, input = '') => {
              const result = spawnSync(binary, args, { input, encoding: 'utf8' });
              executions.push({ binary, command: args[0], status: result.status });
              if (result.error) throw Object.assign(result.error, { failedToStart: true });
              if (result.status !== 0) throw new Error(result.stderr || `Rust process exited with ${result.status}`);
              return result.stdout;
            },
          }),
        }
        : baseModule;
      const handlers = new Map();
      const { exposed, invocations } = loadProductionIpc(root, handlers, skinModule);
      assert.deepEqual(await exposed.craftdock.skins.getAll(), []);
      const skin = { id: 'ipc-skin', name: 'IPC skin', dataUrl: 'data:image/png;base64,AP8B', model: 'classic' };
      assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdock.skins.save(structuredClone(skin)))), { success: true });
      assert.deepEqual(fs.readFileSync(path.join(skinDirectory, 'ipc-skin.png')), Buffer.from([0, 255, 1]));
      assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdock.skins.getAll())), [
        { id: 'ipc-skin', name: 'IPC skin', filePath: path.join(skinDirectory, 'ipc-skin.png'), model: 'classic', dataUrl: skin.dataUrl },
      ]);
      assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdock.skins.remove('ipc-skin'))), { success: true });
      assert.equal(fs.existsSync(path.join(skinDirectory, 'ipc-skin.png')), false);
      assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdock.skins.remove('ipc-skin'))), { success: true });
      assert.deepEqual(JSON.parse(JSON.stringify(invocations)), [
        ['skins-get-all'],
        ['skins-save', skin],
        ['skins-get-all'],
        ['skins-delete', 'ipc-skin'],
        ['skins-delete', 'ipc-skin'],
      ]);
      if (useRust) {
        assert.deepEqual(executions.map(({ command, status }) => [command, status]), [
          ['get', 0], ['save', 0], ['get', 0], ['delete', 0], ['delete', 0],
        ]);
        assert.ok(executions.every(({ binary }) => binary === path.join(root, 'rust', 'target', 'debug', binaryName)));
      }
    });
  }
});

test('production preload falls back for missing or broken Rust binary and preserves filesystem errors', async () => {
  for (const broken of [false, true]) {
    await withTempRoot(async root => {
      const candidate = path.join(root, 'rust', 'target', 'debug', binaryName);
      if (broken) {
        fs.mkdirSync(path.dirname(candidate), { recursive: true });
        fs.writeFileSync(candidate, 'not executable');
      }
      const handlers = new Map();
      const { exposed } = loadProductionIpc(root, handlers);
      assert.deepEqual(await exposed.craftdock.skins.getAll(), []);
      const skin = { id: 'fallback', name: 'Fallback', dataUrl: 'data:image/png;base64,AQ==' };
      assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdock.skins.save(skin))), { success: true });
      assert.deepEqual(fs.readFileSync(path.join(root, 'craftdock-data', 'skins', 'fallback.png')), Buffer.from([1]));
      assert.deepEqual(JSON.parse(JSON.stringify(await exposed.craftdock.skins.remove('fallback'))), { success: true });
      fs.rmSync(path.join(root, 'craftdock-data', 'skins'), { recursive: true, force: true });
      await assert.rejects(exposed.craftdock.skins.save({ id: 'bad', dataUrl: 'data:image/png;base64,AQ==' }), /ENOENT/);
    });
  }
});
