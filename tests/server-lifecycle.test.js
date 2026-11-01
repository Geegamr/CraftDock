// Server lifecycle: creating a server from scratch, deleting it, accepting the
// EULA on start, and installing a server straight from a .mrpack.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadApp, makeZip, plain, projectRoot, withTempRoot,
} = require('./helpers/electron-app');

const MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

function clientRoutes(version = '1.21.4') {
  return {
    [MANIFEST]: { versions: [{ id: version, url: `https://fixture.invalid/${version}.json` }] },
    [`https://fixture.invalid/${version}.json`]: {
      downloads: { server: { url: `https://fixture.invalid/${version}-server.jar` } },
    },
    [`https://fixture.invalid/${version}-server.jar`]: makeZip([['META-INF/MANIFEST.MF', 'server jar']]),
  };
}

function baseServer(overrides = {}) {
  return {
    id: 'srv_probe',
    name: 'My Server',
    version: '1.21.4',
    software: 'vanilla',
    port: 25570,
    ip: '0.0.0.0',
    javaPath: 'java',
    properties: { motd: 'CraftDock test' },
    ...overrides,
  };
}

test('a vanilla server install writes its jar, EULA and properties into a slug folder', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, { routes: clientRoutes() });

    const result = await app.exposed.craftdockServer.install(baseServer());

    assert.deepEqual(plain(result), { success: true });
    const serverDir = path.join(app.serversDir, 'My_Server');
    assert.ok(fs.existsSync(path.join(serverDir, 'server.jar')), 'server.jar was downloaded');
    assert.equal(fs.readFileSync(path.join(serverDir, 'eula.txt'), 'utf8'), 'eula=true\n');
    const properties = fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8');
    assert.match(properties, /^motd=CraftDock test$/m);
    assert.match(properties, /^server-port=25570$/m);
    assert.match(properties, /^server-ip=$/m, '0.0.0.0 is written as an empty bind address');

    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app.dataDir, 'slug-map.json'), 'utf8')), {
      srv_probe: 'My_Server',
    });
    assert.ok(app.events.some(([channel, id, percent]) =>
      channel === 'server-install-progress' && id === 'srv_probe' && percent === 100));
    assert.deepEqual(app.events.at(-1), ['server-status-change', 'srv_probe', 'stopped']);
  });
});

test('the server jar download reports throughput and time remaining', async () => {
  await withTempRoot(async root => {
    const version = '1.21.4';
    const jar = makeZip([['META-INF/MANIFEST.MF', 'server jar']]);
    // Split the jar into pieces so the download outlives one rate sample window.
    const pieceSize = Math.ceil(jar.length / 12);
    const pieces = [];
    for (let offset = 0; offset < jar.length; offset += pieceSize) {
      pieces.push(jar.subarray(offset, offset + pieceSize));
    }
    const app = loadApp(root, {
      routes: {
        ...clientRoutes(version),
        [`https://fixture.invalid/${version}-server.jar`]: { chunks: pieces, gapMs: 60 },
      },
    });

    const result = plain(await app.exposed.craftdockServer.install(baseServer()));
    assert.equal(result.success, true);

    const progress = app.events.filter(([channel]) => channel === 'server-install-progress');
    const measured = progress.filter(([, , , , stats]) => stats && stats.bytesPerSecond > 0);
    assert.ok(measured.length > 0, 'install progress carries a measured bytes/sec rate');
    assert.ok(measured.every(([, id, , , stats]) =>
      id === 'srv_probe' && stats.received > 0 && stats.received <= stats.total));
    assert.ok(measured.some(([, , , , stats]) => stats.received < stats.total),
      'the rate arrives while bytes remain, so the panel can show a countdown');
    assert.equal(progress.at(-1)[2], 100, 'progress still reaches 100%');

    // The panel renders that rate, and preload forwards it from the main process.
    const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'index.html'), 'utf8');
    assert.match(renderer, /onInstallProgress\(async \(id, pct, msg, stats\) => \{/);
    assert.match(renderer, /const speedLine = downloadSpeedLine\(stats\);/);
    const preload = fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf8');
    assert.match(preload, /'server-install-progress',\(_, id, p, m, stats\) => cb\(id, p, m, stats\)/);
  });
});

test('server software installs create the mods or plugins folder they need', async () => {
  await withTempRoot(async root => {
    // PaperMC's Fill v3 API: the build document carries the download URL.
    const paperBuildUrl = 'https://fill.papermc.io/v3/projects/paper/versions/1.21.4/builds/101';
    const paperJarUrl = 'https://fill-data.papermc.io/v1/objects/abc/paper-1.21.4-101.jar';
    const routes = {
      ...clientRoutes(),
      [paperBuildUrl]: { id: 101, downloads: { 'server:default': { name: 'paper-1.21.4-101.jar', url: paperJarUrl } } },
      [paperJarUrl]: makeZip([['paper.txt', 'paper jar']]),
    };
    const app = loadApp(root, { routes });

    const result = await app.exposed.craftdockServer.install(baseServer({
      id: 'srv_paper', name: 'Paper Server', software: 'paper', build: 101,
    }));

    assert.deepEqual(plain(result), { success: true });
    const serverDir = path.join(app.serversDir, 'Paper_Server');
    assert.ok(fs.existsSync(path.join(serverDir, 'plugins')));
    assert.ok(!fs.existsSync(path.join(serverDir, 'mods')));
    assert.ok(fs.existsSync(path.join(serverDir, 'server.jar')));
  });
});

test('deleting a server removes its folder and is idempotent', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, { routes: clientRoutes() });
    await app.exposed.craftdockServer.install(baseServer());
    const serverDir = path.join(app.serversDir, 'My_Server');
    fs.mkdirSync(path.join(serverDir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'world', 'level.dat'), 'world data');
    assert.ok(fs.existsSync(serverDir));

    assert.deepEqual(plain(await app.exposed.craftdockServer.deleteServer('srv_probe')), { success: true });
    assert.equal(fs.existsSync(serverDir), false);

    assert.deepEqual(plain(await app.exposed.craftdockServer.deleteServer('srv_probe')), { success: true });
  });
});

test('deleting a running server kills its process before removing the folder', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, { routes: clientRoutes() });
    await app.exposed.craftdockServer.install(baseServer());
    const started = await app.exposed.craftdockServer.start(baseServer());
    assert.equal(started.success, true);

    assert.deepEqual(plain(await app.exposed.craftdockServer.deleteServer('srv_probe')), { success: true });
    assert.ok(app.kills.some(kill => kill.signal === 'SIGKILL'));
    assert.equal(fs.existsSync(path.join(app.serversDir, 'My_Server')), false);
  });
});

test('starting a server auto-accepts the EULA and launches the jar', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, { routes: clientRoutes() });
    await app.exposed.craftdockServer.install(baseServer());
    const serverDir = path.join(app.serversDir, 'My_Server');
    fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=false\n');

    const result = await app.exposed.craftdockServer.start(baseServer({ ramMin: 1024, ramMax: 4096, jvmFlags: '-XX:+UseG1GC' }));

    assert.deepEqual(plain(result), { success: true });
    const eula = fs.readFileSync(path.join(serverDir, 'eula.txt'), 'utf8');
    assert.match(eula, /eula=true/);
    assert.doesNotMatch(eula, /eula=false/);

    const launch = app.spawnCalls.filter(call => Array.isArray(call.args) && call.args.includes('-jar')).at(-1);
    assert.ok(launch, 'the server jar was started');
    assert.deepEqual(plain(launch.args), [
      '-Xms1024M', '-Xmx4096M', '-XX:+UseG1GC',
      '-jar', path.join(serverDir, 'server.jar'), '--nogui',
    ]);
    assert.equal(launch.options.cwd, serverDir);
    assert.deepEqual(app.events.at(-1), ['server-status-change', 'srv_probe', 'running']);

    assert.deepEqual(plain(await app.exposed.craftdockServer.stop('srv_probe')), { success: true });
    assert.equal(app.stdinWrites.at(-1)[2], 'stop\n');
  });
});

test('starting a server without an installed jar reports the missing jar and does not spawn', async () => {
  await withTempRoot(async root => {
    const app = loadApp(root, { routes: clientRoutes() });
    fs.mkdirSync(path.join(app.serversDir, 'srv_probe'), { recursive: true });

    const result = await app.exposed.craftdockServer.start(baseServer());

    assert.deepEqual(plain(result), { success: false, error: 'server.jar not found' });
    assert.equal(app.spawnCalls.filter(call => Array.isArray(call.args) && call.args.includes('--nogui')).length, 0);
    assert.ok(app.events.some(([channel, , line]) => channel === 'server-log' && /not found/.test(line)));
  });
});

test('installing a server from a .mrpack installs the loader, mods, overrides and EULA', async () => {
  await withTempRoot(async root => {
    const pack = makeZip([
      ['modrinth.index.json', JSON.stringify({
        formatVersion: 1,
        game: 'minecraft',
        name: 'Server Pack',
        dependencies: { minecraft: '1.21.4', 'fabric-loader': '0.15.11' },
        files: [
          { path: 'mods/jei.jar', downloads: ['https://cdn.example/jei.jar'], env: { client: 'required', server: 'required' } },
          { path: 'mods/client-only.jar', downloads: ['https://cdn.example/client.jar'], env: { client: 'required', server: 'unsupported' } },
        ],
      })],
      ['server-overrides/config/server.toml', 'enabled = true'],
      ['overrides/server.properties.extra', 'ignored-by-server'],
    ]);
    const app = loadApp(root, {
      routes: {
        ...clientRoutes(),
        'https://cdn.example/pack.mrpack': pack,
        'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar': 'installer bytes',
        'https://cdn.example/jei.jar': 'jei bytes',
        'https://cdn.example/client.jar': 'client bytes',
      },
      onSpawn: ({ args, child, spawnOptions }) => {
        if (args.includes('server')) {
          fs.writeFileSync(path.join(spawnOptions.cwd, 'fabric-server-launch.jar'), 'fabric launcher');
          queueMicrotask(() => child.emit('close', 0));
        }
      },
    });

    const result = await app.exposed.craftdockServer.installModpack(
      baseServer({ id: 'srv_pack', name: 'Pack Server', software: 'fabric' }),
      'https://cdn.example/pack.mrpack',
    );

    assert.deepEqual(plain(result), { success: true, mcVersion: '1.21.4', loader: 'fabric', failedFiles: [] });
    const serverDir = path.join(app.serversDir, 'Pack_Server');
    assert.ok(fs.existsSync(path.join(serverDir, 'fabric-server-launch.jar')));
    assert.ok(fs.existsSync(path.join(serverDir, 'server.jar')), 'vanilla server jar is downloaded too');
    assert.equal(fs.readFileSync(path.join(serverDir, 'mods', 'jei.jar'), 'utf8'), 'jei bytes');
    assert.equal(fs.existsSync(path.join(serverDir, 'mods', 'client-only.jar')), false,
      'server-unsupported files are not installed');
    assert.equal(fs.readFileSync(path.join(serverDir, 'config', 'server.toml'), 'utf8'), 'enabled = true');
    assert.equal(fs.readFileSync(path.join(serverDir, 'server.properties.extra'), 'utf8'), 'ignored-by-server',
      'plain overrides/ entries are applied next to server-overrides/');
    assert.match(fs.readFileSync(path.join(serverDir, 'eula.txt'), 'utf8'), /eula=true/);
    assert.equal(fs.existsSync(path.join(serverDir, '_modpack.mrpack')), false);
    assert.ok(app.events.some(([channel, , percent]) =>
      channel === 'server-install-progress' && percent === 100));
  });
});

test('a modpack server install reports download failures without aborting', async () => {
  await withTempRoot(async root => {
    const pack = makeZip([
      ['modrinth.index.json', JSON.stringify({
        dependencies: { minecraft: '1.21.4', 'fabric-loader': '0.15.11' },
        files: [
          { path: 'mods/ok.jar', downloads: ['https://cdn.example/ok.jar'] },
          { path: 'mods/missing.jar', downloads: ['https://cdn.example/missing.jar'] },
        ],
      })],
    ]);
    const app = loadApp(root, {
      routes: {
        ...clientRoutes(),
        'https://cdn.example/pack.mrpack': pack,
        'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar': 'installer bytes',
        'https://cdn.example/ok.jar': 'ok bytes',
      },
      onSpawn: ({ args, child, spawnOptions }) => {
        if (args.includes('server')) {
          fs.writeFileSync(path.join(spawnOptions.cwd, 'fabric-server-launch.jar'), 'fabric launcher');
          queueMicrotask(() => child.emit('close', 0));
        }
      },
    });

    const result = await app.exposed.craftdockServer.installModpack(
      baseServer({ id: 'srv_partial', name: 'Partial Server', software: 'fabric' }),
      'https://cdn.example/pack.mrpack',
    );

    assert.equal(result.success, true);
    assert.deepEqual(plain(result.failedFiles), [{ path: 'mods/missing.jar', error: 'HTTP 404 for https://cdn.example/missing.jar' }]);
    assert.ok(fs.existsSync(path.join(app.serversDir, 'Partial_Server', 'mods', 'ok.jar')));
  });
});
