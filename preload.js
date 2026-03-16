const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('craftdock', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),

  // Open URL in system default browser
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // App info
  getElectronVersion: () => ipcRenderer.invoke('get-electron-version'),

  // Microsoft auth — real device code flow via Node (no CORS)
  auth: {
    requestDeviceCode: () => ipcRenderer.invoke('auth-request-device-code'),
    pollToken:         (deviceCode) => ipcRenderer.invoke('auth-poll-token', deviceCode),
    completeLogin:     (msAccessToken) => ipcRenderer.invoke('auth-complete-login', msAccessToken),
  },

  // Persistent key-value store (accounts, instances, servers)
  store: {
    get:    (key)        => ipcRenderer.invoke('store-get',    key),
    set:    (key, value) => ipcRenderer.invoke('store-set',    key, value),
    delete: (key)        => ipcRenderer.invoke('store-delete', key),
  },

  // Skin management
  skins: {
    getAll:     ()     => ipcRenderer.invoke('skins-get-all'),
    save:       (skin) => ipcRenderer.invoke('skins-save',   skin),
    delete:     (id)   => ipcRenderer.invoke('skins-delete', id),
    openPicker: ()     => ipcRenderer.invoke('dialog-open-skin'),
  },

  // CurseForge API
  api: {
  curseforgeSearch: (query, version, loader, classId, sortField) =>
    ipcRenderer.invoke('curseforge-search', query, version, loader, classId, sortField),

  getMinecraftVersions: () =>
    ipcRenderer.invoke('cf-get-mc-versions'),
  },

  // File system helpers
  openFolder:  (p)  => ipcRenderer.invoke('open-folder',    p),
  getDataRoot: ()   => ipcRenderer.invoke('get-data-root'),
});

// Also expose as window.ipc for backwards compatibility
contextBridge.exposeInMainWorld('ipc', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
});

// Server manager bridge
contextBridge.exposeInMainWorld('craftdockServer', {
  getMainVersion:      ()              => ipcRenderer.invoke('get-main-version'),
  openConsoleWindow:   (id, name, st) => ipcRenderer.invoke('open-console-window', id, name, st),
  install:         (srv)      => ipcRenderer.invoke('server-install',          srv),
  installModpack:  (srv, url) => ipcRenderer.invoke('server-install-modpack',   srv, url),
  start:           (srv)      => ipcRenderer.invoke('server-start',       srv),
  stop:            (id)       => ipcRenderer.invoke('server-stop',        id),
  command:         (id,cmd)   => ipcRenderer.invoke('server-command',     id, cmd),
  writeProperties: (id,props) => ipcRenderer.invoke('server-write-props', id, props),
  pickJar:         ()         => ipcRenderer.invoke('server-pick-jar'),
  deleteServer:    (id)       => ipcRenderer.invoke('server-delete',      id),
  removeFile:      (id,s,f)       => ipcRenderer.invoke('server-remove-file',   id, s, f),
  toggleFile:      (id,s,f,en)    => ipcRenderer.invoke('server-toggle-file',   id, s, f, en),
  openFolder:      (p)        => ipcRenderer.invoke('open-folder',        p),
  getDataRoot:     ()         => ipcRenderer.invoke('get-data-root'),
  getElectronVersion: ()     => ipcRenderer.invoke('get-electron-version'),
  getServerPath:   (id)       => ipcRenderer.invoke('get-server-path',    id),
  detectJava:      ()         => ipcRenderer.invoke('java-detect'),
  detectAllJava:   ()         => ipcRenderer.invoke('java-detect-all'),
  probeJava:       (p)        => ipcRenderer.invoke('java-probe',         p),
  browseJava:      ()         => ipcRenderer.invoke('dialog-open-java'),
  setJavaOverride: (p)        => ipcRenderer.invoke('java-set-override',  p),
  openExternal:    (url)      => ipcRenderer.invoke('open-external',      url),
  onLog:             (cb) => ipcRenderer.on('server-log',             (_, id, line) => cb(id, line)),
  onStatusChange:    (cb) => ipcRenderer.on('server-status-change',   (_, id, s)    => cb(id, s)),
  onInstallProgress: (cb) => ipcRenderer.on('server-install-progress',(_, id, p, m) => cb(id, p, m)),
  onBackupCreated:   (cb) => ipcRenderer.on('backup-created',         (_, id, name) => cb(id, name)),

  // Players & JSON
  readJsonFile:      (id, f)       => ipcRenderer.invoke('server-read-json',           id, f),
  patchJsonFile:     (id, f, data) => ipcRenderer.invoke('server-patch-json',          id, f, data),
  getOnlinePlayers:  (id)          => ipcRenderer.invoke('server-get-online-players',  id),
  readServerProps:   (id)          => ipcRenderer.invoke('server-read-props',          id),

  // Backups
  listBackups:       (id)          => ipcRenderer.invoke('server-list-backups',        id),
  createBackup:      (id)          => ipcRenderer.invoke('server-create-backup',       id),
  restoreBackup:     (id, f)       => ipcRenderer.invoke('server-restore-backup',      id, f),
  deleteBackup:      (id, f)       => ipcRenderer.invoke('server-delete-backup',       id, f),
  setBackupConfig:   (id, i, k)    => ipcRenderer.invoke('server-set-backup-config',   id, i, k),
  resetWorld:        (id, t, s, b) => ipcRenderer.invoke('server-reset-world',         id, t, s, b),
  copyPlugin:        (id, src, fn) => ipcRenderer.invoke('server-copy-plugin',         id, src, fn),
  copyMod:           (id, src, fn) => ipcRenderer.invoke('server-copy-mod',             id, src, fn),
  listPlugins:       (id)            => ipcRenderer.invoke('server-list-plugins',         id),
  downloadToFolder:  (id, url, fn, sub) => ipcRenderer.invoke('server-download-to-folder', id, url, fn, sub),
  listMods:          (id)            => ipcRenderer.invoke('server-list-mods',            id),
  writeMcIcon:       (id, data)    => ipcRenderer.invoke('server-write-mc-icon',       id, data),
  pickJar:           ()            => ipcRenderer.invoke('pick-jar'),
});

contextBridge.exposeInMainWorld('craftdockInstance', {
  create:         (meta)      => ipcRenderer.invoke('instance-create',          meta),
  update:         (meta)      => ipcRenderer.invoke('instance-update',          meta),
  delete:         (id)        => ipcRenderer.invoke('instance-delete',          id),
  list:           ()          => ipcRenderer.invoke('instance-list'),
  get:            (id)        => ipcRenderer.invoke('instance-get',             id),
  launch:         (inst, serverIp) => ipcRenderer.invoke('instance-launch', inst, serverIp || null),
  stopInstance:   (id)        => ipcRenderer.invoke('stop-instance', id),
  listWorlds:     (id)        => ipcRenderer.invoke('instance-list-worlds',     id),
  listMods:       (id)        => ipcRenderer.invoke('instance-list-mods',       id),
  toggleMod:      (id,f,en)   => ipcRenderer.invoke('instance-toggle-mod',      id, f, en),
  deleteMod:      (id,f)      => ipcRenderer.invoke('instance-delete-mod',      id, f),
  listScreenshots:(id)        => ipcRenderer.invoke('instance-list-screenshots', id),
  openFolder:     (id,sub)        => ipcRenderer.invoke('instance-open-folder',        id, sub),
  applyResourceTag:   (id, tag)  => ipcRenderer.invoke('instance-apply-resource-tag',  id, tag),
  listConfigFiles:    (id)       => ipcRenderer.invoke('instance-list-config-files',    id),
  readScreenshot:     (p)        => ipcRenderer.invoke('instance-read-screenshot',       p),
  listLauncherJava:   ()         => ipcRenderer.invoke('list-launcher-java'),
  refreshTokensNow:   ()         => ipcRenderer.invoke('refresh-tokens-now'),
  openConfigFile:     (p)        => ipcRenderer.invoke('instance-open-config-file',     p),
  readConfigFile:     (p)        => ipcRenderer.invoke('instance-read-config-file',      p),
  writeConfigFile:    (p, text)  => ipcRenderer.invoke('instance-write-config-file',     p, text),
  importPack:         (p, type)  => ipcRenderer.invoke('instance-import-pack',          p, type),
  getDiskSize:    (id)            => ipcRenderer.invoke('instance-get-disk-size',       id),
  downloadMod:    (id,url,fn)     => ipcRenderer.invoke('instance-download-mod',        id, url, fn),
  listFolder:     (id,sub)        => ipcRenderer.invoke('instance-list-folder',         id, sub),
  downloadResPack:(id,url,fn,sub) => ipcRenderer.invoke('instance-download-respack',    id, url, fn, sub),
  toggleResFile:  (id,sub,fn,en)  => ipcRenderer.invoke('instance-toggle-resfile',      id, sub, fn, en),
  deleteResFile:  (id,sub,fn)     => ipcRenderer.invoke('instance-delete-resfile',      id, sub, fn),
  sharedWorldsPath:   ()              => ipcRenderer.invoke('shared-worlds-path'),
  listWorldTags:      ()              => ipcRenderer.invoke('instance-list-world-tags'),
  getBuilds:          (sw,ver)        => ipcRenderer.invoke('server-get-builds',            sw, ver),
  installModpack:     (id, url)       => ipcRenderer.invoke('instance-install-modpack',     id, url),
  onLaunchStatus:     (cb)            => ipcRenderer.on('instance-launch-status',     (_,id,st,msg) => cb(id, st, msg)),
  onInstallProgress:  (cb)            => ipcRenderer.on('instance-install-progress',  (_,id,pct,msg) => cb(id, pct, msg)),
  onConsoleLog:       (cb)            => ipcRenderer.on('instance-console-log',        (_,id,line) => cb(id, line)),
  scanJava:           ()              => ipcRenderer.invoke('java-scan'),
  probeJava:          (p)             => ipcRenderer.invoke('java-probe', p),
  browseJava:         ()              => ipcRenderer.invoke('dialog-open-java'),
  readServersDat:     (id)            => ipcRenderer.invoke('instance-read-servers-dat', id),
  registerSlug:       (id,name,type)  => ipcRenderer.invoke('register-slug', id, name, type),
  exportPack:         (id, fmt)       => ipcRenderer.invoke('instance-export', id, fmt),
  checkAppUpdate:     ()              => ipcRenderer.invoke('check-app-update'),
});
