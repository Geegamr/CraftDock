const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');

function parseNBT(buffer) {
  let pos = 0;
  const readByte   = () => buffer[pos++];
  const readShort  = () => { const v = buffer.readInt16BE(pos); pos += 2; return v; };
  const readInt    = () => { const v = buffer.readInt32BE(pos); pos += 4; return v; };
  const readLong   = () => { pos += 8; return 0; };
  const readFloat  = () => { pos += 4; return 0; };
  const readDouble = () => { pos += 8; return 0; };
  const readString = () => {
    const len = buffer.readUInt16BE(pos); pos += 2;
    const value = buffer.slice(pos, pos + len).toString('utf8');
    pos += len;
    return value;
  };
  const readByteArray = () => {
    const length = readInt();
    const value = buffer.slice(pos, pos + length);
    pos += length;
    return value;
  };
  const readIntArray = () => { const length = readInt(); pos += length * 4; return []; };
  const readLongArray = () => { const length = readInt(); pos += length * 8; return []; };

  function readPayload(type) {
    switch (type) {
      case 1: return readByte();
      case 2: return readShort();
      case 3: return readInt();
      case 4: return readLong();
      case 5: return readFloat();
      case 6: return readDouble();
      case 7: return readByteArray();
      case 8: return readString();
      case 9: return readList();
      case 10: return readCompound();
      case 11: return readIntArray();
      case 12: return readLongArray();
      default: throw new Error('Unknown NBT type: ' + type);
    }
  }

  function readList() {
    const itemType = readByte();
    const count = readInt();
    const values = [];
    for (let i = 0; i < count; i++) values.push(readPayload(itemType));
    return values;
  }

  function readCompound() {
    const values = {};
    while (true) {
      const type = readByte();
      if (type === 0) break;
      values[readString()] = readPayload(type);
    }
    return values;
  }

  const rootType = readByte();
  readString();
  return readPayload(rootType);
}

async function readServersDatFallback(gameDir, logger = console) {
  try {
    const datFile = path.join(gameDir, 'servers.dat');
    if (!fs.existsSync(datFile)) return [];
    const raw = fs.readFileSync(datFile);
    const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;
    const data = isGzip
      ? await new Promise((resolve, reject) => zlib.gunzip(raw, (error, value) => error ? reject(error) : resolve(value)))
      : raw;
    const root = parseNBT(data);
    const servers = root.servers || [];
    return servers.map(server => ({
      name: server.name || 'Minecraft Server',
      ip: server.ip || '',
      icon: server.icon
        ? 'data:image/png;base64,' + (Buffer.isBuffer(server.icon) ? server.icon.toString('base64') : server.icon)
        : null,
      hidden: server.hiddenAddress === 1,
    }));
  } catch (error) {
    logger.warn('[CraftDock] servers.dat parse error:', error.message);
    return [];
  }
}

function createServersDatReader({ isPackaged, appDir, resourcesPath, platform, logger = console }) {
  const rustBinary = () => {
    const name = platform === 'win32' ? 'craftdock-servers-dat.exe' : 'craftdock-servers-dat';
    const candidates = isPackaged
      ? [path.join(resourcesPath, 'native', name)]
      : ['release', 'debug'].map(config => path.join(appDir, 'rust', 'target', config, name));
    return candidates.find(candidate => fs.existsSync(candidate));
  };

  return async function readServersDat(gameDir) {
    const datFile = path.join(gameDir, 'servers.dat');
    if (!fs.existsSync(datFile)) return [];
    const binary = rustBinary();
    if (!binary) return readServersDatFallback(gameDir, logger);

    try {
      const stdout = await new Promise((resolve, reject) => {
        execFile(binary, [datFile], {
          windowsHide: true,
          timeout: 10000,
          // A record costs about six bytes of JSON per input byte at worst (a
          // ten-byte entry renders as a ~60-byte object), so sizing the buffer
          // from the file keeps legitimate dense lists on the native path
          // instead of tripping the buffer limit and silently re-parsing the
          // same bytes in the slower JavaScript fallback.
          maxBuffer: Math.min(
            128 * 1024 * 1024,
            Math.max(4 * 1024 * 1024, (fs.statSync(datFile).size + 1) * 8),
          ),
          encoding: 'utf8',
        }, (error, output, errorOutput) => {
          if (!error) {
            resolve(output);
            return;
          }
          // Node does not attach the child's stderr to the execFile error, and
          // the rejection message is carried there.
          if (errorOutput) error.stderr = errorOutput;
          reject(error);
        });
      });
      const servers = JSON.parse(stdout);
      if (!Array.isArray(servers) || servers.some(server =>
        !server || typeof server.name !== 'string' || typeof server.ip !== 'string' ||
        !(typeof server.icon === 'string' || server.icon === null) || typeof server.hidden !== 'boolean'
      )) throw new Error('Rust parser returned an invalid server list');
      return servers;
    } catch (error) {
      // Exit code 3 means the parser rejected the file's own structure: a
      // declared entry count its bytes cannot support. Re-parsing those same
      // bytes in JavaScript would be far slower and allocate hundreds of times
      // the file size, so surface the rejection instead of falling back.
      if (error.code === 3) {
        const message = String(error.stderr || '').split('\n')
          .map(line => line.trim())
          .find(line => line.startsWith('Rejected:'));
        throw new Error(
          (message || 'Rejected: servers.dat declares more entries than its size can hold')
            .replace(/^Rejected:\s*/, '')
        );
      }
      logger.warn('[CraftDock] Rust servers.dat parser failed; using JavaScript fallback:', error.message);
      return readServersDatFallback(gameDir, logger);
    }
  };
}

module.exports = { createServersDatReader, readServersDatFallback };
