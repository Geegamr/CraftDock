const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function listJarFilesFallback(directory) {
  const files = fs.readdirSync(directory)
    .filter(name => name.endsWith('.jar') || name.endsWith('.jar.disabled'))
    .map(filename => {
      const filePath = path.join(directory, filename);
      const stat = fs.statSync(filePath);
      const disabled = filename.endsWith('.jar.disabled');
      return {
        name: disabled ? filename.slice(0, -'.disabled'.length) : filename,
        size: stat.size,
        mtime: stat.mtimeMs,
        enabled: !disabled,
      };
    });
  return files;
}

function createServerJarListReader({ isPackaged, appDir, resourcesPath, platform, logger = console, runFile = execFile }) {
  const rustBinary = () => {
    const name = platform === 'win32' ? 'craftdock-server-jar-list.exe' : 'craftdock-server-jar-list';
    const candidates = isPackaged
      ? [path.join(resourcesPath, 'native', name)]
      : ['release', 'debug'].map(config => path.join(appDir, 'rust', 'target', config, name));
    return candidates.find(candidate => fs.existsSync(candidate));
  };

  return async function readServerJarList(directory) {
    if (!fs.existsSync(directory)) return [];
    const binary = rustBinary();
    if (!binary) return listJarFilesFallback(directory);

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
        !file || typeof file.name !== 'string' || typeof file.size !== 'number' ||
        typeof file.mtime !== 'number' || typeof file.enabled !== 'boolean'
      )) throw new Error('Rust JAR lister returned an invalid file list');
      return files;
    } catch (error) {
      logger.warn('[CraftDock] Rust JAR lister failed; using JavaScript fallback:', error.message);
      return listJarFilesFallback(directory);
    }
  };
}

module.exports = { createServerJarListReader, listJarFilesFallback };
