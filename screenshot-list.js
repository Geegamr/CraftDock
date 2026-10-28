const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function listScreenshotsFallback(directory) {
  const absoluteDirectory = path.resolve(directory);
  try {
    return fs.readdirSync(absoluteDirectory)
      .filter(name => /\.(png|jpg|jpeg)$/i.test(name))
      .map(name => {
        const filePath = path.join(absoluteDirectory, name);
        const stat = fs.statSync(filePath);
        return { name, path: filePath, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

function createScreenshotListReader({ isPackaged, appDir, resourcesPath, platform, logger = console, runFile = execFile }) {
  const rustBinary = () => {
    const name = platform === 'win32' ? 'craftdock-screenshot-list.exe' : 'craftdock-screenshot-list';
    const candidates = isPackaged
      ? [path.join(resourcesPath, 'native', name)]
      : ['release', 'debug'].map(config => path.join(appDir, 'rust', 'target', config, name));
    return candidates.find(candidate => fs.existsSync(candidate));
  };

  return async function readScreenshotList(directory) {
    if (!fs.existsSync(directory)) return [];
    const binary = rustBinary();
    if (!binary) return listScreenshotsFallback(directory);

    try {
      const stdout = await new Promise((resolve, reject) => {
        runFile(binary, [directory], {
          windowsHide: true,
          timeout: 10000,
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'utf8',
        }, (error, output) => error ? reject(error) : resolve(output));
      });
      const files = JSON.parse(stdout);
      if (!Array.isArray(files) || files.some(file =>
        !file || typeof file.name !== 'string' || typeof file.path !== 'string' ||
        typeof file.size !== 'number' || typeof file.mtime !== 'number'
      )) throw new Error('Rust screenshot lister returned an invalid file list');
      return files;
    } catch (error) {
      logger.warn('[CraftDock] Rust screenshot lister failed; using JavaScript fallback:', error.message);
      return listScreenshotsFallback(directory);
    }
  };
}

module.exports = { createScreenshotListReader, listScreenshotsFallback };
