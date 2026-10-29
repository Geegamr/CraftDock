const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_NATIVE_OUTPUT = 64 * 1024 * 1024;
const NATIVE_UNAVAILABLE = Symbol('native unavailable');

function metadataPath(skinsDirectory) {
  const filePath = path.join(skinsDirectory, 'skins.json');
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error('Skin metadata path cannot be a symbolic link');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return filePath;
}

function skinImagePath(skinsDirectory, id) {
  const filename = id + '.png';
  if (/[\\/:\0]/.test(filename)) throw new Error('Invalid skin id');
  const imagePath = path.join(skinsDirectory, filename);
  try {
    if (fs.lstatSync(imagePath).isSymbolicLink()) throw new Error('Skin image path cannot be a symbolic link');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return imagePath;
}

function isInsideSkinsDirectory(skinsDirectory, filePath) {
  try {
    const root = fs.realpathSync(skinsDirectory);
    const resolved = fs.realpathSync(filePath);
    const relative = path.relative(root, resolved);
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function getAllFallback(skinsDirectory) {
  const metaFile = metadataPath(skinsDirectory);
  if (!fs.existsSync(metaFile)) return [];
  const skins = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  return skins.map(skin => {
    // Stored paths are legacy metadata, but never hydrate bytes from outside this library.
    if (skin.filePath && fs.existsSync(skin.filePath) && isInsideSkinsDirectory(skinsDirectory, skin.filePath)) {
      skin.dataUrl = 'data:image/png;base64,' + fs.readFileSync(skin.filePath).toString('base64');
    }
    return skin;
  });
}

function saveFallback(skinsDirectory, skin) {
  const metaFile = metadataPath(skinsDirectory);
  const skins = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : [];
  if (skin.dataUrl?.startsWith('data:image')) {
    const imagePath = skinImagePath(skinsDirectory, skin.id);
    fs.writeFileSync(imagePath, Buffer.from(skin.dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
    skin.filePath = imagePath;
    delete skin.dataUrl;
  }
  const index = skins.findIndex(existing => existing.id === skin.id);
  if (index >= 0) skins[index] = skin;
  else skins.push(skin);
  fs.writeFileSync(metaFile, JSON.stringify(skins, null, 2));
  return { success: true };
}

function removeFallback(skinsDirectory, id) {
  const metaFile = metadataPath(skinsDirectory);
  if (!fs.existsSync(metaFile)) return undefined;
  const imagePath = skinImagePath(skinsDirectory, id);
  const skins = JSON.parse(fs.readFileSync(metaFile, 'utf8')).filter(skin => skin.id !== id);
  fs.writeFileSync(metaFile, JSON.stringify(skins, null, 2));
  if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
  return { success: true };
}

function createSkinLibraryAccess({ isPackaged, appDir, resourcesPath, platform, runNative = runRustBinary }) {
  const rustBinary = () => {
    const name = platform === 'win32' ? 'craftdock-skin-library.exe' : 'craftdock-skin-library';
    const candidates = isPackaged
      ? [path.join(resourcesPath, 'native', name)]
      : ['release', 'debug'].map(config => path.join(appDir, 'rust', 'target', config, name));
    return candidates.find(candidate => fs.existsSync(candidate));
  };

  async function invoke(skinsDirectory, command, input = '', args = []) {
    const binary = rustBinary();
    if (!binary) return NATIVE_UNAVAILABLE;
    try {
      return JSON.parse(await runNative(binary, [command, skinsDirectory, ...args], input));
    } catch (error) {
      if (error.failedToStart || error.nativeOutputExceeded || error.nativeTimedOut) return NATIVE_UNAVAILABLE;
      throw error;
    }
  }

  return {
    async getAll(skinsDirectory) {
      const result = await invoke(skinsDirectory, 'get');
      return result === NATIVE_UNAVAILABLE ? getAllFallback(skinsDirectory) : result;
    },

    async save(skinsDirectory, skin) {
      const result = await invoke(skinsDirectory, 'save', JSON.stringify(skin));
      return result === NATIVE_UNAVAILABLE ? saveFallback(skinsDirectory, skin) : result;
    },

    async remove(skinsDirectory, id) {
      const result = await invoke(skinsDirectory, 'delete', JSON.stringify({ id }));
      return result === NATIVE_UNAVAILABLE ? removeFallback(skinsDirectory, id) : result ?? undefined;
    },
  };
}

function runRustBinary(binary, args, input = '') {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      error.failedToStart = true;
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminationError;
    const fail = (error, failedToStart = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (failedToStart) error.failedToStart = true;
      reject(error);
    };
    const terminate = error => {
      if (settled || terminationError) return;
      terminationError = error;
      clearTimeout(timeout);
      child.kill();
    };
    const timeout = setTimeout(() => {
      terminate(Object.assign(new Error('Rust skin library process timed out'), { nativeTimedOut: true }));
    }, 10000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (terminationError) return;
      stdout += chunk;
      if (stdout.length > MAX_NATIVE_OUTPUT) {
        terminate(Object.assign(new Error('Rust skin library output exceeded limit'), { nativeOutputExceeded: true }));
      }
    });
    child.stderr.on('data', chunk => {
      if (terminationError) return;
      stderr += chunk;
      if (stderr.length > MAX_NATIVE_OUTPUT) {
        terminate(Object.assign(new Error('Rust skin library error output exceeded limit'), { nativeOutputExceeded: true }));
      }
    });
    child.on('error', error => fail(error, true));
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (terminationError) reject(terminationError);
      else if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `Rust skin library process exited with ${code}`));
    });
    child.stdin.end(input);
  });
}

module.exports = {
  createSkinLibraryAccess,
  getAllFallback,
  removeFallback,
  runRustBinary,
  saveFallback,
};
