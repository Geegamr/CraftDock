const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron'); // safeStorage intentionally excluded — causes fatal BAD_DECRYPT crash on Electron 40+ Windows
// Set app identity at the very top — must be before app is ready for correct Windows taskbar icon
if (process.platform === 'win32') app.setAppUserModelId('com.craftdock.launcher');
app.setName('CraftDock');
const path  = require('path');
const fs    = require('fs');
const https = require('https');
const zlib  = require('zlib');

// All data lives in craftdock-data/ next to the launcher so users can find it easily
const isDev    = !app.isPackaged;
const appRoot  = isDev ? __dirname : path.dirname(app.getPath('exe'));
const dataRoot = path.join(appRoot, 'craftdock-data');
const skinsDir = path.join(dataRoot, 'skins');
const dataDir  = path.join(dataRoot, 'data');
const serversBase = path.join(dataRoot, 'servers');
const instancesBase = path.join(dataRoot, 'instances');
const sharedWorldsDir = path.join(dataRoot, 'shared-worlds');
[skinsDir, dataDir, serversBase, instancesBase, sharedWorldsDir].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Slug map: id → folder name ─────────────────────────────
// Keeps id stable (used in all JSON references) while folder = human-readable slug
const slugMapFile = path.join(dataDir, 'slug-map.json');
let slugMap = {}; // { 'inst_1234': 'My_Instance', 'srv_5678': 'My_Server' }
try { slugMap = JSON.parse(fs.readFileSync(slugMapFile, 'utf8')); } catch {}

function saveSlugMap() {
  try { fs.writeFileSync(slugMapFile, JSON.stringify(slugMap, null, 2)); } catch {}
}

function slugify(name) {
  // Turn "My Cool Server 1.21!" → "My_Cool_Server_1.21"
  return (name || 'unnamed')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')   // remove illegal chars
    .replace(/\s+/g, '_')                       // spaces → underscores
    .replace(/[^\w.\-]/g, '')                   // keep only word chars, dots, dashes
    .replace(/^\.+|\.+$/g, '')                  // no leading/trailing dots
    .slice(0, 64)                               // max 64 chars
    || 'unnamed';
}

function registerSlug(id, name, base) {
  // Pick a unique folder name for this id
  const desired = slugify(name);
  // If this id already has a mapping, keep it (don't rename on every save)
  if (slugMap[id]) return slugMap[id];
  // Ensure uniqueness: if folder exists for another id, append suffix
  let candidate = desired;
  let suffix = 2;
  const usedFolders = new Set(Object.values(slugMap));
  while (usedFolders.has(candidate) || (fs.existsSync(path.join(base, candidate)) && !slugMap[id])) {
    candidate = desired + '_' + suffix++;
  }
  slugMap[id] = candidate;
  saveSlugMap();
  return candidate;
}

// ── Module-scope dir helpers (also redefined inside registerIpcHandlers for use there) ──
const INST_SUBDIRS = ['mods','saves','config','resourcepacks','screenshots','shaderpacks','logs'];
function instDir(id) { return path.join(instancesBase, slugMap[id] || id); }
function srvDir(id)  { return path.join(serversBase,   slugMap[id] || id); }

// ── Minimal NBT parser (for servers.dat) ───────────────────
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
    const s = buffer.slice(pos, pos + len).toString('utf8');
    pos += len; return s;
  };
  const readByteArray  = () => { const n = readInt(); const buf = buffer.slice(pos, pos+n); pos += n; return buf; };
  const readIntArray   = () => { const n = readInt(); pos += n*4; return []; };
  const readLongArray  = () => { const n = readInt(); pos += n*8; return []; };

  function readPayload(type) {
    switch(type) {
      case 1: return readByte();  case 2: return readShort(); case 3: return readInt();
      case 4: return readLong();  case 5: return readFloat(); case 6: return readDouble();
      case 7: return readByteArray(); case 8: return readString();
      case 9: return readList();  case 10: return readCompound();
      case 11: return readIntArray(); case 12: return readLongArray();
      default: throw new Error('Unknown NBT type: ' + type);
    }
  }
  function readList() {
    const itemType = readByte(); const count = readInt(); const arr = [];
    for (let i = 0; i < count; i++) arr.push(readPayload(itemType));
    return arr;
  }
  function readCompound() {
    const obj = {};
    while (true) { const type = readByte(); if (type === 0) break; const name = readString(); obj[name] = readPayload(type); }
    return obj;
  }
  const rootType = readByte(); readString(); // skip root name
  return readPayload(rootType);
}

async function readServersDat(gameDir) {
  const datFile = path.join(gameDir, 'servers.dat');
  if (!fs.existsSync(datFile)) return [];
  try {
    const raw = fs.readFileSync(datFile);
    // Minecraft Java Edition stores servers.dat as uncompressed NBT.
    // Some older versions or tools may gzip it — try raw first, fall back to gunzip.
    let buf;
    const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;
    if (isGzip) {
      buf = await new Promise((res, rej) => zlib.gunzip(raw, (e, d) => e ? rej(e) : res(d)));
    } else {
      buf = raw;
    }
    const root = parseNBT(buf);
    const servers = root.servers || [];
    return servers.map(s => ({
      name:   s.name || 'Minecraft Server',
      ip:     s.ip   || '',
      icon:   s.icon ? ('data:image/png;base64,' + (Buffer.isBuffer(s.icon) ? s.icon.toString('base64') : s.icon)) : null,
      hidden: s.hiddenAddress === 1,
    }));
  } catch(e) {
    console.warn('[CraftDock] servers.dat parse error:', e.message);
    return [];
  }
}


// Uses AES-256-GCM with a per-install random key stored next to the data.
// This is far more portable than safeStorage/DPAPI which breaks if the app
// is moved, renamed, or updated (causes BAD_DECRYPT on Windows/BoringSSL).
const crypto = require('crypto');

let _tokenKey = null; // 32-byte Buffer, loaded/created lazily

function getTokenKey() {
  if (_tokenKey && _tokenKey.length === 32) return _tokenKey;
  _tokenKey = null;
  const keyFile = path.join(dataDir, '.craftdock_key');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(keyFile)) {
    try {
      const hex = fs.readFileSync(keyFile, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(hex)) {
        const candidate = Buffer.from(hex, 'hex');
        if (candidate.length === 32) { _tokenKey = candidate; return _tokenKey; }
      }
      console.warn('[CraftDock] Key file corrupt, regenerating...');
      fs.unlinkSync(keyFile);
    } catch {}
  }
  _tokenKey = crypto.randomBytes(32);
  try { fs.writeFileSync(keyFile, _tokenKey.toString('hex'), { mode: 0o600 }); } catch {}
  return _tokenKey;
}

function encryptToken(token) {
  if (!token) return '';
  try {
    const key = getTokenKey();
    const iv  = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc  = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const tag  = cipher.getAuthTag();
    // Format: aes:<iv_hex>:<tag_hex>:<ciphertext_hex>
    return 'aes:' + iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
  } catch(e) {
    console.warn('[CraftDock] encryptToken failed, using base64 fallback:', e.message);
    return 'b64:' + Buffer.from(token).toString('base64');
  }
}

function decryptToken(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('aes:')) {
      const parts = stored.slice(4).split(':');
      if (parts.length !== 3) { console.warn('[CraftDock] malformed aes token'); return ''; }
      const [ivHex, tagHex, encHex] = parts;
      const isHex = s => /^[0-9a-fA-F]+$/.test(s);
      if (!isHex(ivHex) || ivHex.length !== 24)  { console.warn('[CraftDock] bad IV in token');  return ''; }
      if (!isHex(tagHex) || tagHex.length !== 32) { console.warn('[CraftDock] bad tag in token'); return ''; }
      if (!isHex(encHex))                          { console.warn('[CraftDock] bad ct in token');  return ''; }
      const key = getTokenKey();
      if (!key || key.length !== 32) { console.warn('[CraftDock] bad key length'); return ''; }
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex,'hex'));
      decipher.setAuthTag(Buffer.from(tagHex,'hex'));
      return decipher.update(Buffer.from(encHex,'hex')) + decipher.final('utf8');
    }
    if (stored.startsWith('safe:')) {
      // safeStorage/DPAPI tokens are unrecoverable if the app path changed.
      // On Electron 40+ Windows, calling safeStorage.decryptString with a
      // bad key throws a FATAL native BoringSSL exception that bypasses JS
      // try/catch and crashes the process. So we NEVER call it — just return
      // empty so the user is prompted to re-login.
      console.warn('[CraftDock] Legacy safeStorage token detected — skipping (unrecoverable, user must re-login)');
      return '';
    }
    if (stored.startsWith('b64:')) {
      return Buffer.from(stored.slice(4), 'base64').toString('utf8');
    }
    // Legacy plaintext or unknown format — return as-is
    return stored;
  } catch(e) {
    console.warn('[CraftDock] decryptToken failed:', e.message);
    return ''; // empty string so auth re-prompts rather than crashing
  }
}

// Microsoft OAuth - loaded from .env (falls back to public Minecraft client ID)
const MS_CLIENT_ID = process.env.MS_CLIENT_ID || '00000000402b5328';
const MS_SCOPE     = 'service::user.auth.xboxlive.com::MBI_SSL';

let mainWindow;
let tray = null;

// ── HTTPS helpers ──────────────────────────────────────────
function httpsRequest(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const opts = { hostname, path, method, headers: { ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const post = (h,p,hdrs,b) => httpsRequest('POST',h,p,hdrs,b);
const get  = (h,p,hdrs)   => httpsRequest('GET', h,p,hdrs);

// ── Microsoft auth chain ───────────────────────────────────
async function doRequestDeviceCode() {
  const body = `client_id=${MS_CLIENT_ID}&scope=${encodeURIComponent(MS_SCOPE)}&response_type=device_code`;
  const r = await post('login.live.com', '/oauth20_connect.srf',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  if (r.status !== 200) throw new Error(`Device code failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body; // { user_code, device_code, verification_uri, interval, expires_in }
}

async function doPollToken(deviceCode) {
  const body = `client_id=${MS_CLIENT_ID}&device_code=${encodeURIComponent(deviceCode)}&grant_type=urn:ietf:params:oauth:grant-type:device_code`;
  const r = await post('login.live.com', '/oauth20_token.srf',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  return { status: r.status, data: r.body };
}

async function doCompleteLogin(msAccessToken) {
  // XBL
  const xblR = await post('user.auth.xboxlive.com', '/user/authenticate',
    { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    { Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: msAccessToken },
      RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' });
  if (xblR.status !== 200) throw new Error(`Xbox auth failed: ${xblR.status}`);
  const xblToken = xblR.body.Token;
  const uhs      = xblR.body.DisplayClaims.xui[0].uhs;

  // XSTS
  const xstsR = await post('xsts.auth.xboxlive.com', '/xsts/authorize',
    { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    { Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' });
  if (xstsR.status !== 200) {
    const code = xstsR.body?.XErr;
    if (code === 2148916233) throw new Error('No Xbox account. Visit xbox.com to create one.');
    if (code === 2148916238) throw new Error('Child account — parental approval required.');
    throw new Error(`XSTS failed: ${xstsR.status} XErr=${code}`);
  }
  const xstsToken = xstsR.body.Token;

  // Minecraft token
  const mcR = await post('api.minecraftservices.com', '/authentication/login_with_xbox',
    { 'Content-Type': 'application/json' },
    { identityToken: `XBL3.0 x=${uhs};${xstsToken}` });
  if (mcR.status !== 200) throw new Error(`Minecraft auth failed: ${mcR.status}`);
  const mcToken = mcR.body.access_token;

  // Profile
  const profR = await get('api.minecraftservices.com', '/minecraft/profile',
    { Authorization: `Bearer ${mcToken}` });
  if (profR.status === 404) throw new Error('This account does not own Minecraft Java Edition.');
  if (profR.status !== 200) throw new Error(`Profile failed: ${profR.status}`);

  return { profile: profR.body, mcToken }; // profile = { id, name, skins, capes }
}

// ── Window ─────────────────────────────────────────────────
function createWindow() {
  // app.setName + setAppUserModelId already called at top of file

  // Load our actual icon via nativeImage so Windows taskbar shows it correctly
  const icoPath = path.join(__dirname, 'assets', 'icon.ico');
  const pngPath = path.join(__dirname, 'assets', 'icon.png');
  const winIcon = nativeImage.createFromPath(
    process.platform === 'win32' ? icoPath : pngPath
  );

  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1000, minHeight: 640,
    frame: false, titleBarStyle: 'hidden', backgroundColor: '#080c14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
    icon: winIcon,
    title: 'CraftDock',
  });

  // Explicitly set icon after creation — ensures Windows taskbar picks it up
  if (!winIcon.isEmpty()) mainWindow.setIcon(winIcon);

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // ── System tray icon ─────────────────────────────────────
  // Use the .ico on Windows (best multi-res support), .png elsewhere
  const trayIconPath = process.platform === 'win32'
    ? path.join(__dirname, 'assets', 'icon.ico')
    : path.join(__dirname, 'assets', 'icon.png');
  tray = new Tray(trayIconPath);
  tray.setToolTip('CraftDock');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show CraftDock', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]));
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });

  // When main window closes, destroy tray and quit
  mainWindow.on('closed', () => {
    tray?.destroy();
    tray = null;
    app.quit();
  });

  // mainWindow.webContents.openDevTools();
}

// Register all IPC handlers first, BEFORE creating the window
// Bump this whenever new IPC handlers are added — renderer checks on startup
const MAIN_JS_VERSION = '0.6.2';

// ── Simple ZIP writer (no external deps) ────────────────────
function writeZipToFile(destPath, entries) {
  // entries = [{ name: string, data: Buffer }]
  const parts = [];
  const centralDir = [];
  let offset = 0;

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (const b of buf) {
      crc ^= b;
      for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  for (const { name, data } of entries) {
    const nameB = Buffer.from(name, 'utf8');
    const crc   = crc32(data);
    const lh    = Buffer.alloc(30 + nameB.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);   // version needed
    lh.writeUInt16LE(0, 6);    // flags
    lh.writeUInt16LE(0, 8);    // compression: store
    lh.writeUInt16LE(0, 10);   // mod time
    lh.writeUInt16LE(0, 12);   // mod date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    lh.writeUInt16LE(0, 28);
    nameB.copy(lh, 30);

    const cdh = Buffer.alloc(46 + nameB.length);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8); cdh.writeUInt16LE(0, 10);
    cdh.writeUInt16LE(0, 12); cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameB.length, 28);
    cdh.writeUInt16LE(0, 30); cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34); cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38); cdh.writeUInt32LE(offset, 42);
    nameB.copy(cdh, 46);

    parts.push(lh, data);
    centralDir.push(cdh);
    offset += lh.length + data.length;
  }

  const cdSize = centralDir.reduce((s, b) => s + b.length, 0);
  const eocd   = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(destPath, Buffer.concat([...parts, ...centralDir, eocd]));
}

function registerIpcHandlers() {
  // ── IPC: Version ping ──────────────────────────────────────
  ipcMain.handle('get-main-version', () => MAIN_JS_VERSION);
  // ── IPC: Electron version (for Settings > About) ───────────
  ipcMain.handle('get-electron-version', () => process.versions.electron || '—');

  // ── IPC: Window controls ───────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
ipcMain.on('window-close', () => mainWindow?.close());

// ── IPC: Auth ──────────────────────────────────────────────
ipcMain.handle('auth-request-device-code', async () => {
  try { return { success: true, data: await doRequestDeviceCode() }; }
  catch(e) { return { success: false, error: e.message }; }
});
ipcMain.handle('auth-poll-token', async (_, deviceCode) => {
  try { const r = await doPollToken(deviceCode); return { success: true, ...r }; }
  catch(e) { return { success: false, error: e.message }; }
});
ipcMain.handle('auth-complete-login', async (_, msAccessToken) => {
  try { return { success: true, ...(await doCompleteLogin(msAccessToken)) }; }
  catch(e) { return { success: false, error: e.message }; }
});

// ── IPC: Persistent key-value store ───────────────────────
ipcMain.handle('store-get', (_, key) => {
  const file = path.join(dataDir, key.replace(/[^a-z0-9_-]/gi, '_') + '.json');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (key === 'craftdock:accounts' && Array.isArray(raw)) {
      const TOKEN_FIELDS = ['minecraftToken', 'mcToken', 'msAccessToken', 'msRefreshToken'];
      const accounts = raw.map(acct => {
        const out = { ...acct };
        let anyBad = false;
        for (const field of TOKEN_FIELDS) {
          const enc = '_' + field;
          if (out[enc]) {
            const decrypted = decryptToken(out[enc]);
            if (!decrypted && out[enc]) {
              // Decryption returned empty — token is unrecoverable (e.g. old DPAPI key)
              anyBad = true;
            }
            out[field] = decrypted;
            delete out[enc];
          }
        }
        // Flag bad accounts so the renderer can prompt re-login
        if (anyBad) out._tokensBroken = true;
        return out;
      });
      return accounts;
    }
    return raw;
  } catch(e) { return null; }
});
ipcMain.handle('store-set', (_, key, value) => {
  let toWrite = value;
  // Encrypt ALL sensitive token fields in accounts before writing to disk
  if (key === 'craftdock:accounts' && Array.isArray(value)) {
    toWrite = value.map(acct => {
      const out = { ...acct };
      // Encrypt every token field; store encrypted under _<field> and delete plaintext
      for (const field of ['minecraftToken', 'mcToken', 'msAccessToken', 'msRefreshToken']) {
        if (out[field]) {
          out['_' + field] = encryptToken(out[field]);
          delete out[field];
        }
      }
      return out;
    });
  }
  fs.writeFileSync(
    path.join(dataDir, key.replace(/[^a-z0-9_-]/gi, '_') + '.json'),
    JSON.stringify(toWrite, null, 2)
  );
  return { success: true };
});
ipcMain.handle('store-delete', (_, key) => {
  const file = path.join(dataDir, key.replace(/[^a-z0-9_-]/gi, '_') + '.json');
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return { success: true };
});

// ── IPC: Skins ─────────────────────────────────────────────
ipcMain.handle('skins-get-all', () => {
  const metaFile = path.join(skinsDir, 'skins.json');
  if (!fs.existsSync(metaFile)) return [];
  const skins = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  return skins.map(s => {
    if (s.filePath && fs.existsSync(s.filePath))
      s.dataUrl = 'data:image/png;base64,' + fs.readFileSync(s.filePath).toString('base64');
    return s;
  });
});
ipcMain.handle('skins-save', (_, skin) => {
  const metaFile = path.join(skinsDir, 'skins.json');
  let skins = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : [];
  if (skin.dataUrl?.startsWith('data:image')) {
    const imgPath = path.join(skinsDir, skin.id + '.png');
    fs.writeFileSync(imgPath, Buffer.from(skin.dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
    skin.filePath = imgPath; delete skin.dataUrl;
  }
  const idx = skins.findIndex(s => s.id === skin.id);
  if (idx >= 0) skins[idx] = skin; else skins.push(skin);
  fs.writeFileSync(metaFile, JSON.stringify(skins, null, 2));
  return { success: true };
});
ipcMain.handle('skins-delete', (_, id) => {
  const metaFile = path.join(skinsDir, 'skins.json');
  if (!fs.existsSync(metaFile)) return;
  fs.writeFileSync(metaFile, JSON.stringify(JSON.parse(fs.readFileSync(metaFile,'utf8')).filter(s=>s.id!==id), null, 2));
  const imgPath = path.join(skinsDir, id + '.png');
  if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  return { success: true };
});
ipcMain.handle('dialog-open-skin', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Skin PNG', filters: [{ name: 'PNG Image', extensions: ['png'] }], properties: ['openFile']
  });
  if (r.canceled || !r.filePaths.length) return null;
  return 'data:image/png;base64,' + fs.readFileSync(r.filePaths[0]).toString('base64');
});

// ── IPC: CurseForge API ────────────────────────────────────
// Key is baked in — users never need to supply their own.
// process.env.CF_API_KEY from .env overrides it in dev if needed.
const CF_API_KEY = process.env.CF_API_KEY || '$2a$10$bL4bIL5pUWqfcO7KwxOSAOWBiNKEFGPHDTACGArQcHClc8W6cFx8K';
const CF_BASE_URL = "https://api.curseforge.com/v1";
ipcMain.handle('cf-get-mc-versions', async () => {
  try {
    const res = await fetch('https://api.curseforge.com/v1/minecraft/version', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'x-api-key': CF_API_KEY
      }
    });

    if (!res.ok) {
      throw new Error(`CurseForge API error: ${res.status}`);
    }

    const data = await res.json();

    return { success: true, data: data.data || [] };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
async function cfSearch(gameId, classId, query = '', gameVersion = '', modLoaderType = '', pageSize = 20, sortField = 2) {
  // Per CF API docs: GET https://api.curseforge.com/v1/mods/search
  // Required: gameId. Auth: x-api-key header. Accept: application/json.
  // sortField: 1=Featured,2=Popularity,3=LastUpdated,4=Name,5=Author,
  //            6=TotalDownloads,8=GameVersion,11=ReleasedDate,12=Rating
  // modLoaderType: 0=Any,1=Forge,2=Cauldron,3=LiteLoader,4=Fabric,5=Quilt,6=NeoForge
  const params = new URLSearchParams({
    gameId,
    classId,
    searchFilter: query || '',
    pageSize,
    sortField: sortField || (query ? 1 : 2),  // 1=Relevance when searching, 2=Popularity for browse
    sortOrder: 'desc'
  });

  if (gameVersion) params.append('gameVersion', gameVersion);
  // Only send modLoaderType if non-empty — omitting it means "Any" per CF docs
  if (modLoaderType !== '' && modLoaderType !== null && modLoaderType !== undefined) {
    params.append('modLoaderType', Number(modLoaderType));
  }

  const res = await fetch(`${CF_BASE_URL}/mods/search?${params}`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'x-api-key': CF_API_KEY
    }
  });

  if (!res.ok) throw new Error(`CurseForge API ${res.status}: ${await res.text().catch(()=>'')}`);

  return await res.json();
}
ipcMain.handle('curseforge-search', async (_, query = '', gameVersion = '', modLoaderType = '', classId = 4471, sortField = 2) => {
  try {
    // Pass all params including sortField — cfSearch now accepts it as 7th argument
    const data = await cfSearch(432, classId, query, gameVersion, modLoaderType, 40, sortField);
    return { success: true, data: data.data || [] };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
// CF_API_KEY loaded (debug logging removed)

console.log('[CraftDock] Registering IPC handlers...');

// ═══════════════════════════════════════════════════════════
//  SERVER MANAGER IPC
// ═══════════════════════════════════════════════════════════
const { spawn } = require('child_process');
const runningServers = new Map();

// ── Open folder ────────────────────────────────────────────
ipcMain.handle('open-folder',      (_, p)  => shell.openPath(p));
ipcMain.handle('get-data-root',    ()      => dataRoot);
ipcMain.handle('get-server-path',  (_, id) => srvDir(id));

// ── Resolve Paper build URL ────────────────────────────────
async function resolvePaperUrl(version, build) {
  return new Promise((resolve, reject) => {
    const path_ = build
      ? `/v2/projects/paper/versions/${version}/builds/${build}`
      : `/v2/projects/paper/versions/${version}`;
    const req = require('https').get(
      { hostname:'api.papermc.io', path: path_,
        headers:{'User-Agent':'CraftDock/0.6.2 (contact@craftdock.app)'} }, res => {
      if ([301,302,307,308].includes(res.statusCode)) {
        res.resume();
        return resolvePaperUrl(version, build).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('PaperMC API HTTP ' + res.statusCode)); }
      let raw=''; res.on('data',d=>raw+=d);
      res.on('end',()=>{
        try {
          const d=JSON.parse(raw);
          const b = build || d.builds[d.builds.length-1];
          resolve(`https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${b}/downloads/paper-${version}-${b}.jar`);
        } catch(e) { reject(new Error('PaperMC API parse error: '+e.message)); }
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('PaperMC API timeout')));
    req.on('error', reject);
  });
}

async function resolvePurpurUrl(version) {
  // Purpur API returns a direct download redirect
  return `https://api.purpurmc.org/v2/purpur/${version}/latest/download`;
}
async function resolveVanillaUrl(version) {
  // Fetch the version manifest with a timeout + User-Agent to avoid Windows SSL issues
  const fetchJson = (url) => new Promise((resolve, reject) => {
    const req = require('https').get(url, {
      headers: { 'User-Agent': 'CraftDock/0.6.2 (contact@craftdock.app)' }
    }, res => {
      // Follow redirects
      if ([301,302,307,308].includes(res.statusCode)) {
        res.resume();
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error('Bad JSON from ' + url)); } });
      res.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error('Timeout fetching ' + url)));
    req.on('error', reject);
  });

  const manifest = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  const entry = manifest.versions.find(x => x.id === version);
  if (!entry) throw new Error('Minecraft version ' + version + ' not found in manifest');
  const versionMeta = await fetchJson(entry.url);
  const serverUrl = versionMeta?.downloads?.server?.url;
  if (!serverUrl) throw new Error('No server download for MC ' + version);
  return serverUrl;
}

// ── Minimal ZIP reader (Node built-ins only, no adm-zip needed) ────
function readZipEntries(zipPath) {
  // Returns Map<name, Buffer> for all entries in the zip
  const buf = fs.readFileSync(zipPath);
  const entries = new Map();

  // Find End of Central Directory (EOCD) — search from end
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error('Invalid ZIP: EOCD not found');

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdSize   = buf.readUInt32LE(eocdOffset + 12);
  const cdCount  = buf.readUInt16LE(eocdOffset + 10);

  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const compression  = buf.readUInt16LE(pos + 10);
    const compressedSz = buf.readUInt32LE(pos + 20);
    const fileNameLen  = buf.readUInt16LE(pos + 28);
    const extraLen     = buf.readUInt16LE(pos + 30);
    const commentLen   = buf.readUInt16LE(pos + 32);
    const localOffset  = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + fileNameLen).toString('utf8');
    pos += 46 + fileNameLen + extraLen + commentLen;

    // Read local file header to get actual data offset
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + fileNameLen + localExtraLen;
    const compData = buf.slice(dataOffset, dataOffset + compressedSz);

    if (compression === 0) {
      // Stored (no compression)
      entries.set(name, compData);
    } else if (compression === 8) {
      // Deflate
      entries.set(name, require('zlib').inflateRawSync(compData));
    }
    // Other methods ignored
  }
  return entries;
}

// ── Verify a JAR/ZIP file has a valid ZIP end-of-central-directory ──
function verifyZip(filePath) {
  try {
    const fd   = require('fs').openSync(filePath, 'r');
    const stat = require('fs').fstatSync(fd);
    if (stat.size < 22) { require('fs').closeSync(fd); return false; }
    // Read last 22 bytes — the minimum EOCD record
    const buf = Buffer.alloc(22);
    require('fs').readSync(fd, buf, 0, 22, stat.size - 22);
    require('fs').closeSync(fd);
    // EOCD signature: PK
    return buf[0]===0x50 && buf[1]===0x4b && buf[2]===0x05 && buf[3]===0x06;
  } catch { return false; }
}


async function downloadServerJar(destPath, url, onProgress, send, label) {
  const MAX_TRIES = 3;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    if (attempt > 1) {
      send && send(0, `Retry ${attempt}/${MAX_TRIES} — re-downloading server.jar...`);
      try { fs.unlinkSync(destPath); } catch {}
    }
    await downloadFile(url, destPath, onProgress, 180000);
    if (verifyZip(destPath)) return; // good
    // File is corrupt/truncated
    if (attempt === MAX_TRIES) {
      throw new Error(
        `server.jar failed ZIP integrity check after ${MAX_TRIES} attempts.\n` +
        `File size: ${fs.existsSync(destPath) ? fs.statSync(destPath).size : 0} bytes.\n` +
        `URL: ${url}`
      );
    }
    send && send(0, `server.jar appears truncated (attempt ${attempt}) — retrying...`);
  }
}

// ── Download with progress + redirect + timeout ────────────
function downloadFile(url, dest, onProgress, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const go = (u, redirects = 0) => {
      if (redirects > 10) { done(reject, new Error('Too many redirects: ' + u)); return; }
      const proto = u.startsWith('https') ? require('https') : require('http');
      const req = proto.get(u, {
        headers: { 'User-Agent': 'CraftDock/0.6.2 (contact@craftdock.app)' }
      }, res => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          res.resume(); // drain response
          go(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          done(reject, new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let recv = 0;
        const out = require('fs').createWriteStream(dest);
        let _lastPct = -1;
        res.on('data', chunk => {
          recv += chunk.length;
          if (total && onProgress) {
            const pct = Math.round(recv / total * 100);
            if (pct !== _lastPct) { _lastPct = pct; onProgress(pct); }
          }
        });
        res.pipe(out);
        out.on('finish', () => done(resolve));
        out.on('error', e => done(reject, e));
        res.on('error',  e => done(reject, e));
      });
      req.on('error', e => done(reject, e));
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Download timed out after ${timeoutMs/1000}s: ${u}`));
      });
    };
    go(url);
  });
}

// ═══════════════════════════════════════════════════════════
//  INSTANCE MANAGEMENT
//  Each instance = craftdock-data/instances/<id>/
//  Structure mirrors a real .minecraft profile folder:
//    mods/  saves/  config/  resourcepacks/  screenshots/
//    shaderpacks/  logs/  instance.json  (meta)
// ═══════════════════════════════════════════════════════════

function ensureInstance(id) {
  const base = instDir(id);
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  for (const sub of INST_SUBDIRS) {
    const p = path.join(base, sub);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
  return base;
}

function readInstMeta(id) {
  try {
    const p = path.join(instDir(id), 'instance.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return null;
}

function writeInstMeta(id, meta) {
  const dir = instDir(id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify(meta, null, 2));
}

// Set up or remove shared worlds symlink/junction for an instance
function sharedWorldsDirForTag(tag) {
  // Each tag gets its own subfolder under shared-worlds/
  const safeName = tag.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  return path.join(sharedWorldsDir, safeName);
}

function applySharedWorlds(id, tag) {
  // tag = string (non-empty) → link saves/ to shared-worlds/<tag>/
  // tag = null/'' → unlink saves/ back to a real dir
  const savesPath = path.join(instDir(id), 'saves');
  const isWin = process.platform === 'win32';

  // Read current state
  let currentlyLinked = false;
  try {
    const stat = fs.lstatSync(savesPath);
    currentlyLinked = stat.isSymbolicLink() || (isWin && stat.isDirectory() && (() => {
      try { const { execSync } = require('child_process'); return execSync(`fsutil reparsepoint query "${savesPath}" 2>nul`).toString().includes('Tag value'); } catch { return false; }
    })());
  } catch {}

  if (!tag) {
    // Disable: turn symlink back into real folder
    if (currentlyLinked) {
      try {
        if (isWin) { const { execSync } = require('child_process'); execSync(`rmdir "${savesPath}"`, { windowsHide: true }); }
        else fs.unlinkSync(savesPath);
      } catch {}
    }
    if (!fs.existsSync(savesPath)) fs.mkdirSync(savesPath, { recursive: true });
    return;
  }

  const tagDir = sharedWorldsDirForTag(tag);
  if (!fs.existsSync(tagDir)) fs.mkdirSync(tagDir, { recursive: true });

  // Remove existing saves (symlink or empty dir)
  if (currentlyLinked) {
    try {
      if (isWin) { const { execSync } = require('child_process'); execSync(`rmdir "${savesPath}"`, { windowsHide: true }); }
      else fs.unlinkSync(savesPath);
    } catch {}
  } else if (fs.existsSync(savesPath)) {
    // Move any existing worlds into the tag folder
    try {
      const entries = fs.readdirSync(savesPath);
      for (const e of entries) {
        const src = path.join(savesPath, e);
        const dst = path.join(tagDir, e);
        if (!fs.existsSync(dst)) fs.renameSync(src, dst);
      }
      fs.rmdirSync(savesPath);
    } catch {}
  }

  // Create symlink/junction to tag dir
  try {
    if (isWin) {
      const { execSync } = require('child_process');
      execSync(`mklink /J "${savesPath}" "${tagDir}"`, { windowsHide: true });
    } else {
      fs.symlinkSync(tagDir, savesPath, 'dir');
    }
  } catch(e) {
    console.warn('[CraftDock] Could not create saves symlink:', e.message);
    if (!fs.existsSync(savesPath)) fs.mkdirSync(savesPath);
  }
}

// List all instance IDs that have a folder
function listInstanceIds() {
  if (!fs.existsSync(instancesBase)) return [];
  return fs.readdirSync(instancesBase)
    .filter(e => fs.existsSync(path.join(instancesBase, e, 'instance.json')));
}

// ── Instance IPC Handlers ─────────────────────────────────

ipcMain.handle('instance-create', (_, meta) => {
  const id = meta.id || ('inst_' + Date.now());
  meta.id = id;
  meta.createdAt = meta.createdAt || Date.now();
  // Register slug so folder uses instance name (e.g. "My Pack" → "My_Pack")
  registerSlug(id, meta.name || id, instancesBase);
  ensureInstance(id);
  writeInstMeta(id, meta);
  if (meta.worldTag) applySharedWorlds(id, meta.worldTag);
  return { success: true, id, dir: instDir(id) };
});

ipcMain.handle('instance-update', (_, meta) => {
  const id = meta.id;
  if (!id) return { success: false, error: 'No id' };
  const existing = readInstMeta(id) || {};
  const wasTag = existing.worldTag || null;
  const nowTag = meta.worldTag || null;
  writeInstMeta(id, { ...existing, ...meta });
  if (wasTag !== nowTag) applySharedWorlds(id, nowTag);
  return { success: true };
});

ipcMain.handle('instance-delete', (_, id) => {
  const dir = instDir(id);
  if (!fs.existsSync(dir)) return { success: true };

  // Remove saves symlink/junction BEFORE recursive delete
  // On Windows, junctions must be removed with rmdir (not rmSync) before deleting parent
  const savesPath = path.join(dir, 'saves');
  try {
    const stat = fs.lstatSync(savesPath);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(savesPath);
    } else if (stat.isDirectory() && process.platform === 'win32') {
      // Might be a junction — rmdir removes junctions without touching their contents
      const { execSync } = require('child_process');
      try { execSync(`rmdir "${savesPath}"`, { windowsHide: true }); } catch {
        // If rmdir fails it's a real dir — just leave it for rmSafe
      }
    }
  } catch {}

  rmSafe(dir);
  return { success: true };
});

ipcMain.handle('instance-list', () => {
  const ids = listInstanceIds();
  return ids.map(id => {
    const meta = readInstMeta(id);
    return meta || { id };
  });
});

ipcMain.handle('instance-get', (_, id) => {
  return readInstMeta(id);
});

ipcMain.handle('instance-list-worlds', (_, id) => {
  const savesPath = path.join(instDir(id), 'saves');
  try {
    // Resolve real path even if symlink
    const real = fs.realpathSync(savesPath);
    if (!fs.existsSync(real)) return [];
    return fs.readdirSync(real, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const wPath = path.join(real, e.name);
        let lastPlayed = null;
        try { lastPlayed = fs.statSync(path.join(wPath, 'level.dat')).mtimeMs; } catch {}
        return { name: e.name, path: wPath, lastPlayed };
      })
      .sort((a,b) => (b.lastPlayed||0) - (a.lastPlayed||0));
  } catch { return []; }
});

ipcMain.handle('instance-list-mods', (_, id) => {
  const modsPath = path.join(instDir(id), 'mods');
  try {
    if (!fs.existsSync(modsPath)) return [];
    return fs.readdirSync(modsPath)
      .filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled'))
      .map(f => ({ name: f, enabled: !f.endsWith('.disabled'), path: path.join(modsPath, f) }));
  } catch { return []; }
});

ipcMain.handle('instance-toggle-mod', (_, id, filename, enable) => {
  const modsPath = path.join(instDir(id), 'mods');
  const from = path.join(modsPath, filename);
  let to;
  if (enable) to = from.replace(/\.disabled$/, '');
  else to = from.endsWith('.disabled') ? from : from + '.disabled';
  try { if (from !== to) fs.renameSync(from, to); return { success: true }; }
  catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('instance-delete-mod', (_, id, filename) => {
  try { fs.unlinkSync(path.join(instDir(id), 'mods', filename)); return { success: true }; }
  catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('instance-list-screenshots', (_, id) => {
  const ssPath = path.join(instDir(id), 'screenshots');
  try {
    if (!fs.existsSync(ssPath)) return [];
    return fs.readdirSync(ssPath)
      .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
      .map(f => {
        const fp = path.join(ssPath, f);
        const stat = fs.statSync(fp);
        return { name: f, path: fp, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a,b) => b.mtime - a.mtime);
  } catch { return []; }
});

ipcMain.handle('instance-download-mod', async (_, id, url, filename) => {
  const modsDir = path.join(instDir(id), 'mods');
  if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
  const dest = path.join(modsDir, filename);
  await downloadFile(url, dest, null, 120000);
  return { success: true, path: dest };
});

ipcMain.handle('instance-open-folder', (_, id, sub) => {
  const base = ensureInstance(id);
  const target = sub ? path.join(base, sub) : base;
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  shell.openPath(target);
  return { success: true };
});

ipcMain.handle('instance-get-disk-size', async (_, id) => {
  const base = instDir(id);
  if (!fs.existsSync(base)) return 0;
  let total = 0;
  const walk = (dir) => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        try {
          if (e.isSymbolicLink()) return; // don't double-count shared worlds
          if (e.isDirectory()) walk(p);
          else total += fs.statSync(p).size;
        } catch {}
      }
    } catch {}
  };
  walk(base);
  return total;
});

// ── MC client launch helpers ──────────────────────────────
const clientsDir = path.join(dataRoot, 'client-cache'); // shared jar/lib cache
if (!fs.existsSync(clientsDir)) fs.mkdirSync(clientsDir, { recursive: true });

function fetchJsonHttp(url) {
  return new Promise((resolve, reject) => {
    const req = require('https').get(url, {
      headers: { 'User-Agent': 'CraftDock/0.6.2 (contact@craftdock.app)' }
    }, res => {
      if ([301,302,307,308].includes(res.statusCode)) {
        res.resume(); return fetchJsonHttp(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP '+res.statusCode+' '+url)); }
      let raw=''; res.on('data',d=>raw+=d);
      res.on('end',()=>{ try{resolve(JSON.parse(raw));}catch(e){reject(e);} });
      res.on('error',reject);
    });
    req.setTimeout(30000,()=>req.destroy(new Error('Timeout: '+url)));
    req.on('error',reject);
  });
}

async function downloadIfMissing(url, dest) {
  if (fs.existsSync(dest)) return;
  if (!fs.existsSync(path.dirname(dest))) fs.mkdirSync(path.dirname(dest),{recursive:true});
  await downloadFile(url, dest, null, 120000);
}

ipcMain.handle('instance-launch', async (event, inst, serverIp) => {
  const send = (status, msg) => event.sender.send('instance-launch-status', inst.id, status, msg);
  const dir = ensureInstance(inst.id);
  const meta = readInstMeta(inst.id) || inst;
  const playStartTime = Date.now();
  send('starting', serverIp ? `Preparing to join ${serverIp}…` : 'Preparing launch…');
  writeInstMeta(inst.id, { ...meta, lastPlayed: playStartTime });

  const mcVersion = meta.mcVersion || inst.mcVersion || '1.21.4';
  const loader    = (meta.loader || inst.loader || '').toLowerCase();
  const ramMin    = meta.ramMin || inst.ramMin || 2048;
  const ramMax    = meta.ramMax || inst.ramMax || 4096;

  // ── Get active account ────────────────────────────────────
  let playerName = 'Player', accessToken = '0', playerUuid = '00000000-0000-0000-0000-000000000000';
  try {
    const accountsFile = path.join(dataDir, 'craftdock_accounts_.json');
    if (fs.existsSync(accountsFile)) {
      const accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
      const active = Array.isArray(accounts) ? accounts.find(a => a.active) || accounts[0] : null;
      if (active) {
        playerName  = active.minecraftUsername || active.username || playerName;
        playerUuid  = active.minecraftUuid     || active.uuid     || playerUuid;
        // Decrypt token if encrypted
        const encToken = active._minecraftToken || active._mcToken;
        if (encToken) {
          try { accessToken = decryptToken(encToken) || '0'; } catch {}
        } else {
          accessToken = active.minecraftToken || active.mcToken || '0';
        }
      }
    }
  } catch(e) { console.warn('[CraftDock] Account read error:', e.message); }

  try {
    // ── Step 1: fetch version manifest ───────────────────────
    send('progress', '1/5 Fetching version manifest…');
    const manifest = await fetchJsonHttp('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    const vEntry = manifest.versions.find(v => v.id === mcVersion);
    if (!vEntry) throw new Error(`MC version ${mcVersion} not found in manifest`);

    // ── Step 2: fetch version.json ───────────────────────────
    send('progress', '2/5 Fetching version JSON…');
    const vDir = path.join(clientsDir, mcVersion);
    if (!fs.existsSync(vDir)) fs.mkdirSync(vDir, {recursive:true});
    const vJsonPath = path.join(vDir, 'version.json');
    let vJson;
    if (fs.existsSync(vJsonPath)) {
      vJson = JSON.parse(fs.readFileSync(vJsonPath,'utf8'));
    } else {
      vJson = await fetchJsonHttp(vEntry.url);
      fs.writeFileSync(vJsonPath, JSON.stringify(vJson, null, 2));
    }

    // ── Step 3: download client.jar ───────────────────────────
    send('progress', '3/5 Downloading client jar…');
    const clientJar = path.join(vDir, `minecraft-${mcVersion}-client.jar`);
    await downloadIfMissing(vJson.downloads.client.url, clientJar);

    // ── Step 4: download libraries ────────────────────────────
    send('progress', '4/5 Downloading libraries…');
    const libsDir = path.join(clientsDir, 'libraries');
    const classpath = [clientJar];
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    for (const lib of (vJson.libraries || [])) {
      // Check rules
      if (lib.rules) {
        const allowed = lib.rules.reduce((ok, rule) => {
          const osMatch = !rule.os || (
            (rule.os.name === 'windows' && isWin) ||
            (rule.os.name === 'osx'     && isMac) ||
            (rule.os.name === 'linux'   && !isWin && !isMac)
          );
          return rule.action === 'allow' ? ok && osMatch : ok && !osMatch;
        }, true);
        if (!allowed) continue;
      }
      if (lib.downloads?.artifact) {
        const art  = lib.downloads.artifact;
        const dest = path.join(libsDir, art.path);
        await downloadIfMissing(art.url, dest);
        classpath.push(dest);
      }
    }

    // ── Step 5: find java ─────────────────────────────────────
    const javaInfo = await findBestJava(8, meta.javaPath || null);
    const java = javaInfo.exe;

    // ── Step 5b: Install mod loader (Fabric / Quilt / Forge / NeoForge) ─────
    let mainClass = vJson.mainClass || 'net.minecraft.client.main.Main';
    const loaderCacheDir = path.join(clientsDir, 'loaders');
    if (!fs.existsSync(loaderCacheDir)) fs.mkdirSync(loaderCacheDir, { recursive: true });

    if (loader === 'fabric' || loader === 'quilt') {
      const metaBase = loader === 'fabric'
        ? 'https://meta.fabricmc.net/v2'
        : 'https://meta.quiltmc.org/v3';

      let loaderVer = meta.loaderVersion || null;
      if (!loaderVer) {
        try {
          send('progress', `Installing ${loader} — fetching versions…`);
          const versions = await fetchJsonHttp(`${metaBase}/versions/loader`);
          const stable = versions.find(v => v.stable !== false);
          loaderVer = stable?.version || versions[0]?.version;
        } catch(e) { console.warn(`[CraftDock] ${loader} versions fetch failed:`, e.message); }
      }

      if (loaderVer) {
        const profileCacheKey = `${loader}-${mcVersion}-${loaderVer}.json`;
        const profilePath = path.join(loaderCacheDir, profileCacheKey);
        let loaderProfile = null;
        if (fs.existsSync(profilePath)) {
          try { loaderProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch {}
        }
        if (!loaderProfile) {
          try {
            send('progress', `Installing ${loader} ${loaderVer}…`);
            loaderProfile = await fetchJsonHttp(`${metaBase}/versions/loader/${mcVersion}/${loaderVer}/profile/json`);
            fs.writeFileSync(profilePath, JSON.stringify(loaderProfile));
          } catch(e) { console.warn(`[CraftDock] ${loader} profile fetch failed:`, e.message); }
        }
        if (loaderProfile) {
          mainClass = loaderProfile.mainClass || mainClass;
          for (const lib of (loaderProfile.libraries || [])) {
            if (!lib.name || !lib.url) continue;
            const [group, artifact, version] = lib.name.split(':');
            if (!group || !artifact || !version) continue;
            const relPath = `${group.replace(/\./g,'/')}/${artifact}/${version}/${artifact}-${version}.jar`;
            const dest = path.join(libsDir, relPath);
            if (!fs.existsSync(dest)) {
              try {
                if (!fs.existsSync(path.dirname(dest))) fs.mkdirSync(path.dirname(dest),{recursive:true});
                const libUrl = (lib.url.endsWith('/') ? lib.url : lib.url + '/') + relPath;
                await downloadFile(libUrl, dest, null, 60000);
              } catch {}
            }
            if (fs.existsSync(dest)) classpath.push(dest);
          }
        }
      }
    } else if (loader === 'forge' || loader === 'neoforge') {
      const forgeCacheDir = path.join(loaderCacheDir, `${loader}-${mcVersion}`);
      const forgeMarker   = path.join(forgeCacheDir, 'installed.json');
      if (!fs.existsSync(forgeMarker)) {
        send('progress', `Installing ${loader} (first launch — may take ~30s)…`);
        try {
          if (!fs.existsSync(forgeCacheDir)) fs.mkdirSync(forgeCacheDir, { recursive: true });
          let loaderVersion = meta.loaderVersion || null;
          let installerUrl;
          if (!loaderVersion) {
            if (loader === 'neoforge') {
              const vers = await fetchJsonHttp('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
              const prefix = mcVersion.replace(/^1\./, '');
              loaderVersion = (vers.versions || []).filter(v => v.startsWith(prefix)).reverse()[0];
              installerUrl = loaderVersion ? `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar` : null;
            } else {
              const promos = await fetchJsonHttp('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
              loaderVersion = promos.promos[`${mcVersion}-recommended`] || promos.promos[`${mcVersion}-latest`];
              installerUrl = loaderVersion ? `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${loaderVersion}/forge-${mcVersion}-${loaderVersion}-installer.jar` : null;
            }
          }
          if (installerUrl) {
            const installerJar = path.join(forgeCacheDir, 'installer.jar');
            await downloadFile(installerUrl, installerJar, null, 120000);
            const javaInfo2 = await findBestJava(17, meta.javaPath || null);
            const { execFileSync } = require('child_process');
            execFileSync(javaInfo2.exe, ['-jar', installerJar, '--installClient', forgeCacheDir],
              { timeout: 180000, windowsHide: true, stdio: 'pipe' });
            fs.writeFileSync(forgeMarker, JSON.stringify({ mcVersion, loaderVersion, installedAt: Date.now() }));
          }
        } catch(e) {
          console.warn(`[CraftDock] ${loader} installer failed:`, e.message);
          send('progress', `Warning: ${loader} install failed — launching vanilla.`);
        }
      }
      // Load forge version profile if present
      const forgeVersionsDir = path.join(forgeCacheDir, 'versions');
      if (fs.existsSync(forgeVersionsDir)) {
        try {
          for (const vd of fs.readdirSync(forgeVersionsDir)) {
            const vjson = path.join(forgeVersionsDir, vd, `${vd}.json`);
            if (fs.existsSync(vjson)) {
              const fv = JSON.parse(fs.readFileSync(vjson, 'utf8'));
              if (fv.mainClass) mainClass = fv.mainClass;
              for (const lib of (fv.libraries || [])) {
                if (lib.downloads?.artifact?.path) {
                  const dest = path.join(libsDir, lib.downloads.artifact.path);
                  if (fs.existsSync(dest)) classpath.push(dest);
                }
              }
              break;
            }
          }
        } catch {}
      }
    }

    send('progress', 'Starting Minecraft…');

    const assetIndex = vJson.assetIndex?.id || mcVersion;
    const assetsDir  = path.join(clientsDir, 'assets');
    const assetIndexPath = path.join(assetsDir, 'indexes', assetIndex+'.json');
    let assetData = null;
    if (!fs.existsSync(assetIndexPath)) {
      send('progress', '4/5 Downloading asset index…');
      try {
        if (!fs.existsSync(path.dirname(assetIndexPath))) fs.mkdirSync(path.dirname(assetIndexPath),{recursive:true});
        assetData = await fetchJsonHttp(vJson.assetIndex.url);
        fs.writeFileSync(assetIndexPath, JSON.stringify(assetData));
      } catch(e) { console.warn('[CraftDock] Asset index download failed:', e.message); }
    } else {
      try { assetData = JSON.parse(fs.readFileSync(assetIndexPath,'utf8')); } catch {}
    }

    // Download asset objects (the actual files MC needs to run)
    if (assetData?.objects) {
      const objectsDir = path.join(assetsDir, 'objects');
      const objects = Object.values(assetData.objects);
      const total = objects.length;
      let done = 0, errors = 0;
      send('progress', `Downloading assets (0 / ${total})…`);

      // Download in batches of 20 concurrent
      const BATCH = 20;
      for (let i = 0; i < objects.length; i += BATCH) {
        const batch = objects.slice(i, i + BATCH);
        await Promise.all(batch.map(async obj => {
          const hash = obj.hash;
          const size = obj.size || 0;
          const prefix = hash.substring(0, 2);
          const dest = path.join(objectsDir, prefix, hash);
          // Re-download if missing or wrong size (catches 0-byte partial files)
          let needsDl = !fs.existsSync(dest);
          if (!needsDl && size > 0) {
            try { if (fs.statSync(dest).size !== size) needsDl = true; } catch { needsDl = true; }
          }
          if (needsDl) {
            if (!fs.existsSync(path.dirname(dest))) fs.mkdirSync(path.dirname(dest),{recursive:true});
            try {
              await downloadFile(`https://resources.download.minecraft.net/${prefix}/${hash}`, dest, null, 30000);
            } catch(e) { errors++; try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {} }
          }
          done++;
        }));
        if (i % (BATCH * 3) === 0) {
          send('progress', `Downloading assets (${done} / ${total})…`);
        }
      }
      send('progress', `Assets ready — ${errors > 0 ? errors + ' failed' : 'all good'} (${done}/${total})`);
    }

    // Deduplicate classpath: keep newest version of each artifact, BUT always keep native JARs
    // (lwjgl-3.3.3-natives-windows.jar must NOT be deduped against lwjgl-3.3.3.jar)
    const cpMap = new Map(); // artifactKey → path
    for (const p of classpath) {
      const base = path.basename(p, '.jar');
      // If this JAR contains a natives classifier, include it in the key so it's never deduped
      const nativesMatch = base.match(/(natives-[a-z]+(?:-\d+)?)/);
      const nativesTag   = nativesMatch ? '-' + nativesMatch[1] : '';
      // Strip trailing -<version> to get artifact name, then re-append natives tag
      const artifactKey  = base.replace(/-[\d].*$/, '') + nativesTag;
      const vMatch       = base.match(/-(\d[\d._a-zA-Z-]*)$/);
      const ver          = vMatch ? vMatch[1] : '0';
      if (!cpMap.has(artifactKey)) {
        cpMap.set(artifactKey, { path: p, ver });
      } else {
        const existing = cpMap.get(artifactKey);
        if (compareVersions(ver, existing.ver) > 0) {
          cpMap.set(artifactKey, { path: p, ver });
        }
      }
    }

    function compareVersions(a, b) {
      const pa = String(a).split(/[._-]/).map(s => parseInt(s)||0);
      const pb = String(b).split(/[._-]/).map(s => parseInt(s)||0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i]||0) - (pb[i]||0);
        if (diff !== 0) return diff;
      }
      return 0;
    }

    const sep = isWin ? ';' : ':';
    const cpStr = [...cpMap.values()].map(v => v.path).join(sep);

    // ── Extract natives ───────────────────────────────────────────────────────
    // Modern MC (1.19+) uses LWJGL 3.x: native DLLs/SOs live inside artifact JARs
    // whose filename contains "natives-windows" / "natives-linux" / "natives-osx".
    // The cpMap dedup now keeps them (different artifact key from non-native JAR),
    // but we also scan raw classpath before dedup in case they got dropped.
    const nativesDir = path.join(vDir, 'natives');
    const nativeSuffix = isWin ? 'natives-windows' : isMac ? 'natives-osx' : 'natives-linux';
    const nativeExts   = isWin ? ['.dll'] : isMac ? ['.dylib', '.jnilib'] : ['.so'];

    // Check if we already have real native files (not just empty marker files)
    const hasRealNatives = fs.existsSync(nativesDir) &&
      fs.readdirSync(nativesDir).some(f => nativeExts.includes(path.extname(f).toLowerCase()));

    if (!hasRealNatives) {
      // Wipe dir and re-extract from scratch
      try {
        if (fs.existsSync(nativesDir)) {
          for (const f of fs.readdirSync(nativesDir)) {
            try { fs.unlinkSync(path.join(nativesDir, f)); } catch {}
          }
        }
      } catch {}
      if (!fs.existsSync(nativesDir)) fs.mkdirSync(nativesDir, { recursive: true });

      // Collect native JARs: scan BOTH raw classpath (before dedup) and cpMap output
      const nativeJarSet = new Set();
      for (const p of [...classpath, ...[...cpMap.values()].map(v => v.path)]) {
        if (p.replace(/\\/g, '/').toLowerCase().includes(nativeSuffix)) nativeJarSet.add(p);
      }
      // Also handle legacy classifiers (MC <=1.16)
      for (const lib of (vJson.libraries || [])) {
        for (const key of [nativeSuffix, 'natives-windows-64', 'natives-osx', 'natives-linux']) {
          const cls = lib.downloads?.classifiers?.[key];
          if (cls?.url && cls?.path) {
            const dest = path.join(libsDir, cls.path);
            try { await downloadIfMissing(cls.url, dest); } catch {}
            if (fs.existsSync(dest)) nativeJarSet.add(dest);
          }
        }
      }

      send('progress', `Extracting natives from ${nativeJarSet.size} JAR(s)…`);
      for (const jarPath of nativeJarSet) {
        try {
          const entries = readZipEntries(jarPath);
          let n = 0;
          for (const [name, buf] of entries) {
            if (nativeExts.includes(path.extname(name).toLowerCase()) && !name.includes('/')) {
              fs.writeFileSync(path.join(nativesDir, name), buf);
              n++;
            }
          }
          if (n > 0) send('progress', `  ✓ ${path.basename(jarPath)} → ${n} native file(s)`);
        } catch (e) {
          console.warn('[CraftDock] Natives extract error:', path.basename(jarPath), e.message);
        }
      }

      const extracted = fs.readdirSync(nativesDir).filter(f => nativeExts.includes(path.extname(f).toLowerCase()));
      send('progress', `Natives ready: ${extracted.length} file(s) in ${path.basename(nativesDir)}`);
    }

    const jvmArgs = [
      `-Xms${ramMin}m`, `-Xmx${ramMax}m`,
      '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
      '-Djava.awt.headless=false',
      `-Djava.library.path=${nativesDir}`,
      `-Dorg.lwjgl.librarypath=${nativesDir}`,
      '-cp', cpStr,
      mainClass,
      '--username', playerName,
      '--version', mcVersion,
      '--gameDir', dir,
      '--assetsDir', assetsDir,
      '--assetIndex', assetIndex,
      '--uuid', playerUuid,
      '--accessToken', accessToken,
      '--userType', accessToken === '0' ? 'offline' : 'mojang',
      '--versionType', 'release',
    ];

    // ── Auto-connect to server if serverIp provided ──────────
    if (serverIp) {
      const [host, portStr] = serverIp.split(':');
      const port = parseInt(portStr) || 25565;
      // MC 1.20+ supports --quickPlayMultiplayer host:port
      // Older versions use --server host --port N
      const verParts = mcVersion.split('.').map(Number);
      const isNew = verParts[0] > 1 || (verParts[0] === 1 && verParts[1] >= 20);
      if (isNew) {
        jvmArgs.push('--quickPlayMultiplayer', `${host}:${port}`);
      } else {
        jvmArgs.push('--server', host, '--port', String(port));
      }
      send('progress', `Connecting to ${host}:${port} on launch…`);
    }
    const { spawn } = require('child_process');
    const proc = spawn(java, jvmArgs, {
      cwd:   dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // Monitor first 8 seconds — if MC crashes right away, report the error
    let launched = false;
    let errOutput = '';
    proc.stderr.on('data', d => {
      const lines = d.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        errOutput += line + '\n';
        // Forward all stderr to the instance console
        if (!event.sender.isDestroyed()) event.sender.send('instance-console-log', inst.id, line);
        if (/Exception|Error:|FATAL|Caused by/.test(line)) {
          send('progress', '[MC] ' + line.trim().slice(0, 120));
        }
      }
    });
    proc.stdout.on('data', d => {
      const lines = d.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        if (!event.sender.isDestroyed()) event.sender.send('instance-console-log', inst.id, line);
        if (!launched) send('progress', '[MC] ' + line.trim().slice(0, 120));
      }
    });

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Still alive after 8s → MC launched successfully
        launched = true;
        // Stop listening but DON'T destroy streams — that would kill the process
        proc.stdout.removeAllListeners('data');
        proc.stderr.removeAllListeners('data');
        proc.removeAllListeners('exit');
        proc.removeAllListeners('error');
        proc.unref();
        send('launched', 'Minecraft is running!');
        resolve();
      }, 8000);

      proc.on('exit', (code) => {
        clearTimeout(timer);
        // Track playtime
        const sessionMinutes = Math.round((Date.now() - playStartTime) / 60000);
        try {
          const m = readInstMeta(inst.id) || {};
          writeInstMeta(inst.id, { ...m, totalPlayMinutes: (m.totalPlayMinutes || 0) + Math.max(sessionMinutes, 0) });
        } catch {}
        if (!launched) {
          const errSnippet = errOutput.slice(-600).trim();
          send('error', `Minecraft exited immediately (code ${code}). ${errSnippet ? 'Error: ' + errSnippet.split('\n').find(l => l.includes('Exception') || l.includes('Error:')) || '' : 'Check App Console for details.'}`);
        }
        resolve();
      });
      proc.on('error', (e) => {
        clearTimeout(timer);
        send('error', 'Failed to start Java: ' + e.message);
        resolve();
      });
    });

    return { success: true, method: 'direct-java', pid: proc.pid };

  } catch(e) {
    console.error('[CraftDock] Instance launch failed:', e);
    send('error', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('instance-list-folder', (_, id, sub) => {
  const dir = path.join(instDir(id), sub);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(n => !n.startsWith('.'))
      .map(name => {
        const p = path.join(dir, name);
        const stat = fs.statSync(p);
        return { name, size: stat.size, mtime: stat.mtimeMs };
      });
  } catch { return []; }
});

ipcMain.handle('instance-download-respack', async (_, id, url, filename, subdir) => {
  const destDir = path.join(instDir(id), subdir);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, filename);
  await downloadFile(url, dest, null, 120000);
  return { success: true, path: dest };
});

ipcMain.handle('instance-toggle-resfile', (_, id, subdir, filename, enable) => {
  const dir = path.join(instDir(id), subdir);
  const src = path.join(dir, filename);
  let dst;
  if (enable) {
    dst = src.endsWith('.disabled') ? src.slice(0, -9) : src;
  } else {
    dst = src.endsWith('.disabled') ? src : src + '.disabled';
  }
  if (src !== dst && fs.existsSync(src)) fs.renameSync(src, dst);
  return { success: true };
});

ipcMain.handle('instance-delete-resfile', (_, id, subdir, filename) => {
  const p = path.join(instDir(id), subdir, filename);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  return { success: true };
});

ipcMain.handle('instance-list-world-tags', () => {
  // Scan craftdock-data/shared-worlds/ subfolders — each is a tag
  if (!fs.existsSync(sharedWorldsDir)) return [];
  try {
    return fs.readdirSync(sharedWorldsDir)
      .filter(n => fs.statSync(path.join(sharedWorldsDir, n)).isDirectory())
      .sort();
  } catch { return []; }
});

// ── Install modpack into an instance (client-side) ────────────────────────
ipcMain.handle('instance-install-modpack', async (event, instId, mrpackUrl) => {
  const dir  = ensureInstance(instId);
  const send = (pct, msg) => {
    if (!event.sender.isDestroyed()) event.sender.send('instance-install-progress', instId, pct, msg);
  };

  try {
    send(2, 'Downloading modpack…');
    const mrpackPath = path.join(dir, '_modpack.mrpack');
    await downloadFile(mrpackUrl, mrpackPath, pct =>
      send(2 + Math.round(pct * 0.18), `Downloading modpack… ${pct}%`)
    );
    send(20, 'Reading modpack index…');

    let zipEntries;
    try { zipEntries = readZipEntries(mrpackPath); }
    catch(e) { throw new Error('Failed to read .mrpack: ' + e.message); }

    const indexBuf = zipEntries.get('modrinth.index.json');
    if (!indexBuf) throw new Error('Invalid .mrpack: missing modrinth.index.json');
    const index = JSON.parse(indexBuf.toString('utf8'));

    const deps       = index.dependencies || {};
    const mcVersion  = deps.minecraft    || '1.21';
    const fabricVer  = deps['fabric-loader'];
    const quiltVer   = deps['quilt-loader'];
    const forgeVer   = deps['forge'];
    const neoforgeVer= deps['neoforge'];

    let loader = '', loaderVersion = '';
    if      (fabricVer)   { loader = 'fabric';   loaderVersion = fabricVer; }
    else if (quiltVer)    { loader = 'quilt';    loaderVersion = quiltVer; }
    else if (neoforgeVer) { loader = 'neoforge'; loaderVersion = neoforgeVer; }
    else if (forgeVer)    { loader = 'forge';    loaderVersion = forgeVer; }

    send(22, `MC ${mcVersion}${loader ? ' · ' + loader + ' ' + loaderVersion : ''}`);

    // Update instance metadata
    const existing = readInstMeta(instId) || {};
    writeInstMeta(instId, { ...existing, mcVersion, loader, loaderVersion: loaderVersion || null, downloadStatus: 'installing' });

    // Extract overrides/ into instance dir
    send(24, 'Extracting overrides…');
    let overrideCount = 0;
    for (const [entryName, buf] of zipEntries) {
      let destRel = null;
      if (entryName.startsWith('overrides/'))            destRel = entryName.slice('overrides/'.length);
      else if (entryName.startsWith('client-overrides/')) destRel = entryName.slice('client-overrides/'.length);
      if (!destRel || !destRel.trim()) continue;
      const dest = path.join(dir, destRel);
      if (!fs.existsSync(path.dirname(dest))) fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      overrideCount++;
    }
    send(30, `Extracted ${overrideCount} override files`);

    // Download mods
    const files = (index.files || []).filter(f => !f.env || f.env.client !== 'unsupported');
    const total = files.length;
    send(32, `Downloading ${total} mods…`);
    let done = 0;
    const BATCH = 8;
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      await Promise.all(batch.map(async mf => {
        const dest = path.join(dir, mf.path.replace(/\//g, path.sep));
        if (!fs.existsSync(path.dirname(dest))) fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (!fs.existsSync(dest)) {
          const urls = mf.downloads || [];
          for (const url of urls) {
            try { await downloadFile(url, dest, null, 120000); break; } catch {}
          }
        }
        done++;
      }));
      send(32 + Math.round((done / total) * 55), `Mods: ${done}/${total}`);
    }

    try { fs.unlinkSync(mrpackPath); } catch {}
    writeInstMeta(instId, { ...readInstMeta(instId), downloadStatus: 'installed' });
    send(100, `Done — ${done} mods installed`);
    return { success: true, mcVersion, loader, loaderVersion, modsInstalled: done };

  } catch(e) {
    send(100, 'Error: ' + e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('shared-worlds-path', () => sharedWorldsDir);

// Fetch available builds for a specific MC version + software
ipcMain.handle('server-get-builds', async (_, software, mcVersion) => {
  try {
    if (software === 'paper' || software === 'spigot') {
      const d = await fetchJsonHttp(`https://api.papermc.io/v2/projects/paper/versions/${mcVersion}`);
      const builds = (d.builds || []).reverse(); // newest first
      return { success: true, builds: builds.map(b => ({ build: b, label: `Build #${b}` })) };
    }
    if (software === 'purpur') {
      const d = await fetchJsonHttp(`https://api.purpurmc.org/v2/purpur/${mcVersion}`);
      const builds = (d.builds?.all || []).reverse();
      return { success: true, builds: builds.map(b => ({ build: b, label: `Build ${b}` })) };
    }
    if (software === 'fabric') {
      const d = await fetchJsonHttp('https://meta.fabricmc.net/v2/versions/loader');
      return { success: true, builds: d.slice(0,30).map(v => ({ build: v.version, label: `${v.version}${v.stable?' (stable)':''}` })) };
    }
    if (software === 'neoforge') {
      const d = await fetchJsonHttp(`https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge`);
      const versions = (d.versions || []).filter(v => v.startsWith(mcVersion.replace(/^1\./,''))).reverse().slice(0,20);
      return { success: true, builds: versions.map(v => ({ build: v, label: v })) };
    }
    if (software === 'forge') {
      const d = await fetchJsonHttp('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
      const prefix = mcVersion + '-';
      const builds = Object.entries(d.promos||{})
        .filter(([k]) => k.startsWith(prefix))
        .map(([k,v]) => ({ build: v, label: `${v} (${k.replace(prefix,'').replace('-',' ')})` }))
        .reverse().slice(0,20);
      return { success: true, builds };
    }
    if (software === 'quilt') {
      const d = await fetchJsonHttp('https://meta.quiltmc.org/v3/versions/loader');
      return { success: true, builds: d.slice(0,20).map(v => ({ build: v.version, label: v.version })) };
    }
    // vanilla — no builds
    return { success: true, builds: [] };
  } catch(e) {
    return { success: false, error: e.message, builds: [] };
  }
});

// ── Install ────────────────────────────────────────────────
ipcMain.handle('server-install', async (event, srv) => {
  // Register human-readable folder name for this server
  registerSlug(srv.id, srv.name || srv.id, serversBase);
  const dir = srvDir(srv.id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
  const send = (pct,msg) => { event.sender.send('server-install-progress',srv.id,pct,msg); forwardToConsoleWindow(srv.id,'server-install-progress',pct,msg); };

  // forceReinstall: delete existing server JAR(s) so they're cleanly re-downloaded
  if (srv.forceReinstall) {
    send(1, 'Removing existing server JAR…');
    for (const jar of ['server.jar','fabric-server-launch.jar','quilt-server-launch.jar','fabric-installer.jar','quilt-installer.jar']) {
      try { const p = path.join(dir,jar); if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    }
  }

  try {
    send(5,'Checking Java...');
    const minJava = requiredJava(srv.version || '1.21');
    const javaInfo = await findBestJava(minJava, srv.javaPath || null);
    if (javaInfo.version < minJava && !srv.javaPath) {
      throw new Error(`Java ${minJava}+ required for MC ${srv.version}. Found Java ${javaInfo.version}. Install from https://adoptium.net`);
    }
    send(8, `Using Java ${javaInfo.version}`);
    send(15,'Resolving download URL...');
    const sw = srv.software;
    let jarUrl;
    if      (sw==='paper')  jarUrl = await resolvePaperUrl(srv.version, srv.build || null);
    else if (sw==='purpur') jarUrl = srv.build
      ? `https://api.purpurmc.org/v2/purpur/${srv.version}/${srv.build}/download`
      : await resolvePurpurUrl(srv.version);
    else if (sw==='spigot') jarUrl = await resolvePaperUrl(srv.version, srv.build || null);
    else if (sw==='fabric') jarUrl = 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar';
    else                    jarUrl = await resolveVanillaUrl(srv.version);

    send(20,'Downloading JAR...');

    if (sw === 'fabric') {
      // ── Fabric: download installer to a separate file so it never
      //   collides with server.jar which the installer downloads itself ──
      const installerPath = path.join(dir, 'fabric-installer.jar');
      send(20, 'Downloading Fabric installer...');
      await downloadFile(jarUrl, installerPath, pct => send(20 + Math.round(pct * 0.45), 'Downloading installer... ' + pct + '%'));

      send(66, 'Running Fabric loader installer...');
      // Remove stub server.jar the Fabric installer creates — we always download it ourselves
      try { fs.unlinkSync(path.join(dir,'server.jar')); } catch {}

      // Step A: Install Fabric loader (WITHOUT -downloadMinecraft)
      await new Promise((resolve, reject) => {
        const args = ['-jar', installerPath, 'server', '-mcversion', srv.version, '-dir', dir];
        send(67, 'java ' + args.slice(1).join(' '));
        const p = spawn(javaInfo.exe, args, { cwd: dir, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
        let output = '', errOut = '';
        const onData = d => { const l=d.toString().trim(); output+=d; if(l) send(68,'[Fabric] '+l.slice(0,100)); };
        p.stdout.on('data', onData);
        p.stderr.on('data', d => { errOut+=d; onData(d); });
        p.on('error', err => reject(new Error('Fabric installer error: '+err.message)));
        p.on('close', code => {
          if (fs.existsSync(path.join(dir,'fabric-server-launch.jar'))) resolve();
          else reject(new Error('Fabric installer failed (exit '+code+').\nstdout: '+output.slice(-500)+'\nstderr: '+errOut.slice(-300)));
        });
      });

      // Step B: Always re-download server.jar (never trust any pre-existing file)
      send(72, 'Downloading Minecraft ' + srv.version + ' server...');
      const srvJarPath = path.join(dir,'server.jar');
      try { fs.unlinkSync(srvJarPath); } catch {}
      const vanillaUrl = await resolveVanillaUrl(srv.version);
      await downloadServerJar(srvJarPath, vanillaUrl,
        pct => send(72 + Math.round(pct * 0.26), 'Downloading Minecraft ' + srv.version + '... ' + pct + '%'), send);
    } else {
      // All other software: download directly to server.jar
      const jarPath = path.join(dir, 'server.jar');
      await downloadServerJar(jarPath, jarUrl, pct => send(20 + Math.round(pct * 0.5), 'Downloading... ' + pct + '%'), send);
    }
    send(75,'Writing eula.txt...');
    fs.writeFileSync(path.join(dir,'eula.txt'),'eula=true\n');
    send(82,'Writing server.properties...');
    const props = srv.properties||{};
    const lines = Object.entries({...props,'server-port':String(srv.port||25565),'server-ip':srv.ip==='0.0.0.0'?'':srv.ip}).map(([k,v])=>k+'='+v).join('\n');
    fs.writeFileSync(path.join(dir,'server.properties'),lines+'\n');
    ['fabric','forge','neoforge','quilt'].includes(sw) && fs.mkdirSync(path.join(dir,'mods'),{recursive:true});
    ['paper','spigot','purpur','bukkit'].includes(sw)  && fs.mkdirSync(path.join(dir,'plugins'),{recursive:true});
    send(100,'Installation complete!');
    event.sender.send('server-status-change',srv.id,'stopped');
    return {success:true};
  } catch(e) {
    event.sender.send('server-status-change',srv.id,'error');
    return {success:false,error:e.message};
  }
});

// ═══════════════════════════════════════════════════════════
//  MODPACK SERVER INSTALL  (.mrpack → new server)
// ═══════════════════════════════════════════════════════════
ipcMain.handle('server-install-modpack', async (event, srv, mrpackUrl) => {
  registerSlug(srv.id, srv.name || srv.id, serversBase);
  const dir  = srvDir(srv.id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const send = (pct, msg) => { event.sender.send('server-install-progress', srv.id, pct, msg); forwardToConsoleWindow(srv.id,'server-install-progress',pct,msg); };

  try {
    // ── 1. Download the .mrpack ──────────────────────────────
    send(2, 'Downloading modpack…');
    const mrpackPath = path.join(dir, '_modpack.mrpack');
    await downloadFile(mrpackUrl, mrpackPath, pct =>
      send(2 + Math.round(pct * 0.15), `Downloading modpack… ${pct}%`)
    );
    send(17, 'Reading modpack index…');

    // ── 2. Parse modrinth.index.json (using built-in zip reader) ──
    let zipEntries;
    try {
      zipEntries = readZipEntries(mrpackPath);
    } catch(zipErr) {
      throw new Error(`Failed to read .mrpack file: ${zipErr.message}`);
    }
    const indexBuf = zipEntries.get('modrinth.index.json');
    if (!indexBuf) throw new Error('Invalid .mrpack: missing modrinth.index.json');
    const index = JSON.parse(indexBuf.toString('utf8'));
    // index.dependencies: { minecraft, fabric-loader? forge? neoforge? quilt-loader? }
    const deps        = index.dependencies || {};
    const mcVersion   = deps.minecraft || srv.version || '1.21';
    const fabricVer   = deps['fabric-loader'];
    const quiltVer    = deps['quilt-loader'];
    const forgeVer    = deps['forge'];
    const neoforgeVer = deps['neoforge'];

    // Determine loader
    let loader = 'fabric';
    if      (neoforgeVer) loader = 'neoforge';
    else if (forgeVer)    loader = 'forge';
    else if (quiltVer)    loader = 'quilt';
    else if (fabricVer)   loader = 'fabric';

    send(18, `MC ${mcVersion} · ${loader} — checking Java…`);

    // ── 3. Check Java ────────────────────────────────────────
    const minJava  = requiredJava(mcVersion);
    const javaInfo = await findBestJava(minJava, srv.javaPath || null);
    if (javaInfo.version < minJava && !srv.javaPath) {
      throw new Error(`Java ${minJava}+ required for MC ${mcVersion}. Found Java ${javaInfo.version}. Install from https://adoptium.net`);
    }
    send(20, `Java ${javaInfo.version} ✓ — installing ${loader} server…`);

    // ── 4. Install server software ───────────────────────────
    if (loader === 'fabric' || loader === 'quilt') {
      const installerUrl = loader === 'fabric'
        ? 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar'
        : 'https://quiltmc.org/api/v1/download-latest-installer/java-universal';
      const installerPath = path.join(dir, `${loader}-installer.jar`);
      await downloadFile(installerUrl, installerPath, pct =>
        send(20 + Math.round(pct * 0.2), `Downloading ${loader} installer… ${pct}%`)
      );
      send(40, `Running ${loader} loader installer…`);
      // Step A: Install Fabric loader WITHOUT -downloadMinecraft
      // Remove stub server.jar the installer may create
      try { fs.unlinkSync(path.join(dir,'server.jar')); } catch {}
      await new Promise((resolve, reject) => {
        const args = ['-jar', installerPath, 'server', '-mcversion', mcVersion, '-dir', dir];
        if (loader === 'fabric' && fabricVer) args.push('-loader', fabricVer);
        if (loader === 'quilt'  && quiltVer)  args.push('-loader', quiltVer);
        const p = spawn(javaInfo.exe, args, { cwd: dir, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
        let out = '', err = '';
        const onLine = d => { const l=d.toString().trim(); out+=d; if(l) send(42,`[${loader}] ${l.slice(0,100)}`); };
        p.stdout.on('data', onLine);
        p.stderr.on('data', d => { err+=d; onLine(d); });
        p.on('error', e => reject(new Error(`Could not run ${loader} installer: ${e.message}`)));
        p.on('close', code => {
          if (fs.existsSync(path.join(dir,`${loader}-server-launch.jar`))) resolve();
          else reject(new Error(`${loader} installer failed (exit ${code}).\nstdout: ${out.slice(-500)}\nstderr: ${err.slice(-300)}`));
        });
      });

      // Step B: Always download server.jar ourselves — never trust installer's placeholder
      send(44, `Downloading Minecraft ${mcVersion} server…`);
      const mpFabricJar = path.join(dir, 'server.jar');
      try { fs.unlinkSync(mpFabricJar); } catch {}
      const mpFabricVanillaUrl = await resolveVanillaUrl(mcVersion);
      await downloadServerJar(mpFabricJar, mpFabricVanillaUrl,
        pct => send(44 + Math.round(pct * 0.11), `Downloading Minecraft ${mcVersion}… ${pct}%`), send);
    } else if (loader === 'forge' || loader === 'neoforge') {
      // Forge/NeoForge: use the installer
      const loaderVersion = forgeVer || neoforgeVer;
      let installerUrl;
      if (loader === 'neoforge') {
        installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
      } else {
        installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${loaderVersion}/forge-${mcVersion}-${loaderVersion}-installer.jar`;
      }
      const installerPath = path.join(dir, `${loader}-installer.jar`);
      send(22, `Downloading ${loader} installer…`);
      await downloadFile(installerUrl, installerPath, pct =>
        send(22 + Math.round(pct * 0.2), `Downloading ${loader} installer… ${pct}%`)
      );
      send(42, `Running ${loader} installer (this may take a minute)…`);
      await new Promise((resolve, reject) => {
        const args = ['-jar', installerPath, '--installServer'];
        const p = spawn(javaInfo.exe, args, { cwd: dir, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
        let out = '', err = '';
        p.stdout.on('data', d => { out += d; send(44, `[${loader}] ${d.toString().trim().slice(0, 80)}`); });
        p.stderr.on('data', d => { err += d; });
        p.on('error', e => reject(new Error(`Could not run ${loader} installer: ${e.message}`)));
        p.on('close', code => {
          // Forge creates a run script; check for it or server.jar
          const hasSrv = fs.existsSync(path.join(dir, 'server.jar'))
                      || fs.readdirSync(dir).some(f => f.startsWith('forge-') && f.endsWith('.jar') && !f.includes('installer'))
                      || fs.readdirSync(dir).some(f => f.startsWith('neoforge-') && f.endsWith('.jar') && !f.includes('installer'));
          if (hasSrv) resolve();
          else reject(new Error(`${loader} installer failed (exit ${code}).\n${out.slice(-400)}\n${err.slice(-200)}`));
        });
      });
    } else {
      // Vanilla fallback
      const vanillaUrl  = await resolveVanillaUrl(mcVersion);
      const mpVanillaJar = path.join(dir, 'server.jar');
      await downloadServerJar(mpVanillaJar, vanillaUrl,
        pct => send(20 + Math.round(pct * 0.3), `Downloading MC ${mcVersion}… ${pct}%`), send);
    }

    // ── 5. Create mods/ dir ──────────────────────────────────
    const modsDir = path.join(dir, 'mods');
    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });

    // ── 6. Download mod files from index ────────────────────
    const files = (index.files || []).filter(f => {
      // Skip client-only files
      const env = f.env || {};
      return env.server !== 'unsupported';
    });
    send(55, `Downloading ${files.length} mod files…`);
    const failedFiles = [];
    let done = 0;
    // Download up to 4 files concurrently
    const queue = [...files];
    const workers = Array.from({ length: Math.min(4, files.length || 1) }, async () => {
      while (queue.length) {
        const file = queue.shift();
        const dest = path.join(dir, file.path.replace(/\//g, path.sep));
        const destDir = path.dirname(dest);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        // Try each download URL in order, first success wins
        let lastErr = null;
        let downloaded = false;
        for (const url of (file.downloads || [])) {
          try {
            await downloadFile(url, dest, null, 90000);
            downloaded = true;
            break;
          } catch(e) {
            lastErr = e;
          }
        }
        if (!downloaded) {
          failedFiles.push({ path: file.path, error: lastErr?.message || 'no URLs' });
          send(55 + Math.round((done / Math.max(files.length, 1)) * 30),
            `[WARN] Failed: ${path.basename(file.path)} — ${lastErr?.message?.slice(0,60)}`);
        }
        done++;
        if (downloaded) {
          send(
            55 + Math.round((done / Math.max(files.length, 1)) * 30),
            `Mods: ${done}/${files.length} — ${path.basename(file.path)}`
          );
        }
      }
    });
    await Promise.all(workers);
    if (failedFiles.length > 0) {
      // Log failures but don't abort — partial install is still useful
      console.warn(`[CraftDock] ${failedFiles.length} mod(s) failed to download:`,
        failedFiles.map(f => f.path).join(', '));
      send(85, `⚠ ${failedFiles.length} mod(s) failed to download — install may be incomplete`);
    }

    // ── 7. Extract overrides (using built-in zip reader) ───────
    send(87, 'Applying overrides…');
    for (const [entryName, entryData] of zipEntries.entries()) {
      for (const prefix of ['overrides/', 'server-overrides/']) {
        if (entryName.startsWith(prefix)) {
          const rel = entryName.slice(prefix.length);
          if (!rel || rel.endsWith('/')) continue; // skip directories
          const dest = path.join(dir, rel.replace(/\//g, path.sep));
          const destDir = path.dirname(dest);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          fs.writeFileSync(dest, entryData);
        }
      }
    }

    // ── 8. Write eula + server.properties ───────────────────
    send(92, 'Writing eula.txt…');
    fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
    send(95, 'Writing server.properties…');
    const props = srv.properties || {};
    const lines = Object.entries({
      ...props,
      'server-port': String(srv.port || 25565),
      'server-ip':   srv.ip === '0.0.0.0' ? '' : (srv.ip || '')
    }).map(([k, v]) => `${k}=${v}`).join('\n');
    fs.writeFileSync(path.join(dir, 'server.properties'), lines + '\n');

    // ── 9. Clean up temp mrpack ──────────────────────────────
    try { fs.unlinkSync(mrpackPath); } catch {}

    send(100, 'Modpack installed!');
    event.sender.send('server-status-change', srv.id, 'stopped');
    return { success: true, mcVersion, loader, failedFiles };
  } catch(e) {
    event.sender.send('server-status-change', srv.id, 'error');
    return { success: false, error: e.message };
  }
});

// ═══════════════════════════════════════════════════════════
//  JAVA AUTO-DETECTION
// ═══════════════════════════════════════════════════════════

// Returns minimum Java major version required for a given MC version string
function requiredJava(mcVersion) {
  const [, minor] = mcVersion.split('.').map(Number);
  if (minor >= 21) return 21;
  if (minor >= 17) return 17;
  if (minor >= 16) return 11;
  return 8;
}

// Try running `java -version` at a given path, return major version or 0
async function probeJava(javaExe) {
  return new Promise(resolve => {
    const p = spawn(javaExe, ['-version'], { stdio: ['ignore','pipe','pipe'], windowsHide: true, shell: false });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => out += d);   // java -version writes to stderr
    p.on('error', () => resolve(0));
    p.on('close', () => {
      const m = out.match(/version "(?:1\.(\d+)|(\d+))/);
      if (!m) { resolve(0); return; }
      resolve(parseInt(m[1] || m[2], 10));
    });
  });
}

// Scan common install locations and return the best java executable
// preferredExe: optional path from per-server override — used first if valid
async function findBestJava(minVersion, preferredExe) {
  const isWin = process.platform === 'win32';
  const exe   = isWin ? 'java.exe' : 'java';

  // 0a. Per-server preferred exe (highest priority)
  if (preferredExe && typeof preferredExe === 'string') {
    try {
      const pExists = preferredExe === 'java' || fs.existsSync(preferredExe);
      if (pExists) {
        const ver = await probeJava(preferredExe);
        if (ver > 0) {
          if (ver < minVersion) {
            console.warn(`[CraftDock] Server Java override (${preferredExe} v${ver}) is below required ${minVersion} — using anyway per user choice`);
          }
          return { exe: preferredExe, version: ver, source: 'server-override' };
        }
      }
    } catch(_) {}
  }

  // 0b. Global user override stored in data
  try {
    const overrideFile = path.join(dataDir, 'craftdock_java_override.json');
    if (fs.existsSync(overrideFile)) {
      const override = JSON.parse(fs.readFileSync(overrideFile, 'utf8'));
      if (override && override.path && fs.existsSync(override.path)) {
        const ver = await probeJava(override.path);
        if (ver > 0) return { exe: override.path, version: ver, source: 'global-override' };
      }
    }
  } catch(_) {}

  // Build candidate list
  const candidates = [];

  // 1. JAVA_HOME
  if (process.env.JAVA_HOME) {
    candidates.push(path.join(process.env.JAVA_HOME, 'bin', exe));
  }

  // 2. Common Windows install roots
  if (isWin) {
    const roots = [
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Java',
      'C:\\Program Files\\BellSoft',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files\\Zulu',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium') : '',
    ].filter(Boolean);

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      const entries = fs.readdirSync(root).sort().reverse(); // newest first (higher version)
      for (const entry of entries) {
        candidates.push(path.join(root, entry, 'bin', exe));
      }
    }
  }

  // 3. Common macOS / Linux paths
  if (!isWin) {
    const roots = [
      '/usr/lib/jvm',
      '/Library/Java/JavaVirtualMachines',
      '/opt/homebrew/opt',
    ];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      const entries = fs.readdirSync(root).sort().reverse();
      for (const entry of entries) {
        // macOS: /Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java
        candidates.push(path.join(root, entry, 'Contents', 'Home', 'bin', exe));
        candidates.push(path.join(root, entry, 'bin', exe));
      }
    }
    candidates.push('/usr/bin/java');
  }

  // 4. Always try plain 'java' (PATH) as last resort
  candidates.push('java');

  // Probe each — pick first that meets minVersion, or best we find
  let bestExe = null;
  let bestVer = 0;

  for (const cand of candidates) {
    if (typeof cand === 'string' && cand !== 'java' && !fs.existsSync(cand)) continue;
    const ver = await probeJava(cand);
    if (ver >= minVersion) return { exe: cand, version: ver }; // good enough — use it
    if (ver > bestVer) { bestVer = ver; bestExe = cand; }
  }

  if (bestExe) return { exe: bestExe, version: bestVer, warning: `Java ${bestVer} found but MC needs ${minVersion}+` };
  return { exe: 'java', version: 0, warning: 'Java not found — install from https://adoptium.net' };
}

// ── Start ──────────────────────────────────────────────────
ipcMain.handle('server-start', async (event, srv) => {
  const id  = srv.id;
  const dir = srvDir(id);
  const log = (msg) => { if (!event.sender.isDestroyed()) event.sender.send('server-log', id, msg); forwardToConsoleWindow(id,'server-log',msg); };
  const setStatus = (s) => { if (!event.sender.isDestroyed()) event.sender.send('server-status-change', id, s); forwardToConsoleWindow(id,'server-status-change',s); };

  if (runningServers.has(id)) return { success: false, error: 'Already running' };

  // ── Always ensure eula is accepted ──────────────────────
  fs.writeFileSync(
    path.join(dir, 'eula.txt'),
    '#Auto-accepted by CraftDock\neula=true\n'
  );

  // ── Find correct jar ──────────────────────────────────────
  let jarName = srv.jarName || 'server.jar';
  let jarPath = path.join(dir, jarName);
  const fabricLaunch = path.join(dir, 'fabric-server-launch.jar');
  if (srv.software === 'fabric' && fs.existsSync(fabricLaunch)) jarPath = fabricLaunch;

  if (!fs.existsSync(jarPath)) {
    log('[ERROR] ' + jarName + ' not found. Please run Install first.');
    return { success: false, error: jarName + ' not found' };
  }

  // ── Detect correct Java version ───────────────────────────
  const minJava = requiredJava(srv.version || '1.21');
  log(`[CraftDock] MC ${srv.version} requires Java ${minJava}+. Searching...`);
  const java = await findBestJava(minJava, srv.javaPath || null);

  if (java.warning) log(`[CraftDock] ${java.warning}`);
  log(`[CraftDock] Using Java ${java.version}: ${java.exe}`);

  if (java.version > 0 && java.version < minJava) {
    log(`[ERROR] Java ${java.version} is too old for Minecraft ${srv.version} (needs Java ${minJava}+).`);
    log(`[ERROR] Download Java ${minJava}+ from https://adoptium.net and install it.`);
    log(`[ERROR] After installing, click Start again.`);
    return { success: false, error: `Java ${java.version} too old, need ${minJava}+` };
  }

  // ── Build JVM args ────────────────────────────────────────
  const extra = (srv.jvmFlags || '').split(' ').filter(Boolean);
  const args  = [
    `-Xms${srv.ramMin || 512}M`,
    `-Xmx${srv.ramMax || 2048}M`,
    ...extra,
    '-jar', jarPath,
    '--nogui'
  ];

  log(`[CraftDock] Starting: ${java.exe} ${args.join(' ')}`);
  log(`[CraftDock] Working dir: ${dir}`);

  let proc;
  try {
    proc = spawn(java.exe, args, {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (spawnErr) {
    log('[ERROR] Failed to spawn process: ' + spawnErr.message);
    setStatus('stopped');
    return { success: false, error: spawnErr.message };
  }

  runningServers.set(id, proc);
  setStatus('running');

  proc.stdout.on('data', d => log(d.toString()));
  proc.stderr.on('data', d => log(d.toString()));

  proc.on('error', err => {
    log('[ERROR] ' + err.message);
    runningServers.delete(id);
    setStatus('stopped');
  });

  proc.on('close', (code, signal) => {
    runningServers.delete(id);
    log(`[CraftDock] Server stopped (exit code ${code}${signal ? ', signal: ' + signal : ''})`);
    setStatus('stopped');
  });

  return { success: true };
});

// ── Stop / Command ─────────────────────────────────────────
ipcMain.handle('server-stop', (_,id) => {
  const p=runningServers.get(id); if(!p) return {success:false};
  p.stdin.write('stop\n'); setTimeout(()=>{if(runningServers.has(id))p.kill('SIGTERM');},10000);
  return {success:true};
});
ipcMain.handle('server-command', (_,id,cmd) => {
  const p=runningServers.get(id); if(!p) return {success:false};
  p.stdin.write(cmd+'\n'); return {success:true};
});
ipcMain.handle('server-write-props', (_,id,props) => {
  fs.writeFileSync(path.join(srvDir(id),'server.properties'),Object.entries(props).map(([k,v])=>k+'='+v).join('\n')+'\n');
  return {success:true};
});
ipcMain.handle('server-pick-jar', async () => {
  const r=await dialog.showOpenDialog(mainWindow,{title:'Select JAR',filters:[{name:'JAR',extensions:['jar']}],properties:['openFile']});
  if(r.canceled||!r.filePaths.length) return null;
  return {filePath:r.filePaths[0],fileName:path.basename(r.filePaths[0])};
});
// ── Windows-safe recursive delete with retry ──────────────────────────────
// Windows keeps file handles open after process exit; plain rmSync fails with ENOTEMPTY.
function rmSafe(dir, retries = 5, delayMs = 400) {
  if (!fs.existsSync(dir)) return;
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      return;
    } catch(e) {
      lastErr = e;
      if (i < retries - 1) { const end = Date.now() + delayMs; while (Date.now() < end) {} }
    }
  }
  // Last resort: delete files individually then rmdir
  try {
    const rmRecursive = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        try { if (ent.isDirectory()) rmRecursive(p); else fs.unlinkSync(p); } catch {}
      }
      try { fs.rmdirSync(d); } catch {}
    };
    rmRecursive(dir);
  } catch {}
  if (fs.existsSync(dir)) throw new Error('Could not delete ' + path.basename(dir) + ': ' + (lastErr?.message||'unknown'));
}

ipcMain.handle('server-delete', (_,id) => {
  // Kill running server first so Windows releases file handles
  const proc = runningServers.get(id);
  if (proc) {
    try { proc.kill('SIGKILL'); } catch {}
    runningServers.delete(id);
    const end = Date.now() + 600; while (Date.now() < end) {} // wait 600ms for OS
  }
  try { rmSafe(srvDir(id)); } catch(e) { return { success: false, error: e.message }; }
  return { success: true };
});
ipcMain.handle('server-remove-file', (_, id, sub, f) => {
  try {
    // Try exact name first, then .disabled variant
    const base = path.join(srvDir(id), sub, f);
    const dis  = base + '.disabled';
    if (fs.existsSync(base)) fs.unlinkSync(base);
    else if (fs.existsSync(dis)) fs.unlinkSync(dis);
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
});

// Rename .jar <-> .jar.disabled to enable/disable without deleting
ipcMain.handle('server-toggle-file', (_, id, sub, fileName, enable) => {
  try {
    const dir      = path.join(srvDir(id), sub);
    const active   = path.join(dir, fileName);
    const disabled = path.join(dir, fileName + '.disabled');
    if (enable) {
      // Enable: rename .jar.disabled -> .jar
      if (fs.existsSync(disabled)) fs.renameSync(disabled, active);
      else if (fs.existsSync(active)) { /* already enabled, fine */ }
      else return { success: false, error: 'File not found: ' + fileName };
    } else {
      // Disable: rename .jar -> .jar.disabled
      if (fs.existsSync(active)) fs.renameSync(active, disabled);
      else if (fs.existsSync(disabled)) { /* already disabled */ }
      else return { success: false, error: 'File not found: ' + fileName };
    }
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
});

// ── CurseForge mods (classId=6) ────────────────────────────
ipcMain.handle('curseforge-mods-search', async (_,query='',gameVersion='',modLoaderType='') => {
  try { const d=await cfSearch(432,6,query,gameVersion,modLoaderType,20); return {success:true,data:d.data||[]}; }
  catch(e) { return {success:false,error:e.message}; }
});

// ── Java detection IPC ─────────────────────────────────────
ipcMain.handle('java-detect', async () => {
  const versions = [21, 17, 11, 8];
  const results  = [];
  for (const minVer of versions) {
    const info = await findBestJava(minVer);
    if (info.version >= minVer) {
      if (!results.find(r => r.exe === info.exe)) results.push(info);
    }
  }
  const plain = await probeJava('java');
  if (plain > 0 && !results.find(r => r.exe === 'java')) {
    results.push({ exe: 'java', version: plain });
  }
  return results;
});

// Scan ALL java installs across all common paths — for the picker UI
async function detectAllJava() {
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'java.exe' : 'java';
  const allCandidates = new Set();

  // Global override
  try {
    const ov = path.join(dataDir, 'craftdock_java_override.json');
    if (fs.existsSync(ov)) {
      const p = JSON.parse(fs.readFileSync(ov,'utf8'))?.path;
      if (p && fs.existsSync(p)) allCandidates.add(p);
    }
  } catch {}

  if (process.env.JAVA_HOME) allCandidates.add(path.join(process.env.JAVA_HOME,'bin',exe));

  if (isWin) {
    const roots = [
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Java',
      'C:\\Program Files\\BellSoft',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\OpenJDK',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA,'Programs','Eclipse Adoptium') : null,
    ].filter(Boolean);
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root)) {
        const p = path.join(root,entry,'bin',exe);
        if (fs.existsSync(p)) allCandidates.add(p);
      }
    }
  } else {
    const roots = [
      '/usr/lib/jvm',
      '/Library/Java/JavaVirtualMachines',
      '/opt/homebrew/opt',
      '/opt/java',
    ];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root)) {
        for (const sub of ['Contents/Home/bin/java','bin/java','jre/bin/java']) {
          const p = path.join(root,entry,sub);
          if (fs.existsSync(p)) allCandidates.add(p);
        }
      }
    }
    allCandidates.add('/usr/bin/java');
    allCandidates.add('/usr/local/bin/java');
  }
  allCandidates.add('java'); // PATH fallback

  const results = [];
  for (const cand of allCandidates) {
    const ver = await probeJava(cand);
    if (ver > 0 && !results.find(r => r.exe === cand)) {
      const parts = cand.split(isWin ? '\\' : '/');
      const jdkDir = parts.length >= 3 ? parts[parts.length - 3] : '';
      const label = jdkDir || (cand === 'java' ? 'System PATH' : path.dirname(path.dirname(cand)));
      results.push({ exe: cand, version: ver, label });
    }
  }
  return results.sort((a,b) => b.version - a.version);
}

ipcMain.handle('java-detect-all', () => detectAllJava());

// Alias used by instance Java picker
ipcMain.handle('java-scan', () => detectAllJava());

ipcMain.handle('java-probe', async (_, exePath) => {
  const ver = await probeJava(exePath);
  return { version: ver, exe: exePath };
});

ipcMain.handle('dialog-open-java', async () => {
  const isWin = process.platform === 'win32';
  const filters = isWin
    ? [{ name: 'Java Executable', extensions: ['exe'] }, { name: 'All Files', extensions: ['*'] }]
    : [{ name: 'Java Executable', extensions: ['*'] }];
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Java Executable',
    filters,
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

// ── Popout console window ──────────────────────────────────
const consoleWindows = new Map(); // serverId → BrowserWindow

ipcMain.handle('open-console-window', (_, srvId, srvName, srvStatus) => {
  // If already open, just focus it
  if (consoleWindows.has(srvId) && !consoleWindows.get(srvId).isDestroyed()) {
    consoleWindows.get(srvId).focus();
    return { success: true };
  }

  const win = new BrowserWindow({
    width: 900, height: 600, minWidth: 600, minHeight: 300,
    title: srvName + ' — Console',
    frame: false,
    backgroundColor: '#0d1117',
    skipTaskbar: false,       // show in taskbar so user can alt-tab to it
    parent: mainWindow || undefined, // child of main — won't trigger app quit when closed
    webPreferences: {
      preload: path.join(__dirname, 'console-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'src', 'console-window.html'));
  consoleWindows.set(srvId, win);
  win.on('closed', () => consoleWindows.delete(srvId));

  // Send init once ready
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('console-init', srvId, srvName, srvStatus);
  });

  return { success: true };
});

// Forward log/status/progress events to any open console window for this server
function forwardToConsoleWindow(srvId, channel, ...args) {
  const win = consoleWindows.get(srvId);
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, srvId, ...args);
  }
}

ipcMain.handle('java-set-override', (_, javaPath) => {
  const overrideFile = path.join(dataDir, 'craftdock_java_override.json');
  if (!javaPath) {
    if (fs.existsSync(overrideFile)) fs.unlinkSync(overrideFile);
  } else {
    fs.writeFileSync(overrideFile, JSON.stringify({ path: javaPath }));
  }
  return { success: true };
});

// ═══════════════════════════════════════════════════════════
//  PLAYERS & JSON FILE IPC
// ═══════════════════════════════════════════════════════════

ipcMain.handle('server-read-json', (_, id, filename) => {
  try {
    const p = path.join(srvDir(id), filename);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return []; }
});

ipcMain.handle('server-patch-json', (_, id, filename, serializedFn) => {
  // We can't pass functions over IPC, so we accept the patched array directly
  // (renderer sends the result, not a fn — see preload)
  try {
    const p = path.join(srvDir(id), filename);
    fs.writeFileSync(p, JSON.stringify(serializedFn, null, 2));
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
});

// Get online players via parsing the last "list" output cached in memory
const playerListCache = new Map(); // srvId → string[]
ipcMain.handle('server-get-online-players', (_, id) => {
  return playerListCache.get(id) || null;
});
// Let main process also update cache from stdout parsing
// This is done inside the start handler's stdout listener below

// ═══════════════════════════════════════════════════════════
//  BACKUP IPC
// ═══════════════════════════════════════════════════════════
const { execFile } = require('child_process');
// ── Built-in ZIP writer (no archiver dependency) ────────────
function createZipFromDir(sourceDir, destZipPath) {
  const zlib = require('zlib');
  // Walk directory recursively
  function walk(dir, base) {
    const entries = [];
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel  = base ? base + '/' + name : name;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) entries.push(...walk(full, rel));
      else entries.push({ full, rel });
    }
    return entries;
  }
  const files = walk(sourceDir, '');
  // Build local file entries
  const localHeaders = [];
  const cdEntries    = [];
  let offset = 0;

  for (const { full, rel } of files) {
    const data       = fs.readFileSync(full);
    const compressed = zlib.deflateRawSync(data, { level: 6 });
    const nameBytes  = Buffer.from(rel, 'utf8');
    const crc = (() => {
      let c = 0xFFFFFFFF;
      for (const b of data) {
        c ^= b;
        for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
      }
      return (c ^ 0xFFFFFFFF) >>> 0;
    })();

    const lh = Buffer.alloc(30 + nameBytes.length);
    lh.writeUInt32LE(0x04034b50, 0);   // local file header sig
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0, 6);             // flags
    lh.writeUInt16LE(8, 8);             // compression: deflate
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); // mod time/date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBytes.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBytes.copy(lh, 30);

    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);   // central dir sig
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBytes.copy(cd, 46);

    localHeaders.push(lh, compressed);
    cdEntries.push(cd);
    offset += lh.length + compressed.length;
  }

  const cdBuf   = Buffer.concat(cdEntries);
  const eocd    = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(cdEntries.length, 8);
  eocd.writeUInt16LE(cdEntries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(destZipPath, Buffer.concat([...localHeaders, cdBuf, eocd]));
}

function backupDir(id) { return path.join(srvDir(id), 'backups'); }

ipcMain.handle('server-list-backups', (_, id) => {
  const dir = backupDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.zip'))
    .map(f => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      return {
        filename:  f,
        name:      f.replace(/\.zip$/, ''),
        sizeMB:    (stat.size / 1024 / 1024).toFixed(1),
        createdAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
});

ipcMain.handle('server-create-backup', async (_, id) => {
  const dir      = srvDir(id);
  const worldDir = path.join(dir, 'world');
  if (!fs.existsSync(worldDir)) return { success: false, error: 'World folder not found (server may not have run yet)' };

  const bkpDir = backupDir(id);
  if (!fs.existsSync(bkpDir)) fs.mkdirSync(bkpDir, { recursive: true });

  const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name     = `world-backup-${ts}`;
  const destPath = path.join(bkpDir, name + '.zip');

  // Create backup zip using built-in zip writer (no external dependencies)
  const tmpDir = path.join(bkpDir, '_tmp_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    // Copy world folder into temp dir
    const copyDir = (src, dest) => {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name), d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDir(s, d);
        else fs.copyFileSync(s, d);
      }
    };
    copyDir(worldDir, path.join(tmpDir, 'world'));
    ['world_nether', 'world_the_end'].forEach(d => {
      const extra = path.join(dir, d);
      if (fs.existsSync(extra)) copyDir(extra, path.join(tmpDir, d));
    });
    createZipFromDir(tmpDir, destPath);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const stat = fs.statSync(destPath);
  return { success: true, name, filename: name + '.zip', sizeMB: (stat.size/1024/1024).toFixed(1) };
});

ipcMain.handle('server-restore-backup', async (event, id, filename) => {
  const destPath = path.join(backupDir(id), filename);
  if (!fs.existsSync(destPath)) return { success: false, error: 'Backup file not found' };

  // Stop server if running
  const proc = runningServers.get(id);
  if (proc) {
    proc.stdin.write('stop\n');
    await new Promise(r => setTimeout(r, 3000));
    if (runningServers.has(id)) proc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1000));
  }

  const worldDir = path.join(srvDir(id), 'world');
  // Remove existing world
  if (fs.existsSync(worldDir)) fs.rmSync(worldDir, { recursive: true, force: true });
  ['world_nether', 'world_the_end'].forEach(d => {
    const p = path.join(srvDir(id), d);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  });

  // Extract using built-in zip reader
  try {
    const entries = readZipEntries(destPath);
    for (const [name, data] of entries.entries()) {
      if (name.endsWith('/')) continue;
      const dest = path.join(srvDir(id), name.replace(/\//g, path.sep));
      const destDir = path.dirname(dest);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(dest, data);
    }
  } catch(e) {
    return { success: false, error: 'Backup restore failed: ' + e.message };
  }

  return { success: true };
});

ipcMain.handle('server-delete-backup', (_, id, filename) => {
  try {
    const p = path.join(backupDir(id), filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
});

// Auto-backup timer map
const autoBackupTimers = new Map();
ipcMain.handle('server-set-backup-config', (event, id, intervalMin, keepCount) => {
  // Clear existing
  if (autoBackupTimers.has(id)) clearInterval(autoBackupTimers.get(id));
  if (!intervalMin || intervalMin <= 0) { autoBackupTimers.delete(id); return { success: true }; }

  const ms = intervalMin * 60 * 1000;
  const timer = setInterval(async () => {
    if (!runningServers.has(id)) return; // only backup when running
    // Flush world to disk
    const proc = runningServers.get(id);
    if (proc) proc.stdin.write('save-all\n');
    await new Promise(r => setTimeout(r, 2000));

    // Create backup
    const result = await new Promise(r => ipcMain.emit('server-create-backup', { sender: { send: ()=>{}, isDestroyed: ()=>false } }, id));
    if (!result?.success) return;

    // Prune old backups if keepCount > 0
    if (keepCount > 0) {
      const dir     = backupDir(id);
      const backups = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(f => f.endsWith('.zip')).map(f => ({ f, t: fs.statSync(path.join(dir,f)).mtime })).sort((a,b)=>b.t-a.t)
        : [];
      for (const old of backups.slice(keepCount)) {
        fs.unlinkSync(path.join(dir, old.f));
      }
    }

    if (!event.sender.isDestroyed()) event.sender.send('backup-created', id, result.name);
  }, ms);

  autoBackupTimers.set(id, timer);
  return { success: true };
});


// Read server.properties as key-value object
ipcMain.handle('server-read-props', (_, id) => {
  try {
    const p = path.join(srvDir(id), 'server.properties');
    if (!fs.existsSync(p)) return {};
    const obj = {};
    fs.readFileSync(p, 'utf8').split('\n').forEach(line => {
      const eq = line.indexOf('=');
      if (eq > 0 && !line.startsWith('#')) {
        obj[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    });
    return obj;
  } catch { return {}; }
});

// ── Reset World ────────────────────────────────────────────
ipcMain.handle('server-reset-world', (_, id, newLevelType, newSeed, bonusChest) => {
  const dir = srvDir(id);
  const worlds = ['world', 'world_nether', 'world_the_end'];
  try {
    for (const w of worlds) {
      const p = path.join(dir, w);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
    // Update server.properties
    const propsPath = path.join(dir, 'server.properties');
    if (fs.existsSync(propsPath)) {
      let content = fs.readFileSync(propsPath, 'utf8');
      const set = (key, val) => {
        const re = new RegExp(`^${key}=.*$`, 'm');
        if (re.test(content)) content = content.replace(re, `${key}=${val}`);
        else content += `\n${key}=${val}`;
      };
      if (newLevelType) set('level-type', newLevelType);
      set('level-seed', newSeed || '');
      set('generate-structures', 'true');
      // bonus chest is a bukkit/spigot feature — write to bukkit.yml if it exists, else no-op
      if (bonusChest) {
        const bukkitYml = path.join(dir, 'bukkit.yml');
        if (fs.existsSync(bukkitYml)) {
          let yml = fs.readFileSync(bukkitYml, 'utf8');
          yml = yml.replace(/spawn-bonus-chest: (true|false)/, 'spawn-bonus-chest: true');
          if (!yml.includes('spawn-bonus-chest')) yml += '\nsettings:\n  spawn-bonus-chest: true\n';
          fs.writeFileSync(bukkitYml, yml);
        }
        // For vanilla: write it into a level.dat equivalent isn't possible without NBT,
        // so we note it in a craftdock metadata file for the user
        const metaPath = path.join(dir, '.craftdock_meta.json');
        const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath,'utf8')) : {};
        meta.bonusChestNextGen = true;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      }
      fs.writeFileSync(propsPath, content);
    }
    return { success: true };
  } catch(e) {
    return { success: false, error: e.message };
  }
});

// ── Copy plugin JAR into server plugins/ folder ────────────
ipcMain.handle('server-copy-mod', async (_, id, srcPath, fileName) => {
  try {
    const modsDir = path.join(srvDir(id), 'mods');
    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
    const dest = path.join(modsDir, fileName);
    if (srcPath && fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, dest);
    }
    return { success: true, dest };
  } catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('server-copy-plugin', async (_, id, srcPath, fileName) => {
  try {
    const pluginsDir = path.join(srvDir(id), 'plugins');
    if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });
    const dest = path.join(pluginsDir, fileName);
    if (srcPath && fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, dest);
    }
    return { success: true, dest };
  } catch(e) { return { success: false, error: e.message }; }
});

// ── Write server-icon.png (base64 data URL → file) ─────────
ipcMain.handle('server-write-mc-icon', async (_, id, dataUrl) => {
  try {
    const dest = path.join(srvDir(id), 'server-icon.png');
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(dest, Buffer.from(base64, 'base64'));
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
});

// ── Pick JAR file dialog ───────────────────────────────────
ipcMain.handle('pick-jar', async () => {
  const { dialog } = require('electron');
  const win = require('electron').BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    title: 'Select Plugin JAR',
    filters: [{ name: 'JAR Files', extensions: ['jar'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  return { filePath, fileName: path.basename(filePath) };
});

// ── List files in server plugins/ folder ──────────────────
ipcMain.handle('server-list-plugins', async (_, id) => {
  try {
    if (!id) return { success: false, error: 'Server ID is required', files: [] };
    const pluginsDir = path.join(srvDir(id), 'plugins');
    if (!fs.existsSync(pluginsDir)) return { success: true, files: [] };
    const files = fs.readdirSync(pluginsDir)
      .filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled'))
      .map(f => {
        const filePath = path.join(pluginsDir, f);
        const stat     = fs.statSync(filePath);
        const disabled = f.endsWith('.jar.disabled');
        // Strip .disabled suffix so the stored name is always the base .jar name
        const name     = disabled ? f.slice(0, -'.disabled'.length) : f;
        return { name, size: stat.size, mtime: stat.mtimeMs, enabled: !disabled };
      });
    return { success: true, files };
  } catch(e) { 
    console.error('[IPC Error] server-list-plugins:', e.message, e.stack);
    return { success: false, error: e.message, files: [] }; 
  }
});

// ── List files in server mods/ folder ────────────────────
ipcMain.handle('server-list-mods', async (_, id) => {
  try {
    const modsDir = path.join(srvDir(id), 'mods');
    if (!fs.existsSync(modsDir)) return { success: true, files: [] };
    const files = fs.readdirSync(modsDir)
      .filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled'))
      .map(f => {
        const stat     = fs.statSync(path.join(modsDir, f));
        const disabled = f.endsWith('.jar.disabled');
        const name     = disabled ? f.slice(0, -'.disabled'.length) : f;
        return { name, size: stat.size, mtime: stat.mtimeMs, enabled: !disabled };
      });
    return { success: true, files };
  } catch(e) { return { success: false, error: e.message, files: [] }; }
});

// ── Download a URL directly into a server subfolder ─────────
ipcMain.handle('server-download-to-folder', async (_, id, url, fileName, subfolder) => {
  try {
    const https = require('https');
    const http  = require('http');
    const targetDir = path.join(srvDir(id), subfolder || 'plugins');
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const dest = path.join(targetDir, fileName.replace(/[/\\?%*:|"<>]/g, '_'));
    await new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(dest);
      client.get(url, { headers: { 'User-Agent': 'CraftDock/0.6.2' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // follow one redirect
          const redir = res.headers.location;
          file.close();
          const c2 = redir.startsWith('https') ? https : http;
          const file2 = fs.createWriteStream(dest);
          c2.get(redir, { headers: { 'User-Agent': 'CraftDock/0.6.2' } }, r2 => {
            r2.pipe(file2);
            file2.on('finish', () => file2.close(resolve));
          }).on('error', reject);
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', reject);
    });
    return { success: true, path: dest };
  } catch(e) { return { success: false, error: e.message }; }
});

// ── Instance servers.dat reader ───────────────────────────
ipcMain.handle('instance-read-servers-dat', async (_, instId) => {
  const gameDir = instDir(instId);
  return await readServersDat(gameDir);
});

// ── Server name → slug update (when server is renamed) ────
ipcMain.handle('register-slug', (_, id, name, type) => {
  const base = type === 'server' ? serversBase : instancesBase;
  const newSlug = slugify(name);
  if (slugMap[id] && slugify(slugMap[id].replace(/_\d+$/, '')) === slugify(newSlug.replace(/_\d+$/, ''))) {
    return { slug: slugMap[id] };
  }
  if (!slugMap[id]) registerSlug(id, name, base);
  return { slug: slugMap[id] || id };
});

// ── IPC: Export instance as modpack file ────────────────────
ipcMain.handle('instance-export', async (_, instId, format) => {
  try {
    const instMeta = readInstMeta(instId);
    if (!instMeta) return { success: false, error: 'Instance not found' };
    const instFolder = instDir(instId);
    const modsPath = path.join(instFolder, 'mods');
    const modFiles = fs.existsSync(modsPath)
      ? fs.readdirSync(modsPath).filter(f => f.endsWith('.jar'))
      : [];

    const name = instMeta.name || 'modpack';
    const mcVersion = instMeta.mcVersion || '1.21.4';
    const loader = (instMeta.loader || 'fabric').toLowerCase();

    if (format === 'cf-zip') {
      // ── CurseForge manifest.zip ──────────────────────────
      const manifest = {
        minecraft: { version: mcVersion, modLoaders: [{ id: `${loader}-latest`, primary: true }] },
        manifestType: 'minecraftModpack',
        manifestVersion: 1,
        name,
        version: '1.0.0',
        author: 'CraftDock',
        files: [],
        overrides: 'overrides',
      };
      const manifestStr = JSON.stringify(manifest, null, 2);

      const { filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Save CurseForge Modpack',
        defaultPath: `${name.replace(/[^a-z0-9_\-]/gi,'_')}-cf.zip`,
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
      });
      if (!filePath) return { success: false, cancelled: true };

      // Build zip with manifest + mod overrides
      const files = [{ name: 'manifest.json', data: Buffer.from(manifestStr) }];
      // Include actual mod jars as overrides/mods/
      for (const f of modFiles) {
        const buf = fs.readFileSync(path.join(modsPath, f));
        files.push({ name: `overrides/mods/${f}`, data: buf });
      }
      writeZipToFile(filePath, files);
      return { success: true, path: filePath };

    } else if (format === 'mrpack') {
      // ── Modrinth .mrpack ─────────────────────────────────
      const index = {
        formatVersion: 1,
        game: 'minecraft',
        versionId: '1.0.0',
        name,
        summary: `Exported from CraftDock`,
        dependencies: { minecraft: mcVersion, [`${loader}-loader`]: '*' },
        files: [],
      };
      const indexStr = JSON.stringify(index, null, 2);
      const { filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Modrinth Pack',
        defaultPath: `${name.replace(/[^a-z0-9_\-]/gi,'_')}.mrpack`,
        filters: [{ name: 'Modrinth Pack', extensions: ['mrpack'] }],
      });
      if (!filePath) return { success: false, cancelled: true };
      const files = [{ name: 'modrinth.index.json', data: Buffer.from(indexStr) }];
      for (const f of modFiles) {
        const buf = fs.readFileSync(path.join(modsPath, f));
        files.push({ name: `overrides/mods/${f}`, data: buf });
      }
      writeZipToFile(filePath, files);
      return { success: true, path: filePath };

    } else if (format === 'cf-code') {
      // ── CF share code (base64 of manifest) ───────────────
      const manifest = {
        minecraft: { version: mcVersion, modLoaders: [{ id: `${loader}-latest`, primary: true }] },
        manifestType: 'minecraftModpack', manifestVersion: 1,
        name, version: '1.0.0', author: 'CraftDock', files: [], overrides: 'overrides',
      };
      const code = Buffer.from(JSON.stringify(manifest)).toString('base64');
      return { success: true, code };

    } else if (format === 'mr-link') {
      // ── Modrinth link ─────────────────────────────────────
      const projectId = instMeta.sourceId || instMeta.projectId;
      const url = projectId
        ? `https://modrinth.com/modpack/${projectId}`
        : `https://modrinth.com/search?q=${encodeURIComponent(name)}&projectType=modpack`;
      return { success: true, url };
    }

    return { success: false, error: 'Unknown format' };
  } catch(e) {
    return { success: false, error: e.message };
  }
});

// ── IPC: Check for CraftDock app updates from GitHub ───────
ipcMain.handle('check-app-update', async () => {
  try {
    const res = await fetchJsonHttp('https://api.github.com/repos/RealGeegamr/CraftDock/releases/latest');
    if (!res?.tag_name) return { success: false, error: 'No releases found' };
    const latestTag = res.tag_name.replace(/^v/, '');
    const current = MAIN_JS_VERSION;
    const hasUpdate = latestTag !== current;
    return {
      success: true,
      current,
      latest: latestTag,
      hasUpdate,
      url: res.html_url || 'https://github.com/RealGeegamr/CraftDock/releases',
      name: res.name || `v${latestTag}`,
      body: res.body || '',
    };
  } catch(e) {
    return { success: false, error: e.message };
  }
});
}

// ── Migration: rename old inst_*/srv_* folders to human-readable slugs ───────
function migrateToSlugFolders() {
  // Scan both instancesBase and serversBase for old-style ID folders
  for (const [base, prefix] of [[instancesBase,'inst_'],[serversBase,'srv_']]) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base)) {
      if (!entry.startsWith(prefix)) continue;
      const oldPath = path.join(base, entry);
      if (!fs.statSync(oldPath).isDirectory()) continue;
      if (slugMap[entry]) continue; // already migrated

      // Read meta to get the human name
      const metaFile = path.join(oldPath, prefix === 'inst_' ? 'instance.json' : 'server.json');
      let name = entry;
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        name = meta.name || entry;
      } catch {
        // server data is stored in the frontend JSON store, not a file
        // fall back to the raw id as name
      }

      const slug = slugify(name);
      // Check uniqueness
      let candidate = slug;
      let suffix = 2;
      const usedFolders = new Set(Object.values(slugMap));
      while (usedFolders.has(candidate) && candidate !== entry) {
        candidate = slug + '_' + suffix++;
      }

      if (candidate !== entry) {
        const newPath = path.join(base, candidate);
        try {
          if (!fs.existsSync(newPath)) {
            fs.renameSync(oldPath, newPath);
            slugMap[entry] = candidate;
            console.log(`[CraftDock] Migrated: ${entry} → ${candidate}`);
          }
        } catch(e) {
          console.warn(`[CraftDock] Migration failed for ${entry}:`, e.message);
        }
      } else {
        // Same name, just register
        slugMap[entry] = candidate;
      }
    }
  }
  saveSlugMap();
}

// Register all handlers and create window
registerIpcHandlers();

app.whenReady().then(() => {
  // ── Purge any safeStorage/DPAPI tokens from disk ──────────
  // safeStorage.decryptString on Electron 40+ Windows throws a FATAL
  // native BoringSSL exception (BAD_DECRYPT) that cannot be caught in JS
  // if the DPAPI key has changed (app moved/updated). We must scrub all
  // "safe:" prefixed tokens from the accounts file BEFORE anything reads
  // them. Affected accounts will need to re-login — this is unavoidable.
  try {
    const accountFile = path.join(dataDir, 'craftdock_accounts.json');
    if (fs.existsSync(accountFile)) {
      const accounts = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
      if (Array.isArray(accounts)) {
        const ENC_FIELDS = ['_minecraftToken','_mcToken','_msAccessToken','_msRefreshToken','minecraftToken','mcToken','msAccessToken','msRefreshToken'];
        let hadSafeTokens = false;
        const cleaned = accounts.map(acct => {
          const out = { ...acct };
          for (const f of ENC_FIELDS) {
            if (typeof out[f] === 'string' && out[f].startsWith('safe:')) {
              delete out[f];   // remove unreadable DPAPI token
              hadSafeTokens = true;
            }
          }
          return out;
        });
        if (hadSafeTokens) {
          fs.writeFileSync(accountFile, JSON.stringify(cleaned, null, 2));
          console.warn('[CraftDock] Purged legacy safeStorage tokens. Affected accounts must re-login.');
        }
      }
    }
  } catch(e) {
    console.warn('[CraftDock] Token purge failed (non-fatal):', e.message);
  }

  // ── Migrate old-style inst_*/srv_* folder names to human-readable slugs ──
  migrateToSlugFolders();

  createWindow();
});
app.on('window-all-closed', () => {
  // Only quit if mainWindow is destroyed — console popouts closing must NOT quit the app.
  if (process.platform !== 'darwin' && (!mainWindow || mainWindow.isDestroyed())) {
    app.quit();
  }
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
