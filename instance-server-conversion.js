// Convert a client instance folder into a server folder without copying worlds,
// screenshots, resource packs, shaders, or client-only mods.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const CONFIG_DIRS = ['config', 'defaultconfigs', 'kubejs', 'scripts'];

function fileKey(name) {
  return path.basename(String(name || '')).toLowerCase();
}

async function copyRegularTree(src, dest, state) {
  let stat;
  try { stat = await fsp.lstat(src); } catch { return false; }
  if (stat.isSymbolicLink()) return false;
  if (stat.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      await copyRegularTree(path.join(src, entry.name), path.join(dest, entry.name), state);
    }
    return true;
  }
  if (!stat.isFile()) return false;
  await fsp.copyFile(src, dest);
  state.files += 1;
  state.bytes += stat.size;
  return true;
}

// The target must be a fresh folder. On failure the whole folder is removed so
// a half-copied server can never be registered by the renderer.
async function convertInstanceToServer(options = {}) {
  const instanceDir = String(options.instanceDir || '');
  const serverDir = String(options.serverDir || '');
  if (!instanceDir || !serverDir) throw new Error('Instance and server folders are required');

  const skip = new Set([...(options.clientOnlyFiles || [])].map(fileKey).filter(Boolean));
  const inspectJar = typeof options.inspectJar === 'function' ? options.inspectJar : null;
  const configDirs = Array.isArray(options.configDirs) ? options.configDirs : CONFIG_DIRS;

  await fsp.mkdir(serverDir);
  const state = { files: 0, bytes: 0 };
  const copiedMods = [];
  const skippedClientMods = [];
  const skippedDisabledMods = [];

  try {
    const serverMods = path.join(serverDir, 'mods');
    await fsp.mkdir(serverMods, { recursive: true });

    const instanceMods = path.join(instanceDir, 'mods');
    let entries = [];
    try { entries = await fsp.readdir(instanceMods, { withFileTypes: true }); } catch {}
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (name.toLowerCase().endsWith('.jar.disabled')) {
        skippedDisabledMods.push(name);
        continue;
      }
      if (!name.toLowerCase().endsWith('.jar')) continue;

      const source = path.join(instanceMods, name);
      if (skip.has(fileKey(name))) {
        skippedClientMods.push(name);
        continue;
      }
      if (inspectJar) {
        let clientOnly = false;
        try { clientOnly = Boolean(await inspectJar(source, name)); } catch {}
        if (clientOnly) {
          skippedClientMods.push(name);
          continue;
        }
      }
      const stat = await fsp.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      await fsp.copyFile(source, path.join(serverMods, name));
      state.files += 1;
      state.bytes += stat.size;
      copiedMods.push(name);
    }

    const copiedConfigDirs = [];
    for (const dirName of configDirs) {
      const source = path.join(instanceDir, dirName);
      let stat;
      try { stat = await fsp.lstat(source); } catch { continue; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const copied = await copyRegularTree(source, path.join(serverDir, dirName), state);
      if (copied) copiedConfigDirs.push(dirName);
    }

    return {
      copiedMods,
      skippedClientMods,
      skippedDisabledMods,
      copiedConfigDirs,
      files: state.files,
      bytes: state.bytes,
    };
  } catch (error) {
    await fsp.rm(serverDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

// Fabric and Quilt declare their side in the mod JSON. Forge-family JARs only
// get filtered when they opt into the explicit clientSideOnly flag. Unknown
// layouts are treated as server-compatible rather than silently dropped.
function detectClientOnlyJar(jarPath, readZipEntries) {
  if (typeof readZipEntries !== 'function') return false;
  let entries;
  try { entries = readZipEntries(jarPath); } catch { return false; }

  const readJson = name => {
    const entry = entries.get(name);
    if (!entry) return null;
    try { return JSON.parse(entry.toString('utf8')); } catch { return null; }
  };

  const fabric = readJson('fabric.mod.json');
  if (fabric && String(fabric.environment || '').toLowerCase() === 'client') return true;

  const quilt = readJson('quilt.mod.json');
  if (quilt) {
    const environment = quilt.environment || quilt.quilt_loader?.metadata?.environment;
    if (String(environment || '').toLowerCase() === 'client') return true;
  }

  for (const name of ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
    const entry = entries.get(name);
    if (!entry) continue;
    if (/(?:^|\n)\s*clientSideOnly\s*=\s*true\b/i.test(entry.toString('utf8'))) return true;
  }
  return false;
}

module.exports = {
  CONFIG_DIRS,
  convertInstanceToServer,
  detectClientOnlyJar,
};
