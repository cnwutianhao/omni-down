import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TorrentEngine } from './torrent-engine.js';
import { HttpEngine } from './http-engine.js';
import { DiskSpaceMonitor } from './disk-monitor.js';
import { SpeedHistory } from './speed-history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {BrowserWindow|null} */
let win = null;
/** @type {TorrentEngine|null} */
let engine = null;
/** @type {HttpEngine|null} */
let httpEngine = null;
/** @type {DiskSpaceMonitor|null} */
let diskMonitor = null;
/** @type {SpeedHistory|null} */
let speedHistory = null;
let settingsFile = '';
let settings = {};

/** 聚合两个引擎的状态，BT 任务在前、HTTP 任务在后（模块级，供 IPC 与事件转发共用） */
function mergedState() {
  const bt = engine ? engine.serializeAll() : [];
  const http = httpEngine ? httpEngine.serializeAll() : [];
  const btStats = engine ? engine.stats() : { downloadSpeed: 0, uploadSpeed: 0, count: 0, active: 0, done: 0, limits: { down: -1, up: -1 } };
  const httpStats = httpEngine ? httpEngine.stats() : { downloadSpeed: 0, count: 0, active: 0, done: 0 };
  return {
    downloadDir: engine ? engine.downloadDir : settings.downloadDir,
    torrents: [...bt, ...http],
    stats: {
      downloadSpeed: btStats.downloadSpeed + httpStats.downloadSpeed,
      uploadSpeed: btStats.uploadSpeed,
      count: btStats.count + httpStats.count,
      active: btStats.active + httpStats.active,
      done: btStats.done + httpStats.done,
      limits: btStats.limits
    }
  };
}

function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    settings = {};
  }
  if (!settings.downloadDir) {
    settings.downloadDir = path.join(app.getPath('downloads'), 'OmniDown');
  }
  return settings;
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function createWindow() {
  const isMac = process.platform === 'darwin';

  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 880,
    minHeight: 580,
    show: false,
    // macOS 用隐藏标题栏 + 红绿灯；Win/Linux 用系统原生标题栏
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 } }
      : {}),
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.once('ready-to-show', () => win.show());

  // 把渲染进程的日志/错误转发到主进程输出，便于排查
  win.webContents.on('console-message', (...args) => {
    const details = args[1];
    if (details && typeof details === 'object' && 'message' in details) {
      console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    } else {
      console.log(`[renderer] ${args[2]} (${args[4]}:${args[3]})`);
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer 崩溃]', d));
  win.webContents.on('preload-error', (_e, p, err) => console.error('[preload 错误]', p, err));

  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });
}

function registerIpc() {
  ipcMain.handle('t:get-state', () => mergedState());

  ipcMain.handle('t:add-magnet', async (_e, text) => {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, error: '请输入链接' };

    const parts = raw.split(/[\s,，]+/).filter(Boolean);
    const errors = [];
    let added = 0;

    for (const part of parts) {
      const isMagnet = /^magnet:\?/i.test(part);
      const isHash = /^[a-f0-9]{40}$/i.test(part);
      const isHttp = /^https?:\/\/.+/i.test(part);
      if (!isMagnet && !isHash && !isHttp) {
        errors.push(`无效链接：${part.slice(0, 40)}`);
        continue;
      }
      try {
        if (isHttp) {
          // 重复检测（借鉴 qBittorrent duplicateTorrentDetected）
          const dup = httpEngine.serializeAll().find((t) => t.url === part);
          if (dup) {
            errors.push(`任务已存在：${dup.name}`);
            continue;
          }
          httpEngine.add(part);
        } else {
          const hash = engine._hashOf(part);
          if (hash && engine._torrentOf(hash)) {
            const existing = engine._torrentOf(hash);
            errors.push(`任务已存在：${existing.name || hash.slice(0, 8)}`);
            continue;
          }
          engine.add(part);
        }
        added += 1;
      } catch (err) {
        errors.push(err.message);
      }
    }

    if (added === 0) return { ok: false, error: errors[0] || '添加失败' };
    return { ok: true, added, error: errors.length ? errors.join('；') : null };
  });

  ipcMain.handle('t:add-file', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择种子文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Torrent 文件', extensions: ['torrent'] }]
    });
    if (res.canceled) return { ok: false, canceled: true };

    let added = 0;
    const errors = [];
    for (const file of res.filePaths) {
      try {
        const buf = fs.readFileSync(file);
        engine.add(buf);
        added += 1;
      } catch (err) {
        errors.push(`${path.basename(file)}：${err.message}`);
      }
    }
    if (added === 0) return { ok: false, error: errors.join('；') || '添加失败' };
    return { ok: true, added, error: errors.length ? errors.join('；') : null };
  });

  ipcMain.handle('t:add-path', async (_e, filePath) => {
    const p = String(filePath || '');
    try {
      const buf = fs.readFileSync(p);
      engine.add(buf);
      return { ok: true, added: 1 };
    } catch (err) {
      return { ok: false, error: `${path.basename(p)}：${err.message}` };
    }
  });

  ipcMain.handle('t:pause', (_e, hash) => {
    const h = String(hash);
    const ok = httpEngine.tasks.get(h) ? httpEngine.pause(h) : engine.pause(h);
    return { ok };
  });
  ipcMain.handle('t:resume', (_e, hash) => {
    const h = String(hash);
    const ok = httpEngine.tasks.get(h) ? httpEngine.resume(h) : engine.resume(h);
    return { ok };
  });

  // ---- 限速（借鉴迅雷 GlobalVIPThreshold 模型，同时作用于 BT 与 HTTP 引擎）----
  ipcMain.handle('t:set-limits', (_e, down, up) => {
    const d = Number(down);
    const u = Number(up);
    const dn = Number.isFinite(d) ? d : -1;
    const un = Number.isFinite(u) ? u : -1;
    const ok = engine.setSpeedLimit(dn, un);
    httpEngine.setSpeedLimit(dn);
    if (ok) {
      settings.limits = { down: dn, up: un };
      saveSettings();
    }
    return { ok };
  });

  // ---- 文件选择下载 ----
  ipcMain.handle('t:set-file-selection', (_e, hash, selections) => ({
    ok: engine.setFileSelection(String(hash), Array.isArray(selections) ? selections : [])
  }));

  // ---- 边下边播：启动本地流媒体并返回地址 ----
  ipcMain.handle('t:start-stream', (_e, hash, index) => {
    const res = engine.startStream(String(hash));
    if (!res.ok) return res;
    const url = engine.streamUrl(String(hash), Number(index ?? 0));
    if (!url) return { ok: false, error: '无法生成播放地址' };
    return { ok: true, url };
  });

  ipcMain.handle('t:stop-stream', (_e, hash) => {
    engine.stopStream(String(hash));
    return { ok: true };
  });

  // ---- 用系统播放器打开流媒体地址（或已下载完成的文件）----
  ipcMain.handle('t:play', async (_e, hash, index) => {
    const httpTask = httpEngine.tasks.get(String(hash));
    // HTTP 任务：完成 → 打开文件；未完成 → 提示
    if (httpTask) {
      if (httpTask.status === 'done' && httpTask.filename) {
        await shell.openPath(path.join(httpTask.dir, httpTask.filename));
        return { ok: true, local: true };
      }
      return { ok: false, error: 'HTTP 任务需下载完成后才能打开' };
    }
    const t = engine._torrentOf(String(hash));
    const file = t?.files?.[Number(index ?? 0)];
    // 已下载完成 → 直接打开本地文件
    if (t && file && t.done) {
      await shell.openPath(path.join(t.path, file.path));
      return { ok: true, local: true };
    }
    // 未完成 → 启动流媒体并用默认播放器打开 URL
    const res = engine.startStream(String(hash));
    if (!res.ok) return res;
    const url = engine.streamUrl(String(hash), Number(index ?? 0));
    if (!url) return { ok: false, error: '无法生成播放地址' };
    await shell.openExternal(url);
    return { ok: true, url };
  });

  ipcMain.handle('t:remove', async (_e, hash, deleteFiles) => {
    if (httpEngine.tasks.get(String(hash))) {
      await httpEngine.remove(String(hash), !!deleteFiles);
    } else {
      await engine.remove(String(hash), !!deleteFiles);
    }
    return { ok: true };
  });

  ipcMain.handle('t:open-folder', async (_e, hash) => {
    const dir = httpEngine.tasks.get(String(hash))
      ? httpEngine.folderOf(String(hash))
      : engine.folderOf(String(hash));
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return { ok: !err, error: err || null };
  });

  ipcMain.handle('t:reveal', async (_e, hash, index) => {
    const httpTask = httpEngine.tasks.get(String(hash));
    if (httpTask) {
      if (httpTask.filename) {
        shell.showItemInFolder(path.join(httpTask.dir, httpTask.filename));
        return { ok: true };
      }
      const dir = httpEngine.folderOf(String(hash));
      fs.mkdirSync(dir, { recursive: true });
      await shell.openPath(dir);
      return { ok: true };
    }
    const t = engine._torrentOf(String(hash));
    const file = t?.files?.[Number(index ?? 0)];
    if (file) {
      shell.showItemInFolder(path.join(t.path, file.path));
      return { ok: true };
    }
    const dir = engine.folderOf(String(hash));
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return { ok: true };
  });

  ipcMain.handle('t:choose-dir', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择下载目录',
      defaultPath: engine.downloadDir,
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    return { ok: true, dir: res.filePaths[0] };
  });

  ipcMain.handle('t:set-dir', (_e, dir) => {
    const next = String(dir || '').trim();
    if (!next) return { ok: false, error: '目录为空' };
    settings.downloadDir = next;
    saveSettings();
    engine.setDownloadDir(next);
    return { ok: true, dir: next };
  });

  ipcMain.handle('t:open-external', (_e, url) => {
    const u = String(url || '');
    if (/^https?:\/\//i.test(u)) shell.openExternal(u);
    return { ok: true };
  });

  // ---- 速度历史（借鉴 qBittorrent speedplotview 5 档时间窗）----
  ipcMain.handle('t:speed-series', (_e, key) => ({
    ok: true,
    points: speedHistory ? speedHistory.series(String(key || '5m')) : [],
    windows: speedHistory ? speedHistory.windows() : []
  }));

  // ---- 磁盘空间 ----
  ipcMain.handle('t:disk-info', () => ({
    ok: true,
    ...(diskMonitor ? diskMonitor.summary() : { free: 0, total: 0, level: 'ok', text: '' })
  }));

  // ---- 做种限制（借鉴 qBittorrent ShareLimitAction）----
  ipcMain.handle('t:set-share-limits', (_e, opts) => {
    engine.setShareLimits(opts || {});
    settings.shareLimits = { ...engine.shareLimits };
    saveSettings();
    return { ok: true, limits: engine.shareLimits };
  });

  ipcMain.handle('t:get-share-limits', () => ({ ok: true, limits: engine.shareLimits }));
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  settingsFile = path.join(userData, 'settings.json');

  // 从旧版 TorrentFlow 无缝迁移（一次性）
  const legacyDir = path.join(app.getPath('appData'), 'TorrentFlow');
  if (fs.existsSync(legacyDir) && !fs.existsSync(settingsFile)) {
    try {
      for (const f of ['settings.json', 'torrents.json', 'http-tasks.json']) {
        const src = path.join(legacyDir, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(userData, f));
      }
      console.log('[OmniDown] 已从 TorrentFlow 迁移用户数据');
    } catch { /* 迁移失败按全新安装处理 */ }
  }

  loadSettings();

  engine = new TorrentEngine({
    downloadDir: settings.downloadDir,
    stateFile: path.join(userData, 'torrents.json')
  });

  httpEngine = new HttpEngine({
    downloadDir: settings.downloadDir,
    stateFile: path.join(userData, 'http-tasks.json')
  });

  const forward = (payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('t:update', mergedState());
  };
  engine.on('update', forward);
  httpEngine.on('update', forward);
  engine.on('notice', (payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('t:notice', payload);
  });
  httpEngine.on('notice', (payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('t:notice', payload);
  });

  try {
    await engine.start();
  } catch (err) {
    dialog.showErrorBox('引擎启动失败', String(err?.stack || err));
  }
  try {
    await httpEngine.start();
  } catch (err) {
    dialog.showErrorBox('HTTP 引擎启动失败', String(err?.stack || err));
  }

  // 磁盘空间监控（借鉴 qBittorrent：30s 周期检查下载目录）
  diskMonitor = new DiskSpaceMonitor([settings.downloadDir]);
  diskMonitor.onChange = (info) => {
    const gb = (n) => (n / 1024 ** 3).toFixed(1);
    if (info.level === 'critical') {
      if (win && !win.isDestroyed()) {
        win.webContents.send('t:notice', {
          type: 'error',
          text: `磁盘空间严重不足！剩余仅 ${gb(info.free)} GB，下载可能失败`
        });
      }
    } else if (info.level === 'warn') {
      if (win && !win.isDestroyed()) {
        win.webContents.send('t:notice', {
          type: 'warn',
          text: `磁盘剩余空间偏低：${gb(info.free)} GB`
        });
      }
    }
  };
  diskMonitor.start();

  // 速度历史采样（借鉴 qBittorrent speedplotview 的 5 档时间窗）
  speedHistory = new SpeedHistory();
  setInterval(() => {
    const s = mergedState().stats;
    speedHistory.push(s.downloadSpeed, s.uploadSpeed);
  }, 1000);

  // 恢复上次的限速设置
  if (settings.limits) {
    engine.setSpeedLimit(settings.limits.down ?? -1, settings.limits.up ?? -1);
  }
  // 恢复做种限制
  if (settings.shareLimits) {
    engine.setShareLimits(settings.shareLimits);
  }

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async (event) => {
  const stoppingBt = engine && engine.client;
  const stoppingHttp = httpEngine && httpEngine.started;
  if (stoppingBt || stoppingHttp) {
    event.preventDefault();
    const bt = engine;
    const http = httpEngine;
    engine = null;
    httpEngine = null;
    await Promise.allSettled([
      stoppingBt ? bt.stop() : Promise.resolve(),
      stoppingHttp ? http.stop() : Promise.resolve()
    ]);
    app.quit();
  }
});
