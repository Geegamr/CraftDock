const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function readServerJsonFallback(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

function createServerJsonAccess({ isPackaged, appDir, resourcesPath, platform, runNative = runRustBinary }) {
  const rustBinary = () => {
    const name = platform === 'win32' ? 'craftdock-server-json.exe' : 'craftdock-server-json';
    const candidates = isPackaged
      ? [path.join(resourcesPath, 'native', name)]
      : ['release', 'debug'].map(config => path.join(appDir, 'rust', 'target', config, name));
    return candidates.find(candidate => fs.existsSync(candidate));
  };

  return {
    async read(filePath) {
      const binary = rustBinary();
      if (!binary) return readServerJsonFallback(filePath);
      try {
        return JSON.parse(await runNative(binary, ['read', filePath]));
      } catch {
        return readServerJsonFallback(filePath);
      }
    },

    async write(filePath, value) {
      const contents = JSON.stringify(value, null, 2);
      if (typeof contents !== 'string') {
        fs.writeFileSync(filePath, contents, 'utf8');
        return { success: true };
      }
      const binary = rustBinary();
      if (binary) {
        try {
          await runNative(binary, ['write', filePath], contents);
          return { success: true };
        } catch {}
      }
      fs.writeFileSync(filePath, contents, 'utf8');
      return { success: true };
    },
  };
}

function runRustBinary(binary, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
      fail(new Error('Rust server JSON process timed out'));
    }, 10000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Rust server JSON process exited with ${code}`));
    });
    child.stdin.end(input);
  });
}

module.exports = { createServerJsonAccess, readServerJsonFallback };
