const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_NATIVE_OUTPUT = 4 * 1024 * 1024;

function parseServerProperties(contents) {
  const properties = {};
  contents.split('\n').forEach(line => {
    const equals = line.indexOf('=');
    if (equals > 0 && !line.startsWith('#')) {
      properties[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
    }
  });
  return properties;
}

function readServerPropertiesFallback(filePath) {
  try {
    return parseServerProperties(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function createServerPropertiesAccess({ isPackaged, appDir, resourcesPath, platform, runNative = runRustBinary }) {
  const rustBinary = () => {
    const name = platform === 'win32' ? 'craftdock-server-properties.exe' : 'craftdock-server-properties';
    const candidates = isPackaged
      ? [path.join(resourcesPath, 'native', name)]
      : ['release', 'debug'].map(config => path.join(appDir, 'rust', 'target', config, name));
    return candidates.find(candidate => fs.existsSync(candidate));
  };

  return {
    async read(filePath) {
      const binary = rustBinary();
      if (!binary) return readServerPropertiesFallback(filePath);
      try {
        const stdout = await runNative(binary, ['read', filePath]);
        const entries = JSON.parse(stdout);
        if (!Array.isArray(entries) || entries.some(entry =>
          !Array.isArray(entry) || entry.length !== 2 || entry.some(value => typeof value !== 'string')
        )) throw new Error('Invalid server.properties result');
        const properties = {};
        for (const [key, value] of entries) properties[key] = value;
        return properties;
      } catch {
        return readServerPropertiesFallback(filePath);
      }
    },

    async write(filePath, values) {
      const entries = Object.entries(values).map(([key, value]) => [key, `${value}`]);
      const contents = entries.map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
      const binary = rustBinary();
      if (binary) {
        try {
          await runNative(binary, ['write', filePath], JSON.stringify(entries));
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
      fail(new Error('Rust server.properties process timed out'));
    }, 10000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > MAX_NATIVE_OUTPUT) {
        child.kill();
        fail(new Error('Rust server.properties output exceeded limit'));
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > MAX_NATIVE_OUTPUT) {
        child.kill();
        fail(new Error('Rust server.properties error output exceeded limit'));
      }
    });
    child.on('error', fail);
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Rust server.properties process exited with ${code}`));
    });
    child.stdin.end(input);
  });
}

module.exports = { createServerPropertiesAccess, parseServerProperties, readServerPropertiesFallback };
