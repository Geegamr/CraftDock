const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_NATIVE_OUTPUT = 1024 * 1024;

function isValidModFilename(filename) {
  if (typeof filename !== 'string' || /[\\/:\0]/.test(filename)) return false;
  const stem = filename.endsWith('.jar.disabled')
    ? filename.slice(0, -'.jar.disabled'.length)
    : filename.endsWith('.jar')
      ? filename.slice(0, -'.jar'.length)
      : '';
  return stem.length > 0 && stem !== '.' && stem !== '..' && path.basename(filename) === filename;
}

function toggleInstanceModFallback(modsDirectory, filename, enable) {
  if (!isValidModFilename(filename)) return { success: false, error: 'Invalid mod filename' };
  const from = path.join(modsDirectory, filename);
  const targetName = enable
    ? filename.replace(/\.disabled$/, '')
    : filename.endsWith('.disabled') ? filename : `${filename}.disabled`;
  const to = path.join(modsDirectory, targetName);
  try {
    if (from !== to) fs.renameSync(from, to);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function createInstanceModAccess({ isPackaged, appDir, resourcesPath, platform, runNative = runRustBinary }) {
  const rustBinary = () => {
    const name = platform === 'win32' ? 'craftdock-instance-mod-toggle.exe' : 'craftdock-instance-mod-toggle';
    const candidates = isPackaged
      ? [path.join(resourcesPath, 'native', name)]
      : ['release', 'debug'].map(config => path.join(appDir, 'rust', 'target', config, name));
    return candidates.find(candidate => fs.existsSync(candidate));
  };

  return {
    async toggle(modsDirectory, filename, enable) {
      if (!isValidModFilename(filename)) return { success: false, error: 'Invalid mod filename' };
      const binary = rustBinary();
      if (!binary) return toggleInstanceModFallback(modsDirectory, filename, enable);
      try {
        await runNative(binary, [enable ? 'enable' : 'disable', modsDirectory, filename]);
        return { success: true };
      } catch (error) {
        if (error.failedToStart) return toggleInstanceModFallback(modsDirectory, filename, enable);
        return { success: false, error: error.message };
      }
    },
  };
}

function runRustBinary(binary, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      error.failedToStart = true;
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (error, failedToStart = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (failedToStart) error.failedToStart = true;
      reject(error);
    };
    const timeout = setTimeout(() => {
      child.kill();
      fail(new Error('Rust instance mod toggle process timed out'));
    }, 10000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > MAX_NATIVE_OUTPUT) {
        child.kill();
        fail(new Error('Rust instance mod toggle output exceeded limit'));
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > MAX_NATIVE_OUTPUT) {
        child.kill();
        fail(new Error('Rust instance mod toggle error output exceeded limit'));
      }
    });
    child.on('error', error => fail(error, true));
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `Rust instance mod toggle process exited with ${code}`));
    });
  });
}

module.exports = { createInstanceModAccess, isValidModFilename, toggleInstanceModFallback };
