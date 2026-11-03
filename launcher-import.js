// Importing instances that already live in another Minecraft launcher.
//
// Nothing here edits the launcher it reads from: the instance folder is opened
// read-only, the game files are copied into a fresh CraftDock instance, and the
// metadata that made the old instance updateable is translated into the fields
// CraftDock's own update checks read (`sourceId` / `sourceVersionId` for the
// pack, `source` + `id` + `versionId` for each mod).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'CraftDock-launcher-import/1.0 (contact@craftdock.app)';
const MAX_METADATA_BYTES = 64 * 1024 * 1024;

// Component uids used by Prism Launcher and MultiMC in mmc-pack.json.
const LOADER_UIDS = {
  'net.fabricmc.fabric-loader': 'fabric',
  'org.quiltmc.quilt-loader': 'quilt',
  'net.minecraftforge': 'forge',
  'net.neoforged': 'neoforge',
};

// Top-level entries of a game folder that are either launcher-own bookkeeping
// (recreated by CraftDock) or downloaded game data that would add gigabytes to
// the copy for nothing.
const SKIP_TOP_LEVEL = new Set([
  'libraries', 'assets', 'versions', 'bin', 'natives', 'logs', 'crash-reports',
  'runtime', 'java', 'jre', 'jdk', 'downloads', '.cache', '.tmp', '.git',
  'mrpack', 'flame', 'patches', 'jarmods', 'coremods/.cache',
  'instance.cfg', 'mmc-pack.json', 'minecraftinstance.json', 'instance.json',
  'profile.json', 'instance.png', 'icon.png', 'mods.toml', 'modlist.html',
  'install_profile.json', 'version.json', 'user_jvm_args.txt',
  'run.bat', 'run.sh', 'unix_args.txt', 'win_args.txt', 'launcher_profiles.json',
]);

function isTrue(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function readIni(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
    const split = trimmed.indexOf('=');
    if (split < 1) continue;
    out[trimmed.slice(0, split).trim()] = trimmed.slice(split + 1).trim();
  }
  return out;
}

// Prism stores Forge/NeoForge descriptors with the Minecraft version glued on
// ("1.20.1-47.2.0"); CraftDock launches with the bare loader version.
function normalizeLoaderVersion(loader, mcVersion, raw) {
  let value = String(raw == null ? '' : raw).trim();
  if (!value) return '';
  value = value.replace(/^(forge|neoforge|fabric|quilt)[-_ ]/i, '');
  if ((loader === 'forge' || loader === 'neoforge') && mcVersion && value.startsWith(`${mcVersion}-`)) {
    value = value.slice(mcVersion.length + 1);
  }
  return value;
}

function parseMmcPack(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data || data.formatVersion !== 1 || !Array.isArray(data.components)) return null;
  let mcVersion = '';
  let loader = '';
  let loaderVersion = '';
  for (const component of data.components) {
    if (!component || typeof component.uid !== 'string' || component.disabled) continue;
    if (component.uid === 'net.minecraft' && typeof component.version === 'string') mcVersion = component.version;
  }
  for (const component of data.components) {
    if (!component || component.disabled) continue;
    const mapped = LOADER_UIDS[component.uid];
    if (!mapped || loader) continue;
    loader = mapped;
    loaderVersion = normalizeLoaderVersion(mapped, mcVersion, component.version);
  }
  return { mcVersion, loader, loaderVersion };
}

function countEntries(dir) {
  try { return fs.readdirSync(dir).length; } catch { return 0; }
}

function countJars(dir) {
  try {
    return fs.readdirSync(dir).filter(name => /\.jar(\.disabled)?$/i.test(name)).length;
  } catch { return 0; }
}

function countWorlds(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).length;
  } catch { return 0; }
}

function statSafe(filePath) {
  try { return fs.statSync(filePath); } catch { return null; }
}

function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function readJsonCapped(filePath) {
  const stat = statSafe(filePath);
  if (!stat || !stat.isFile() || stat.size > MAX_METADATA_BYTES) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function readTextHead(filePath, bytes) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    fs.closeSync(fd);
    return buffer.slice(0, read).toString('utf8');
  } catch { return ''; }
}

// Modrinth App writes the same line every launch:
//   [Render thread/INFO]: Loading Minecraft 1.21.1 with Fabric Loader 0.16.5
function inferFromLog(profileDir) {
  const text = readTextHead(path.join(profileDir, 'logs', 'latest.log'), 64 * 1024);
  const match = /Loading Minecraft (\S+) with (.+?) (\d[\w.+-]*)/.exec(text);
  if (!match) return { mcVersion: '', loader: '', loaderVersion: '' };
  const label = match[2].toLowerCase();
  const loader = label.includes('neoforge') ? 'neoforge'
    : label.includes('forge') ? 'forge'
      : label.includes('quilt') ? 'quilt'
        : label.includes('fabric') ? 'fabric' : '';
  return { mcVersion: match[1], loader, loaderVersion: match[3] };
}

function loaderFromLabel(label) {
  const value = String(label || '').toLowerCase();
  if (value.includes('neoforge')) return 'neoforge';
  if (value.includes('forge')) return 'forge';
  if (value.includes('quilt')) return 'quilt';
  if (value.includes('fabric')) return 'fabric';
  return '';
}

function readIconDataUrl(filePath) {
  const stat = statSafe(filePath);
  if (!stat || !stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
  if (!/\.(png|jpe?g|webp)$/i.test(filePath)) return null;
  try {
    const mime = /\.png$/i.test(filePath) ? 'image/png' : /\.webp$/i.test(filePath) ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
  } catch { return null; }
}

function launcherDefinitions({ platform, home, env }) {
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const macSupport = path.join(home, 'Library', 'Application Support');
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');

  const prismRoots = platform === 'win32'
    ? [path.join(appData, 'PrismLauncher'), path.join(appData, 'PolyMC')]
    : platform === 'darwin'
      ? [path.join(macSupport, 'PrismLauncher'), path.join(macSupport, 'PolyMC')]
      : [
        path.join(dataHome, 'PrismLauncher'),
        path.join(home, '.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher'),
      ];

  const multimcRoots = platform === 'win32'
    ? [path.join(appData, 'MultiMC'), path.join(appData, 'MultiMC5')]
    : platform === 'darwin'
      ? [path.join(macSupport, 'multimc'), path.join(macSupport, 'MultiMC')]
      : [path.join(dataHome, 'multimc'), path.join(dataHome, 'MultiMC')];

  const modrinthRoots = platform === 'win32'
    ? [path.join(appData, 'ModrinthApp'), path.join(appData, 'com.modrinth.theseus')]
    : platform === 'darwin'
      ? [path.join(macSupport, 'ModrinthApp'), path.join(macSupport, 'com.modrinth.theseus')]
      : [path.join(dataHome, 'ModrinthApp'), path.join(dataHome, 'com.modrinth.theseus')];

  // The CurseForge app calls this the "Minecraft modding folder"; it can be
  // moved in its settings, which is why the folder can also be chosen by hand.
  const curseforgeRoots = [
    path.join(home, 'curseforge', 'minecraft'),
    path.join(home, 'Documents', 'curseforge', 'minecraft'),
    path.join(appData, 'curseforge', 'minecraft'),
  ];

  const atlauncherRoots = platform === 'win32'
    ? [path.join(appData, '.atlauncher'), path.join(appData, 'ATLauncher')]
    : platform === 'darwin'
      ? [path.join(macSupport, '.atlauncher'), path.join(macSupport, 'ATLauncher')]
      : [
        path.join(home, '.atlauncher'),
        path.join(home, '.var/app/com.atlauncher.ATLauncher/config/.atlauncher'),
      ];

  return [
    {
      id: 'prism',
      name: 'Prism Launcher',
      kind: 'multimc',
      roots: prismRoots,
      marker: 'instance.cfg',
      hint: 'The Prism Launcher folder, the one holding instances/',
      openSource: 'https://github.com/PrismLauncher/PrismLauncher',
    },
    {
      id: 'multimc',
      name: 'MultiMC',
      kind: 'multimc',
      roots: multimcRoots,
      marker: 'instance.cfg',
      hint: 'The MultiMC folder, the one holding instances/',
      openSource: 'https://github.com/MultiMC/Launcher',
    },
    {
      id: 'modrinth',
      name: 'Modrinth App',
      kind: 'modrinth',
      roots: modrinthRoots,
      marker: 'profiles',
      hint: 'The Modrinth App folder, the one holding profiles/ and app.db',
      openSource: 'https://github.com/modrinth/code',
    },
    {
      id: 'curseforge',
      name: 'CurseForge',
      kind: 'curseforge',
      roots: curseforgeRoots,
      marker: 'Instances',
      hint: 'The CurseForge modding folder, the one holding Instances/',
      openSource: null,
    },
    {
      id: 'atlauncher',
      name: 'ATLauncher',
      kind: 'atlauncher',
      roots: atlauncherRoots,
      marker: 'instances',
      hint: 'The .atlauncher folder, the one holding instances/',
      openSource: 'https://github.com/ATLauncher/ATLauncher',
    },
  ];
}

function createLauncherImporter(options = {}) {
  const {
    instancesBase,
    registerSlug,
    ensureInstance,
    instDir,
    writeInstMeta,
    platform = process.platform,
    home = os.homedir(),
    env = process.env,
    fetchImpl = globalThis.fetch,
    log = console,
    // CurseForge project ids → logo URL. Supplied by the caller because only the
    // main process holds the API key; logos are cosmetic, so a failure is fine.
    curseForgeIcons = null,
  } = options;

  const definitions = launcherDefinitions({ platform, home, env });

  function definitionFor(launcherId) {
    const found = definitions.find(def => def.id === launcherId);
    if (!found) throw new Error(`Unknown launcher: ${launcherId}`);
    return found;
  }

  // ── Multimc-App / MultiMC ────────────────────────────────────────────────
  function multimcRoots(root) {
    const roots = [path.join(root, 'instances')];
    for (const configName of ['prismlauncher.cfg', 'polymc.cfg', 'multimc.cfg']) {
      const configPath = path.join(root, configName);
      if (!fs.existsSync(configPath)) continue;
      let config;
      try { config = readIni(fs.readFileSync(configPath, 'utf8')); } catch { continue; }
      if (config.InstanceDir && !/^@/.test(config.InstanceDir)) {
        roots.push(path.resolve(root, config.InstanceDir));
      }
      const extra = config.AdditionalInstanceDirs || '';
      if (extra && !/^@/.test(extra)) {
        for (const piece of extra.split(',')) {
          const value = piece.trim().replace(/^"|"$/g, '');
          if (value) roots.push(path.resolve(root, value));
        }
      }
    }
    return [...new Set(roots)];
  }

  function multimcGameDir(instanceDir) {
    const gameDir = path.join(instanceDir, 'minecraft');
    if (fs.existsSync(gameDir)) return gameDir;
    const dotDir = path.join(instanceDir, '.minecraft');
    if (fs.existsSync(dotDir)) return dotDir;
    return instanceDir;
  }

  function scanMultimc(root) {
    const instances = [];
    for (const instancesRoot of multimcRoots(root)) {
      let entries;
      try { entries = fs.readdirSync(instancesRoot, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === '.tmp') continue;
        const instanceDir = path.join(instancesRoot, entry.name);
        const configPath = path.join(instanceDir, 'instance.cfg');
        if (!fs.existsSync(configPath)) continue;
        let config = {};
        try { config = readIni(fs.readFileSync(configPath, 'utf8')); } catch { continue; }
        if (config.InstanceType && config.InstanceType !== 'OneSix') continue;

        const gameDir = multimcGameDir(instanceDir);
        let packInfo = null;
        try { packInfo = parseMmcPack(fs.readFileSync(path.join(instanceDir, 'mmc-pack.json'), 'utf8')); } catch {}

        let pack = null;
        if (isTrue(config.ManagedPack)) {
          const type = String(config.ManagedPackType || '').toLowerCase();
          pack = {
            // Prism calls CurseForge "flame"; both map to the same platform id.
            type: type === 'flame' ? 'curseforge' : (type || 'unknown'),
            id: config.ManagedPackID || '',
            versionId: config.ManagedPackVersionID || '',
            versionName: config.ManagedPackVersionName || '',
            name: config.ManagedPackName || config.name || '',
          };
        }

        const iconKey = config.iconKey && config.iconKey !== 'default' ? config.iconKey : '';
        const iconPath = iconKey && fs.existsSync(path.join(root, 'icons', iconKey))
          ? path.join(root, 'icons', iconKey)
          : (fs.existsSync(path.join(instanceDir, 'icon.png')) ? path.join(instanceDir, 'icon.png') : null);

        const seconds = Number(config.totalTimePlayed || 0);
        instances.push({
          externalId: entry.name,
          name: config.name || entry.name,
          path: instanceDir,
          gameDir,
          mcVersion: packInfo?.mcVersion || '',
          loader: packInfo?.loader || '',
          loaderVersion: packInfo?.loaderVersion || '',
          pack,
          mods: [],
          modCount: countJars(path.join(gameDir, 'mods')),
          worldCount: countWorlds(path.join(gameDir, 'saves')),
          notes: config.notes || '',
          playMinutes: Number.isFinite(seconds) ? Math.round(seconds / 60) : 0,
          iconPath,
        });
      }
    }
    return instances;
  }

  // ── Modrinth App ─────────────────────────────────────────────────────────
  function readModrinthRows(root) {
    const dbPath = path.join(root, 'app.db');
    if (!fs.existsSync(dbPath)) return null;
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); } catch { return null; }
    let db;
    try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return null; }
    try {
      // Current schema: instances + applied content set + link row.
      try {
        const rows = db.prepare(`
          SELECT i.path AS path, i.name AS name, i.icon_path AS icon_path,
                 cs.game_version AS game_version, cs.loader AS loader, cs.loader_version AS loader_version,
                 l.modrinth_project_id AS project_id, l.modrinth_version_id AS version_id
          FROM instances i
          LEFT JOIN instance_content_sets cs ON cs.id = i.applied_content_set_id
          LEFT JOIN instance_links l ON l.instance_id = i.id
        `).all();
        if (rows.length) {
          return rows.map(row => ({
            externalId: String(row.path),
            name: String(row.name || row.path),
            mcVersion: row.game_version ? String(row.game_version) : '',
            loader: row.loader ? loaderFromLabel(row.loader) || String(row.loader) : '',
            loaderVersion: row.loader_version ? String(row.loader_version) : '',
            icon: row.icon_path ? String(row.icon_path) : '',
            pack: row.project_id ? {
              type: 'modrinth',
              id: String(row.project_id),
              versionId: row.version_id ? String(row.version_id) : '',
              versionName: '',
              name: String(row.name || ''),
            } : null,
          }));
        }
      } catch {}
      // Older schema: one profiles row per instance.
      try {
        const rows = db.prepare(`
          SELECT path, name, icon_path, game_version, mod_loader, mod_loader_version,
                 linked_project_id, linked_version_id
          FROM profiles
        `).all();
        return rows.map(row => ({
          externalId: String(row.path),
          name: String(row.name || row.path),
          mcVersion: row.game_version ? String(row.game_version) : '',
          loader: row.mod_loader ? loaderFromLabel(row.mod_loader) || String(row.mod_loader) : '',
          loaderVersion: row.mod_loader_version ? String(row.mod_loader_version) : '',
          icon: row.icon_path ? String(row.icon_path) : '',
          pack: row.linked_project_id ? {
            type: 'modrinth',
            id: String(row.linked_project_id),
            versionId: row.linked_version_id ? String(row.linked_version_id) : '',
            versionName: '',
            name: String(row.name || ''),
          } : null,
        }));
      } catch { return null; }
    } catch {
      return null;
    } finally {
      try { db.close(); } catch {}
    }
  }

  function scanModrinth(root) {
    const profilesDir = path.join(root, 'profiles');
    const rows = readModrinthRows(root);
    if (rows) {
      return rows.map(row => {
        const profileDir = path.join(profilesDir, row.externalId);
        const iconPath = row.icon && fs.existsSync(path.join(root, row.icon))
          ? path.join(root, row.icon)
          : (fs.existsSync(path.join(profilesDir, row.icon || '')) ? path.join(profilesDir, row.icon) : null);
        return {
          externalId: row.externalId,
          name: row.name,
          path: profileDir,
          gameDir: profileDir,
          mcVersion: row.mcVersion,
          loader: row.loader,
          loaderVersion: row.loaderVersion,
          pack: row.pack,
          mods: [],
          modCount: countJars(path.join(profileDir, 'mods')),
          worldCount: countWorlds(path.join(profileDir, 'saves')),
          playMinutes: 0,
          iconPath: iconPath || (fs.existsSync(path.join(profileDir, 'icon.png')) ? path.join(profileDir, 'icon.png') : null),
        };
      });
    }

    // No readable database (older build, or the SQLite module is unavailable):
    // fall back to the profile folders and the log line each one writes.
    const instances = [];
    let entries = [];
    try { entries = fs.readdirSync(profilesDir, { withFileTypes: true }); } catch { return instances; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const profileDir = path.join(profilesDir, entry.name);
      const inferred = inferFromLog(profileDir);
      instances.push({
        externalId: entry.name,
        name: entry.name,
        path: profileDir,
        gameDir: profileDir,
        mcVersion: inferred.mcVersion,
        loader: inferred.loader,
        loaderVersion: inferred.loaderVersion,
        pack: null,
        mods: [],
        modCount: countJars(path.join(profileDir, 'mods')),
        worldCount: countWorlds(path.join(profileDir, 'saves')),
        playMinutes: 0,
        iconPath: fs.existsSync(path.join(profileDir, 'icon.png')) ? path.join(profileDir, 'icon.png') : null,
      });
    }
    return instances;
  }

  // ── CurseForge app ───────────────────────────────────────────────────────
  function curseforgeInstancesDir(root) {
    const base = path.basename(root).toLowerCase() === 'instances' ? root : path.join(root, 'Instances');
    return base;
  }

  function scanCurseForge(root) {
    const instancesDir = curseforgeInstancesDir(root);
    const instances = [];
    let entries = [];
    try { entries = fs.readdirSync(instancesDir, { withFileTypes: true }); } catch { return instances; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const instanceDir = path.join(instancesDir, entry.name);
      const metaPath = path.join(instanceDir, 'minecraftinstance.json');
      if (!fs.existsSync(metaPath)) continue;
      const data = readJsonCapped(metaPath);
      if (!data || typeof data !== 'object') continue;

      const loaderName = String(data.baseModLoader?.name || '');
      const loader = loaderFromLabel(loaderName);
      let mcVersion = String(data.gameVersion || data.baseModLoader?.minecraftVersion || '');
      if (!mcVersion) {
        try { mcVersion = String(JSON.parse(data.baseModLoader?.versionJson || '{}').inheritsFrom || ''); } catch {}
      }
      const loaderVersion = normalizeLoaderVersion(loader, mcVersion, loaderName.replace(/^[a-z]+[- ]/i, ''));

      const manifest = data.manifest && typeof data.manifest === 'object' ? data.manifest : null;
      const pack = manifest ? {
        type: 'curseforge',
        // The pack's own project id is not part of manifest.json; use it when
        // the app wrote one, otherwise the name/version still identifies the pack.
        id: data.projectID ? String(data.projectID) : (data.modpackProjectID ? String(data.modpackProjectID) : ''),
        versionId: data.fileID ? String(data.fileID) : '',
        versionName: String(manifest.version || ''),
        name: String(manifest.name || data.name || entry.name),
      } : null;

      const rawMods = Array.isArray(data.installedMods) ? data.installedMods
        : Array.isArray(data.installedAddons) ? data.installedAddons : [];
      const mods = [];
      for (const mod of rawMods) {
        if (!mod || typeof mod !== 'object') continue;
        const onDisk = String(mod.fileNameOnDisk || '');
        if (!/\.jar(\.disabled)?$/i.test(onDisk)) continue;
        const projectId = mod.projectID || mod.addonID || '';
        mods.push({
          fileName: onDisk,
          source: 'curseforge',
          projectId: projectId ? String(projectId) : '',
          fileId: (mod.fileID || mod.fileId) ? String(mod.fileID || mod.fileId) : '',
          name: mod.name ? String(mod.name) : '',
        });
      }

      instances.push({
        externalId: entry.name,
        name: String(data.name || entry.name),
        path: instanceDir,
        gameDir: instanceDir,
        mcVersion,
        loader,
        loaderVersion,
        pack,
        mods,
        modCount: countJars(path.join(instanceDir, 'mods')),
        worldCount: countWorlds(path.join(instanceDir, 'saves')),
        playMinutes: 0,
        iconPath: fs.existsSync(path.join(instanceDir, 'icon.png')) ? path.join(instanceDir, 'icon.png') : null,
      });
    }
    return instances;
  }

  // ── ATLauncher ───────────────────────────────────────────────────────────
  function scanAtLauncher(root) {
    const instancesDir = path.join(root, 'instances');
    const alternate = path.join(root, 'Instances');
    const base = fs.existsSync(instancesDir) ? instancesDir : alternate;
    const instances = [];
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return instances; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const instanceDir = path.join(base, entry.name);
      const metaPath = path.join(instanceDir, 'instance.json');
      if (!fs.existsSync(metaPath)) continue;
      const data = readJsonCapped(metaPath);
      if (!data || typeof data !== 'object') continue;

      const launcher = data.launcher && typeof data.launcher === 'object' ? data.launcher : {};
      const loaderType = String(launcher.loaderVersion?.type || '');
      const loader = loaderFromLabel(loaderType);
      const mcVersion = String(data.id || '');
      const loaderVersion = normalizeLoaderVersion(loader, mcVersion, launcher.loaderVersion?.version || launcher.loaderVersion?.rawVersion || '');

      let pack = null;
      if (launcher.curseForgeProject?.id) {
        pack = {
          type: 'curseforge',
          id: String(launcher.curseForgeProject.id),
          versionId: launcher.curseForgeFile?.id ? String(launcher.curseForgeFile.id) : '',
          versionName: String(launcher.curseForgeFile?.displayName || launcher.version || ''),
          name: String(launcher.pack || launcher.name || entry.name),
        };
      } else if (launcher.modrinthProject?.id) {
        pack = {
          type: 'modrinth',
          id: String(launcher.modrinthProject.id),
          versionId: launcher.modrinthVersion?.id ? String(launcher.modrinthVersion.id) : '',
          versionName: String(launcher.modrinthVersion?.versionNumber || launcher.version || ''),
          name: String(launcher.pack || launcher.name || entry.name),
        };
      }

      const mods = [];
      for (const mod of Array.isArray(launcher.mods) ? launcher.mods : []) {
        if (!mod || typeof mod !== 'object' || !mod.file) continue;
        if (String(mod.type || 'mods').toLowerCase() !== 'mods') continue;
        const fileName = String(mod.file);
        const entryRecord = { fileName: mod.disabled ? `${fileName}.disabled` : fileName, name: mod.name ? String(mod.name) : '' };
        if (mod.modrinthProject?.id) {
          entryRecord.source = 'modrinth';
          entryRecord.projectId = String(mod.modrinthProject.id);
          entryRecord.versionId = mod.modrinthVersion?.id ? String(mod.modrinthVersion.id) : '';
          entryRecord.versionName = mod.modrinthVersion?.versionNumber ? String(mod.modrinthVersion.versionNumber) : '';
        } else if (mod.curseForgeProjectId || mod.curseModId) {
          entryRecord.source = 'curseforge';
          entryRecord.projectId = String(mod.curseForgeProjectId || mod.curseModId);
          entryRecord.fileId = mod.curseForgeFileId || mod.curseFileId ? String(mod.curseForgeFileId || mod.curseFileId) : '';
        }
        mods.push(entryRecord);
      }

      instances.push({
        externalId: entry.name,
        name: String(launcher.name || entry.name),
        path: instanceDir,
        gameDir: instanceDir,
        mcVersion,
        loader,
        loaderVersion,
        pack,
        mods,
        modCount: countJars(path.join(instanceDir, 'mods')),
        worldCount: countWorlds(path.join(instanceDir, 'saves')),
        playMinutes: 0,
        iconPath: fs.existsSync(path.join(instanceDir, 'instance.png')) ? path.join(instanceDir, 'instance.png') : null,
      });
    }
    return instances;
  }

  function scanRoot(def, root) {
    switch (def.kind) {
      case 'multimc': return scanMultimc(root);
      case 'modrinth': return scanModrinth(root);
      case 'curseforge': return scanCurseForge(root);
      case 'atlauncher': return scanAtLauncher(root);
      default: return [];
    }
  }

  // Fast count for the picker: does this root look like this launcher at all?
  function quickCount(def, root) {
    try {
      if (!fs.existsSync(root)) return 0;
      if (def.kind === 'multimc') {
        let total = 0;
        for (const instancesRoot of multimcRoots(root)) {
          let entries = [];
          try { entries = fs.readdirSync(instancesRoot, { withFileTypes: true }); } catch { continue; }
          total += entries.filter(entry => entry.isDirectory() && entry.name !== '.tmp'
            && fs.existsSync(path.join(instancesRoot, entry.name, 'instance.cfg'))).length;
        }
        return total;
      }
      if (def.kind === 'modrinth') return countEntries(path.join(root, 'profiles'));
      if (def.kind === 'curseforge') {
        const instancesDir = curseforgeInstancesDir(root);
        let entries = [];
        try { entries = fs.readdirSync(instancesDir, { withFileTypes: true }); } catch { return 0; }
        return entries.filter(entry => entry.isDirectory()
          && fs.existsSync(path.join(instancesDir, entry.name, 'minecraftinstance.json'))).length;
      }
      if (def.kind === 'atlauncher') {
        const base = fs.existsSync(path.join(root, 'instances')) ? path.join(root, 'instances') : path.join(root, 'Instances');
        let entries = [];
        try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return 0; }
        return entries.filter(entry => entry.isDirectory()
          && fs.existsSync(path.join(base, entry.name, 'instance.json'))).length;
      }
    } catch {}
    return 0;
  }

  function detect() {
    return definitions.map(def => {
      const roots = def.roots.map(root => ({
        path: root,
        exists: fs.existsSync(root),
        instanceCount: quickCount(def, root),
      }));
      const best = roots.reduce((winner, candidate) => (
        candidate.instanceCount > (winner?.instanceCount || 0) ? candidate : winner
      ), roots.find(candidate => candidate.exists) || roots[0]);
      return {
        id: def.id,
        name: def.name,
        hint: def.hint,
        openSource: def.openSource,
        roots,
        found: roots.some(root => root.exists),
        instanceCount: best ? best.instanceCount : 0,
        root: best ? best.path : def.roots[0],
      };
    });
  }

  function scan(launcherId, rootOverride) {
    const def = definitionFor(launcherId);
    const candidates = rootOverride ? [rootOverride] : def.roots;
    const results = [];
    const seen = new Set();
    for (const root of candidates) {
      let instances = [];
      try { instances = scanRoot(def, root); } catch (error) {
        log.warn?.(`[CraftDock] could not scan ${def.name} at ${root}: ${error.message}`);
        continue;
      }
      for (const instance of instances) {
        const key = `${instance.path}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ ...instance, launcherId: def.id, launcherName: def.name, root });
      }
    }
    return {
      launcher: { id: def.id, name: def.name, hint: def.hint },
      root: rootOverride || def.roots.find(root => fs.existsSync(root)) || def.roots[0],
      instances: results,
    };
  }

  // ── Modrinth lookup: hashes → project/version ----------------------------
  async function fetchJson(url, init) {
    if (typeof fetchImpl !== 'function') throw new Error('No network available');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, ...(init?.headers || {}) },
      });
      if (!response.ok) throw new Error(`${url.replace(MODRINTH_API, 'Modrinth')} → ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function lookupModrinthVersions(hashes) {
    const byHash = new Map();
    for (let index = 0; index < hashes.length; index += 50) {
      const chunk = hashes.slice(index, index + 50);
      try {
        const data = await fetchJson(`${MODRINTH_API}/version_files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hashes: chunk, algorithm: 'sha1' }),
        });
        for (const [hash, version] of Object.entries(data || {})) byHash.set(hash, version);
      } catch (error) {
        log.warn?.(`[CraftDock] Modrinth hash lookup failed: ${error.message}`);
      }
    }
    return byHash;
  }

  async function lookupModrinthProjects(ids) {
    const projects = new Map();
    for (let index = 0; index < ids.length; index += 40) {
      const chunk = ids.slice(index, index + 40);
      try {
        const params = new URLSearchParams({ ids: JSON.stringify(chunk) });
        const data = await fetchJson(`${MODRINTH_API}/projects?${params}`);
        for (const project of data || []) projects.set(project.id, project);
      } catch (error) {
        log.warn?.(`[CraftDock] Modrinth project lookup failed: ${error.message}`);
      }
    }
    return projects;
  }

  async function resolveVersionNumber(versionId) {
    if (!versionId) return '';
    try {
      const version = await fetchJson(`${MODRINTH_API}/version/${versionId}`);
      return version && version.version_number ? String(version.version_number) : '';
    } catch { return ''; }
  }

  function primaryFile(version) {
    if (!version || !Array.isArray(version.files) || !version.files.length) return null;
    return version.files.find(file => file.primary) || version.files[0];
  }

  // Every jar gets hashed, which is how a jar with no launcher metadata still
  // gets a known origin: Modrinth answers with the project and version it
  // serves for that exact file.
  async function identifyMods(gameDir, hints, onProgress) {
    const modsDir = path.join(gameDir, 'mods');
    let files = [];
    try { files = fs.readdirSync(modsDir).filter(name => /\.jar(\.disabled)?$/i.test(name)); } catch { files = []; }
    const hintByFile = new Map();
    for (const hint of hints || []) {
      const key = String(hint.fileName || '').toLowerCase().replace(/\.disabled$/i, '');
      if (key && !hintByFile.has(key)) hintByFile.set(key, hint);
    }

    const hashed = [];
    for (const fileName of files) {
      const diskName = fileName.replace(/\.disabled$/i, '');
      const hint = hintByFile.get(diskName.toLowerCase()) || hintByFile.get(fileName.toLowerCase()) || null;
      let hash = '';
      try { hash = await sha1File(path.join(modsDir, fileName)); } catch {}
      hashed.push({ fileName, diskName, hint, hash });
      onProgress?.(Math.round((hashed.length / Math.max(files.length, 1)) * 40), 'Hashing mods…');
    }

    const byHash = hashed.some(entry => entry.hash)
      ? await lookupModrinthVersions(hashed.map(entry => entry.hash).filter(Boolean))
      : new Map();
    const projectIds = [...new Set([...byHash.values()].map(version => version && version.project_id).filter(Boolean))];
    const projects = await lookupModrinthProjects(projectIds);

    const mods = [];
    let mapped = 0;
    let local = 0;
    for (let index = 0; index < hashed.length; index++) {
      const entry = hashed[index];
      const version = entry.hash ? byHash.get(entry.hash) : null;
      const project = version ? projects.get(version.project_id) : null;
      const file = primaryFile(version);
      const hint = entry.hint || {};

      if (version && version.project_id) {
        mapped += 1;
        mods.push({
          id: String(version.project_id),
          name: project?.title || hint.name || entry.diskName.replace(/\.jar$/i, ''),
          author: '',
          iconUrl: project?.icon_url || null,
          source: 'modrinth',
          slug: project?.slug || null,
          fileName: entry.fileName,
          downloadUrl: file?.url || null,
          versionId: version.id || null,
          versionName: version.version_number || null,
        });
      } else if (hint.source === 'modrinth' && hint.projectId) {
        mapped += 1;
        mods.push({
          id: String(hint.projectId),
          name: hint.name || entry.diskName.replace(/\.jar$/i, ''),
          author: '',
          iconUrl: null,
          source: 'modrinth',
          slug: null,
          fileName: entry.fileName,
          downloadUrl: null,
          versionId: hint.versionId || null,
          versionName: hint.versionName || null,
        });
      } else if (hint.source === 'curseforge' && hint.projectId) {
        mapped += 1;
        mods.push({
          id: String(hint.projectId),
          name: hint.name || entry.diskName.replace(/\.jar$/i, ''),
          author: '',
          iconUrl: null,
          source: 'curseforge',
          slug: null,
          fileName: entry.fileName,
          downloadUrl: null,
          versionId: hint.fileId || null,
          versionName: null,
        });
      } else {
        local += 1;
        mods.push({
          id: `file:${entry.diskName}`,
          name: hint.name || entry.diskName.replace(/\.jar(\.disabled)?$/i, ''),
          author: '',
          iconUrl: null,
          source: 'local',
          slug: null,
          fileName: entry.fileName,
          downloadUrl: null,
          versionId: null,
          versionName: null,
        });
      }
      onProgress?.(40 + Math.round(((index + 1) / Math.max(hashed.length, 1)) * 60), 'Matching mods to their projects…');
    }

    // Derive game version / loader when the launcher did not record them: the
    // matched versions carry both lists.
    const versionTally = new Map();
    const loaderTally = new Map();
    for (const version of byHash.values()) {
      for (const gameVersion of version.game_versions || []) {
        versionTally.set(gameVersion, (versionTally.get(gameVersion) || 0) + 1);
      }
      for (const loader of version.loaders || []) {
        if (['fabric', 'quilt', 'forge', 'neoforge'].includes(loader)) {
          loaderTally.set(loader, (loaderTally.get(loader) || 0) + 1);
        }
      }
    }
    // CurseForge hints carry the project id but no logo, and nothing else knows
    // what it looks like. Ask once for the ids that are still missing one.
    const missingLogos = [...new Set(mods.filter(mod => mod.source === 'curseforge' && !mod.iconUrl && /^\d+$/.test(mod.id)).map(mod => mod.id))];
    if (missingLogos.length && typeof curseForgeIcons === 'function') {
      try {
        const icons = await curseForgeIcons(missingLogos);
        if (icons && typeof icons.get === 'function') {
          for (const mod of mods) {
            if (mod.source !== 'curseforge' || mod.iconUrl) continue;
            const iconUrl = icons.get(String(mod.id));
            if (iconUrl) mod.iconUrl = iconUrl;
          }
        }
      } catch (error) {
        log.warn?.(`[CraftDock] CurseForge logo lookup failed: ${error.message}`);
      }
    }

    const mostCommon = tally => [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    return {
      mods,
      mapped,
      local,
      inferredMcVersion: mostCommon(versionTally),
      inferredLoader: mostCommon(loaderTally),
    };
  }

  // ── Copying ──────────────────────────────────────────────────────────────
  function walkCount(dir, skipTopLevel, depth = 0) {
    let files = 0;
    let bytes = 0;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { files, bytes }; }
    for (const entry of entries) {
      if (depth === 0 && skipTopLevel.has(entry.name.toLowerCase())) continue;
      if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const nested = walkCount(full, skipTopLevel, depth + 1);
        files += nested.files;
        bytes += nested.bytes;
      } else if (entry.isFile()) {
        files += 1;
        bytes += statSafe(full)?.size || 0;
      }
    }
    return { files, bytes };
  }

  function copyTree(src, dest, onFile, depth = 0) {
    if (depth > 12) return 0;
    let copied = 0;
    let entries;
    try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return 0; }
    try { fs.mkdirSync(dest, { recursive: true }); } catch { return 0; }
    for (const entry of entries) {
      if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
      if (entry.isSymbolicLink()) continue;
      const from = path.join(src, entry.name);
      const to = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copied += copyTree(from, to, onFile, depth + 1);
      } else if (entry.isFile()) {
        try {
          fs.copyFileSync(from, to);
          copied += 1;
          onFile?.(copied);
        } catch {}
      }
    }
    return copied;
  }

  function copyGameFiles(gameDir, instanceDir, onFile) {
    let copied = 0;
    let entries;
    try { entries = fs.readdirSync(gameDir, { withFileTypes: true }); } catch { return 0; }
    for (const entry of entries) {
      if (SKIP_TOP_LEVEL.has(entry.name.toLowerCase())) continue;
      if (entry.isSymbolicLink()) continue;
      const from = path.join(gameDir, entry.name);
      const to = path.join(instanceDir, entry.name);
      if (entry.isDirectory()) {
        copied += copyTree(from, to, onFile);
      } else if (entry.isFile()) {
        try { fs.copyFileSync(from, to); copied += 1; onFile?.(copied); } catch {}
      }
    }
    return copied;
  }

  // ── Import ───────────────────────────────────────────────────────────────
  async function importInstance(request = {}, onProgress = () => {}) {
    const { launcherId, externalId, root: rootOverride, name: requestedName } = request;
    const { instances, root } = scan(launcherId, rootOverride);
    const instance = instances.find(candidate => candidate.externalId === externalId);
    if (!instance) throw new Error('That instance is no longer in the other launcher');
    if (!fs.existsSync(instance.gameDir)) throw new Error(`Game folder not found: ${instance.gameDir}`);

    const name = String(requestedName || instance.name || externalId).slice(0, 80);
    const report = (pct, message, extra = {}) => onProgress({ instance: externalId, pct, message, ...extra });

    report(2, 'Reading the other launcher…');
    const plan = walkCount(instance.gameDir, SKIP_TOP_LEVEL);
    report(5, `${plan.files} files to copy`);

    // Everything is copied into an instance folder this import creates, so a
    // failure half way through never leaves a broken folder registered.
    const id = `inst_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    if (typeof registerSlug === 'function') registerSlug(id, name, instancesBase);
    const instanceDir = typeof instDir === 'function' ? instDir(id) : path.join(instancesBase, name);
    try {
      fs.mkdirSync(instanceDir, { recursive: true });
    } catch (error) {
      throw new Error(`Could not create the instance folder: ${error.message}`);
    }
    if (typeof ensureInstance === 'function') ensureInstance(id);

    let lastReport = 0;
    const onFile = copied => {
      const now = Date.now();
      if (now - lastReport < 120 && copied < plan.files) return;
      lastReport = now;
      report(5 + Math.round((copied / Math.max(plan.files, 1)) * 60), `Copying files… ${copied}/${plan.files}`);
    };

    let copiedFiles = 0;
    try {
      copiedFiles = copyGameFiles(instance.gameDir, instanceDir, onFile);
      report(68, 'Copying files… done');

      // Old launchers keep their own icon next to the instance; CraftDock's hero
      // reads a data URL, so it travels as one and is saved by the renderer.
      const iconDataUrl = instance.iconPath ? readIconDataUrl(instance.iconPath) : null;

      report(70, 'Working out where each mod came from…');
      let identified;
      try {
        identified = await identifyMods(instance.gameDir, instance.mods, (pct, message) => {
          report(70 + Math.round(pct * 0.24), message);
        });
      } catch (error) {
        identified = { mods: [], mapped: 0, local: 0, inferredMcVersion: '', inferredLoader: '' };
        log.warn?.(`[CraftDock] mod identification failed: ${error.message}`);
      }

      const pack = instance.pack ? { ...instance.pack } : null;
      let sourceVersionName = pack?.versionName || '';
      if (pack && pack.type === 'modrinth' && !sourceVersionName && pack.versionId) {
        sourceVersionName = await resolveVersionNumber(pack.versionId);
      }

      const mcVersion = instance.mcVersion || identified.inferredMcVersion || '';
      const loader = instance.loader || identified.inferredLoader || '';
      const source = pack
        ? (pack.type === 'modrinth' && pack.id ? 'modrinth' : pack.type === 'curseforge' && pack.id ? 'curseforge' : 'imported')
        : 'imported';

      const meta = {
        id,
        name,
        mcVersion,
        loader,
        loaderVersion: instance.loaderVersion || '',
        source,
        sourceId: pack?.id || undefined,
        sourceVersionId: pack?.versionId || undefined,
        sourceVersionName: sourceVersionName || undefined,
        packName: pack?.name || undefined,
        installedAt: Date.now(),
        addedAt: Date.now(),
        downloadStatus: 'imported',
        mods: identified.mods,
        totalPlayMinutes: instance.playMinutes || 0,
        importedFrom: {
          launcher: launcherId,
          launcherName: instance.launcherName || launcherId,
          path: instance.gameDir,
          at: Date.now(),
        },
      };

      writeInstMeta(id, meta);
      report(100, `Imported ${copiedFiles} files`, { id });

      return {
        success: true,
        id,
        name,
        mcVersion,
        loader,
        loaderVersion: meta.loaderVersion,
        iconDataUrl,
        copiedFiles,
        copiedBytes: plan.bytes,
        pack: pack ? {
          type: pack.type,
          id: pack.id || null,
          versionName: sourceVersionName || pack.versionName || null,
          name: pack.name || null,
          tracked: Boolean(pack.id),
        } : null,
        mods: { total: identified.mods.length, mapped: identified.mapped, local: identified.local },
        warnings: [
          !mcVersion ? 'Minecraft version could not be detected — set it before launching.' : null,
          pack && !pack.id ? 'Pack identity was not recorded by the old launcher, so pack updates cannot be checked.' : null,
        ].filter(Boolean),
      };
    } catch (error) {
      try { fs.rmSync(instanceDir, { recursive: true, force: true }); } catch {}
      throw error;
    }
  }

  return { detect, scan, importInstance, definitions };
}

module.exports = {
  createLauncherImporter,
  launcherDefinitions,
  // exported for tests
  parseMmcPack,
  readIni,
  normalizeLoaderVersion,
};
