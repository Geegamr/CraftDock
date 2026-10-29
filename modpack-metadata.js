const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_OUTPUT = 4 * 1024 * 1024;

function parseModpackMetadataFallback(filePath, type, zipEntries) {
  let packName = path.basename(filePath, path.extname(filePath));
  let mcVersion = '1.21.4';
  let loader = '';
  let loaderVersion = '';
  let mods = [];

  if (type === 'mr') {
    const indexEntry = zipEntries.get('modrinth.index.json');
    if (!indexEntry) throw new Error('Invalid .mrpack: missing modrinth.index.json');
    const index = JSON.parse(indexEntry.toString('utf8'));
    packName = index.name || packName;
    mcVersion = index.dependencies?.minecraft || mcVersion;
    const loaderKey = Object.keys(index.dependencies || {}).find(key => key !== 'minecraft');
    if (loaderKey) {
      loader = loaderKey;
      loaderVersion = index.dependencies[loaderKey];
    }
    mods = (index.files || [])
      .map(file => ({ url: file.downloads?.[0], path: file.path, sha512: file.hashes?.sha512 }))
      .filter(mod => mod.url);
  } else {
    const manifestEntry = zipEntries.get('manifest.json');
    if (!manifestEntry) throw new Error('Invalid CurseForge zip: missing manifest.json');
    const manifest = JSON.parse(manifestEntry.toString('utf8'));
    packName = manifest.name || packName;
    mcVersion = manifest.minecraft?.version || mcVersion;
    const loaderInfo = manifest.minecraft?.modLoaders?.find(item => item.primary);
    if (loaderInfo) {
      const id = loaderInfo.id || '';
      if (id.startsWith('forge-')) { loader = 'forge'; loaderVersion = id.replace('forge-', ''); }
      else if (id.startsWith('fabric-')) { loader = 'fabric'; loaderVersion = id.replace('fabric-', ''); }
      else if (id.startsWith('neoforge-')) { loader = 'neoforge'; loaderVersion = id.replace('neoforge-', ''); }
      else if (id.startsWith('quilt-')) { loader = 'quilt'; loaderVersion = id.replace('quilt-', ''); }
    }
    mods = (manifest.files || []).map(file => ({
      projectId: file.projectID,
      fileId: file.fileID,
      required: file.required !== false,
    }));
  }

  return { packName, mcVersion, loader, loaderVersion, mods };
}

function runRustBinary(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => {
      child.kill();
      fail(new Error('Rust modpack metadata process timed out'));
    }, 10000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT) {
        child.kill();
        fail(new Error('Rust modpack metadata output exceeded limit'));
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > MAX_OUTPUT) {
        child.kill();
        fail(new Error('Rust modpack metadata error output exceeded limit'));
      }
    });
    child.on('error', fail);
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Rust modpack metadata process exited with ${code}`));
    });
  });
}

function createModpackMetadataReader({ isPackaged, appDir, resourcesPath, platform, runNative = runRustBinary }) {
  const binaryName = platform === 'win32' ? 'craftdock-modpack-metadata.exe' : 'craftdock-modpack-metadata';
  const candidates = isPackaged
    ? [path.join(resourcesPath, 'native', binaryName)]
    : ['release', 'debug'].map(config => path.join(appDir, 'rust', 'target', config, binaryName));

  return async function readModpackMetadata(filePath, type, zipEntries) {
    const binary = candidates.find(candidate => fs.existsSync(candidate));
    if (binary) {
      try {
        const result = JSON.parse(await runNative(binary, ['inspect', filePath, type]));
        if (!result || typeof result !== 'object' || typeof result.packName === 'undefined' ||
            typeof result.mcVersion === 'undefined' || typeof result.loader !== 'string' ||
            typeof result.loaderVersion === 'undefined' || !Array.isArray(result.mods)) {
          throw new Error('Rust modpack metadata returned an invalid result');
        }
        return result;
      } catch {}
    }
    return parseModpackMetadataFallback(filePath, type, zipEntries);
  };
}

module.exports = { createModpackMetadataReader, parseModpackMetadataFallback, runRustBinary };
