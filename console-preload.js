const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('consoleApi', {
  minimize:      ()          => ipcRenderer.send('window-minimize'),
  sendCommand:   (id, cmd)   => ipcRenderer.invoke('server-command', id, cmd),

  onInit:            (cb) => ipcRenderer.on('console-init',             (_, id, name, status) => cb(id, name, status)),
  onLog:             (cb) => ipcRenderer.on('server-log',               (_, id, line)         => cb(id, line)),
  onStatus:          (cb) => ipcRenderer.on('server-status-change',     (_, id, s)            => cb(id, s)),
  onInstallProgress: (cb) => ipcRenderer.on('server-install-progress',  (_, id, pct, msg)     => cb(id, pct, msg)),
});
