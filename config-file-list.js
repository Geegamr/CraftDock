const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CONFIG_EXTENSIONS = new Set(['.toml', '.json', '.yaml', '.yml', '.cfg', '.conf', '.ini', '.properties', '.txt']);

function listConfigFilesFallback(directory) {
  const results = [];
  function walk(currentDirectory, subdir) {
    try {
      for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
        const fullPath = path.join(currentDirectory, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, subdir ? `${subdir}/${entry.name}` : entry.name);
        } else if (CONFIG_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          results.push({ name: entry.name, path: fullPath, subdir: subdir || '' });
        }
      }
    } catch {}
  }
  try {
    if (fs.existsSync(directory)) walk(directory, '');
  } catch {}
  return results.sort((left, right) => left.name.localeCompare(right.name));
}

function createConfigFileListReader({ isPackaged, appDir, resourcesPath, platform, logger = console, runFile = execFile }) {
  const rustBinary = () => {
    const name = platform === 'win32' ? 'craftdock-config-file-list.exe' : 'craftdock-config-file-list';
    const candidates = isPackaged
      ? [path.join(resourcesPath, 'native', name)]
      : ['release', 'debug'].map(config => path.join(appDir, 'rust', 'target', config, name));
    return candidates.find(candidate => fs.existsSync(candidate));
  };

  return async function readConfigFileList(directory) {
    try {
      if (!fs.existsSync(directory)) return [];
    } catch {
      return [];
    }
    const binary = rustBinary();
    if (!binary) return listConfigFilesFallback(directory);

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
        !file || typeof file.name !== 'string' || typeof file.path !== 'string' || typeof file.subdir !== 'string'
      )) throw new Error('Rust config file lister returned an invalid file list');
      return files.sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      logger.warn('[CraftDock] Rust config file lister failed; using JavaScript fallback:', error.message);
      return listConfigFilesFallback(directory);
    }
  };
}

module.exports = { createConfigFileListReader, listConfigFilesFallback };
