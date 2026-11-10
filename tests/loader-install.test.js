// Forge/NeoForge launches must never silently fall back to vanilla: opening a
// modded world without its loader rewrites level.dat and corrupts the save.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadApp, seedAccount, plain, prepareClientCache, withTempRoot, writeInstance,
} = require('./helpers/electron-app');

const MC_VERSION = '1.21.1';
const LOADER_VERSION = '21.1.233';
const INSTALLER_URL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.233/neoforge-21.1.233-installer.jar';
const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

function setup(root, options = {}) {
  prepareClientCache(root, MC_VERSION);
  const app = loadApp(root, {
    ...options,
    routes: {
      [MANIFEST_URL]: {
        versions: [{ id: MC_VERSION, url: 'https://fixture.invalid/1.21.1.json' }],
      },
      ...(options.routes || {}),
    },
  });
  seedAccount(root);
  writeInstance(app, 'inst_loader', {
    name: 'Loader Test',
    mcVersion: MC_VERSION,
    loader: 'neoforge',
    loaderVersion: LOADER_VERSION,
  });
  return app;
}

const gameSpawns = app => app.spawnCalls.filter(call =>
  Array.isArray(call.args) && call.args.includes('--gameDir'));

test('an unavailable loader aborts the launch instead of starting vanilla', async () => {
  await withTempRoot(async root => {
    const app = setup(root);

    const result = plain(await app.exposed.craftdockInstance.launch({ id: 'inst_loader' }));

    assert.equal(result.success, false);
    assert.match(result.error, /neoforge could not be installed/i);
    assert.ok(
      app.network.requested.includes(INSTALLER_URL),
      `expected the versioned installer to be requested, got: ${app.network.requested.join(', ')}`,
    );
    assert.equal(gameSpawns(app).length, 0, 'no Minecraft process may start without its loader');
  });
});

test('a successful install launches the loader profile with its JVM and game arguments', async () => {
  await withTempRoot(async root => {
    let installerArgs = null;
    let installedLibrary = null;
    let installedLibrariesDir = null;

    const app = setup(root, {
      routes: { [INSTALLER_URL]: Buffer.from('installer') },
      execFileSync(_file, args) {
        installerArgs = args;
        const installRoot = args[args.indexOf('--installClient') + 1];
        installedLibrariesDir = path.join(installRoot, 'libraries');
        const profileDir = path.join(installRoot, 'versions', `neoforge-${LOADER_VERSION}`);
        installedLibrary = path.join(
          installRoot, 'libraries', 'net', 'neoforged', 'neoforge', LOADER_VERSION,
          `neoforge-${LOADER_VERSION}-client.jar`,
        );
        fs.mkdirSync(profileDir, { recursive: true });
        fs.mkdirSync(path.dirname(installedLibrary), { recursive: true });
        fs.writeFileSync(installedLibrary, 'loader jar');
        fs.writeFileSync(
          path.join(profileDir, `neoforge-${LOADER_VERSION}.json`),
          JSON.stringify({
            id: `neoforge-${LOADER_VERSION}`,
            mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
            arguments: {
              jvm: [
                '-DlibraryDirectory=${library_directory}',
                '-p',
                '${library_directory}/cpw/mods/bootstraplauncher/2.0.2/bootstraplauncher-2.0.2.jar${classpath_separator}${library_directory}/cpw/mods/securejarhandler/3.0.8/securejarhandler-3.0.8.jar',
              ],
              game: ['--fml.neoForgeVersion', LOADER_VERSION],
            },
            libraries: [{
              name: `net.neoforged:neoforge:${LOADER_VERSION}`,
              downloads: {
                artifact: {
                  path: `net/neoforged/neoforge/${LOADER_VERSION}/neoforge-${LOADER_VERSION}-client.jar`,
                  url: 'https://fixture.invalid/loader.jar',
                },
              },
            }],
          }),
        );
        return '';
      },
    });

    const result = plain(await app.exposed.craftdockInstance.launch({ id: 'inst_loader' }));

    assert.equal(result.success, true);
    assert.ok(installerArgs.includes('--installClient'), 'the installer must run for a requested loader version');
    const javaArgs = gameSpawns(app)[0].args;
    assert.ok(javaArgs.includes('cpw.mods.bootstraplauncher.BootstrapLauncher'));
    assert.ok(javaArgs.includes('--fml.neoForgeVersion'));
    assert.ok(javaArgs.includes(`-DlibraryDirectory=${installedLibrariesDir}`));
    const modulePathIndex = javaArgs.indexOf('-p');
    assert.ok(modulePathIndex > 0 && modulePathIndex < javaArgs.indexOf('-cp'));
    assert.match(javaArgs[modulePathIndex + 1], /bootstraplauncher-2\.0\.2\.jar/);
    assert.ok(javaArgs[javaArgs.indexOf('-cp') + 1].includes(installedLibrary));
  });
});
