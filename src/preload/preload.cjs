const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bt', {
  getState: () => ipcRenderer.invoke('t:get-state'),
  addMagnet: (text) => ipcRenderer.invoke('t:add-magnet', text),
  addTorrentFile: () => ipcRenderer.invoke('t:add-file'),
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  addTorrentPath: (filePath) => ipcRenderer.invoke('t:add-path', filePath),
  pause: (hash) => ipcRenderer.invoke('t:pause', hash),
  resume: (hash) => ipcRenderer.invoke('t:resume', hash),
  setLimits: (down, up) => ipcRenderer.invoke('t:set-limits', down, up),
  setFileSelection: (hash, selections) => ipcRenderer.invoke('t:set-file-selection', hash, selections),
  startStream: (hash, index) => ipcRenderer.invoke('t:start-stream', hash, index),
  stopStream: (hash) => ipcRenderer.invoke('t:stop-stream', hash),
  play: (hash, index) => ipcRenderer.invoke('t:play', hash, index),
  remove: (hash, deleteFiles) => ipcRenderer.invoke('t:remove', hash, deleteFiles),
  openFolder: (hash) => ipcRenderer.invoke('t:open-folder', hash),
  reveal: (hash) => ipcRenderer.invoke('t:reveal', hash),
  chooseDir: () => ipcRenderer.invoke('t:choose-dir'),
  setDownloadDir: (dir) => ipcRenderer.invoke('t:set-dir', dir),
  openExternal: (url) => ipcRenderer.invoke('t:open-external', url),
  speedSeries: (key) => ipcRenderer.invoke('t:speed-series', key),
  diskInfo: () => ipcRenderer.invoke('t:disk-info'),
  setShareLimits: (opts) => ipcRenderer.invoke('t:set-share-limits', opts),
  getShareLimits: () => ipcRenderer.invoke('t:get-share-limits'),
  onUpdate: (cb) => ipcRenderer.on('t:update', (_e, payload) => cb(payload)),
  onNotice: (cb) => ipcRenderer.on('t:notice', (_e, payload) => cb(payload))
});
