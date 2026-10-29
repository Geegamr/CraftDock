const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function listInstanceWorldsFallback(savesPath) {
  try {
    const realPath = fs.realpathSync(savesPath);
    return fs.readdirSync(realPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const worldPath = path.join(realPath, entry.name);
        let lastPlayed = null;
        try { lastPlayed = fs.statSync(path.join(worldPath, 'level.dat')).mtimeMs; } catch {}
        return { name: entry.name, path: worldPath, lastPlayed };
      })
      .sort((left, right) => (right.lastPlayed || 0) - (left.lastPlayed || 0));
  } catch {
    return [];
  }
}

function createInstanceWorldListReader({ isPackaged, appDir, resourcesPath, platform, logger = console, runFile = execFile }) {
  const rustBinary = () => {
    const name = platform === 'win32' ? 'craftdock-instance-world-list.exe' : 'craftdock-instance-world-list';
    const candidates = isPackaged
      ? [path.join(resourcesPath, 'native', name)]
      : ['release', 'debug'].map(config => path.join(appDir, 'rust', 'target', config, name));
    return candidates.find(candidate => fs.existsSync(candidate));
  };

  return async function readInstanceWorldList(savesPath) {
    const binary = rustBinary();
    if (!binary) return listInstanceWorldsFallback(savesPath);
    try {
      const stdout = await new Promise((resolve, reject) => {
        runFile(binary, [savesPath], {
          windowsHide: true,
          timeout: 10000,
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'utf8',
        }, (error, output) => error ? reject(error) : resolve(output));
      });
      const worlds = JSON.parse(stdout);
      if (!Array.isArray(worlds) || worlds.some(world =>
        !world || typeof world.name !== 'string' || typeof world.path !== 'string' ||
        !(world.lastPlayed === null || (typeof world.lastPlayed === 'number' && Number.isFinite(world.lastPlayed)))
      )) throw new Error('Rust world lister returned an invalid world list');
      return worlds;
    } catch (error) {
      logger.warn('[CraftDock] Rust world lister failed; using JavaScript fallback:', error.message);
      return listInstanceWorldsFallback(savesPath);
    }
  };
}

module.exports = { createInstanceWorldListReader, listInstanceWorldsFallback };
