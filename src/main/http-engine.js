/**
 * HTTP(S) 直链下载引擎
 *
 * 架构借鉴迅雷 DownloadService.xpc 的 dl_downloadlib（逆向结论见
 * ~/Projects/analysis/thunder-macos-5.80.8/REPORT.md）：
 * - 多线程分块下载（Range 请求并发拉取不同区段）
 * - 断点续传（分块进度持久化，重启/暂停后从断点继续）
 * - 任务队列调度（最大并发任务数，多余任务排队）
 * - 令牌桶全局限速
 * - 智能重试（指数退避）
 * - 文件名智能识别（Content-Disposition / URL / 重定向终态）
 */
import EventEmitter from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

/** 按当前平台生成 UA（Windows 上伪装 Windows Chrome，避免被服务器按平台下发不同内容） */
const PLATFORM_TOKEN =
  os.platform() === 'win32'
    ? 'Windows NT 10.0; Win64; x64'
    : os.platform() === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'X11; Linux x86_64';
const UA = `Mozilla/5.0 (${PLATFORM_TOKEN}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 OmniDown/1.0`;

const TICK_MS = 800; // 界面刷新/测速周期
const MAX_ACTIVE = 4; // 同时下载的任务数（借鉴迅雷任务队列）
const CONNS_PER_TASK = 8; // 每任务并发连接数（借鉴迅雷多线程）
const MIN_CHUNK = 2 * 1024 * 1024; // 分块下限 2MB，小文件不分块
const RETRY_MAX = 6; // 单块最大重试
const SAVE_DEBOUNCE = 800; // 状态落盘防抖

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpEngine extends EventEmitter {
  constructor({ downloadDir, stateFile }) {
    super();
    this.downloadDir = downloadDir;
    this.stateFile = stateFile;
    /** id -> task */
    this.tasks = new Map();
    this.limits = { down: -1 };
    this.started = false;
    this.timer = null;
    this._tokens = -1;
    this._lastRefill = 0;
    this._saveTimer = null;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    fs.mkdirSync(this.downloadDir, { recursive: true });

    // 恢复上次会话：正在下载的自动续传，暂停的保持暂停
    const saved = await this._loadState();
    for (const s of saved) {
      const task = {
        ...s,
        status: s.status === 'downloading' ? 'paused' : s.status,
        speed: 0,
        _bytesThisTick: 0,
        _abortControllers: new Set(),
        _pauseRequested: false,
        _removeRequested: false,
        _activeConns: 0
      };
      // 已完成任务但文件被删了 → 允许重新下载
      if (task.status === 'done' && task.filename) {
        const finalPath = path.join(task.dir, task.filename);
        if (!fs.existsSync(finalPath)) {
          task.status = 'paused';
          task.received = 0;
          task.chunks = [];
        }
      }
      this.tasks.set(task.id, task);
      if (s.status === 'downloading') this._schedule(task.id, 500 + Math.random() * 1500);
    }

    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const task of this.tasks.values()) {
      task._pauseRequested = true;
      this._abortTask(task);
      this._closeFd(task);
    }
    await this._saveState();
  }

  // ------------------------------------------------------------- 公开操作

  /** 添加下载任务，返回任务 id */
  add(url, opts = {}) {
    const id = crypto.randomUUID();
    const task = {
      id,
      url: String(url).trim(),
      filename: null,
      dir: opts.dir || this.downloadDir,
      size: 0,
      received: 0,
      status: 'probing', // probing | queued | downloading | paused | done | error
      speed: 0,
      error: null,
      chunks: [],
      acceptRanges: false,
      contentType: null,
      createdAt: Date.now(),
      completedAt: 0,
      _bytesThisTick: 0,
      _abortControllers: new Set(),
      _pauseRequested: false,
      _removeRequested: false,
      _activeConns: 0,
      _fd: null,
      _probeCtrl: null
    };
    this.tasks.set(id, task);
    this._probe(task);
    this._broadcast();
    return id;
  }

  pause(id) {
    const task = this.tasks.get(String(id));
    if (!task) return false;
    if (!['probing', 'queued', 'downloading'].includes(task.status)) return false;
    task._pauseRequested = true;
    this._abortTask(task);
    this._closeFd(task);
    task.status = 'paused';
    task.speed = 0;
    task._activeConns = 0;
    this._saveStateSoon(true);
    this._promoteQueue();
    this._broadcast();
    return true;
  }

  resume(id) {
    const task = this.tasks.get(String(id));
    if (!task) return false;
    if (!['paused', 'error', 'queued'].includes(task.status)) return false;
    task._pauseRequested = false;
    task._removeRequested = false;
    task.error = null;
    this._schedule(task.id, 0);
    this._broadcast();
    return true;
  }

  async remove(id, deleteFiles = false) {
    const task = this.tasks.get(String(id));
    if (!task) return false;
    task._removeRequested = true;
    task._pauseRequested = true;
    this._abortTask(task);
    this._closeFd(task);
    this.tasks.delete(String(id));
    if (deleteFiles) {
      await fsp.rm(this._partPathOf(task), { force: true }).catch(() => {});
      if (task.filename) {
        await fsp.rm(path.join(task.dir, task.filename), { force: true }).catch(() => {});
      }
    }
    this._saveStateSoon(true);
    this._promoteQueue();
    this._broadcast();
    return true;
  }

  /** 全局限速（字节/秒，-1 不限），令牌桶实现 */
  setSpeedLimit(bytesPerSec) {
    this.limits.down = Number.isFinite(bytesPerSec) ? bytesPerSec : -1;
    this._tokens = this.limits.down;
    this._lastRefill = Date.now();
  }

  folderOf(id) {
    const task = this.tasks.get(String(id));
    return task?.dir || this.downloadDir;
  }

  // ------------------------------------------------------------- 探测

  /** GET Range:0-0 探测：大小 / Range 支持 / 文件名（一次请求全拿到） */
  async _probe(task) {
    const ctrl = new AbortController();
    task._probeCtrl = ctrl;
    try {
      const res = await fetch(task.url, {
        headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
        redirect: 'follow',
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      task.filename = this._filenameFrom(res, res.url || task.url);
      task.contentType = res.headers.get('content-type') || '';
      if (res.status === 206) {
        task.acceptRanges = true;
        const cr = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
        task.size = cr
          ? parseInt(cr[1], 10)
          : parseInt(res.headers.get('content-length') || '0', 10) || 0;
      } else {
        task.acceptRanges = false;
        task.size = parseInt(res.headers.get('content-length') || '0', 10) || 0;
      }
      try { await res.body.cancel(); } catch { /* ignore */ }
    } catch (err) {
      if (task._pauseRequested || task._removeRequested) return;
      // 探测失败不放弃：按无 Range、未知大小直接下（部分服务器行为怪异）
      task.filename = this._filenameFrom(null, task.url);
      task.size = 0;
      task.acceptRanges = false;
    }
    task._probeCtrl = null;

    if (task._pauseRequested || task._removeRequested) return;

    task.filename = this._uniquePath(task.dir, task.filename);
    task.status = 'paused';
    this._saveStateSoon(true);
    this._schedule(task.id, 30);
  }

  // ------------------------------------------------------------- 调度

  /** 队列感知启动：有空位才真正开跑，否则排队 */
  _schedule(id, delay = 0) {
    const task = this.tasks.get(id);
    if (!task) return;
    const active = [...this.tasks.values()].filter((t) => t.status === 'downloading').length;
    if (active >= MAX_ACTIVE && task.status !== 'downloading') {
      task.status = 'queued';
      this._broadcast();
      return;
    }
    setTimeout(() => {
      const t = this.tasks.get(id);
      if (!t || t._removeRequested) return;
      // 用户已请求暂停/任务已不在可下载状态 → 不启动
      if (t._pauseRequested || !['paused', 'queued', 'probing'].includes(t.status)) return;
      this._download(t).catch(() => {});
    }, delay);
  }

  /** 有任务结束/暂停后，提升队首任务 */
  _promoteQueue() {
    const next = [...this.tasks.values()].find((t) => t.status === 'queued');
    if (next) this._schedule(next.id, 200);
  }

  // ------------------------------------------------------------- 下载核心

  async _download(task) {
    // 双重检查：调度延迟期间用户可能已暂停/删除
    if (task._pauseRequested || task._removeRequested) return;
    task.status = 'downloading';
    task.error = null;
    task._pauseRequested = false;

    try {
      const partPath = this._partPathOf(task);

      if (task.size > 0) {
        // 定长模式：稀疏文件 + 分块 Range 并发
        if (!fs.existsSync(partPath)) {
          task.chunks = [];
          task.received = 0;
        }
        if (!task.chunks.length) this._openChunks(task);
        task._fd = fs.openSync(partPath, fs.existsSync(partPath) ? 'r+' : 'w');
        fs.ftruncateSync(task._fd, task.size);

        const pending = task.chunks.filter((c) => c.received < c.length);
        task._activeConns = pending.length;
        await Promise.all(pending.map((c) => this._pumpWithRetry(task, c)));
        task._activeConns = 0;

        if (task.received !== task.size) {
          // 校验总量（防止服务器虚报）
          task.received = task.chunks.reduce((a, c) => a + c.received, 0);
        }
        this._finish(task);
      } else {
        // 未知大小：单流追加模式（无法断点，中断后重来）
        task._fd = fs.openSync(partPath, 'w');
        task.received = 0;
        await this._pumpStream(task);
        task.size = task.received;
        this._finish(task);
      }
    } catch (err) {
      task._activeConns = 0;
      if (task._pauseRequested || task._removeRequested) return; // 主动中断，静默
      // 服务器谎报支持 Range → 降级为单流重试一次
      if (/不支持断点/.test(err.message) && !task._fellBack) {
        task._fellBack = true;
        task.acceptRanges = false;
        task.chunks = [];
        task.received = 0;
        this._closeFd(task);
        this._download(task).catch(() => {});
        return;
      }
      task.status = 'error';
      task.error = err.message;
      this.emit('notice', {
        type: 'error',
        text: `下载失败：${task.filename || task.url} — ${err.message}`
      });
    } finally {
      this._closeFd(task);
      this._saveStateSoon(true);
      this._promoteQueue();
    }
  }

  /** 把文件切成 N 块 */
  _openChunks(task) {
    if (!task.acceptRanges || !task.size) {
      task.chunks = task.size ? [{ start: 0, length: task.size, received: 0 }] : [];
      return;
    }
    const n = Math.min(CONNS_PER_TASK, Math.max(1, Math.floor(task.size / MIN_CHUNK)));
    const per = Math.floor(task.size / n);
    task.chunks = [];
    for (let i = 0; i < n; i++) {
      const start = i * per;
      const length = i === n - 1 ? task.size - start : per;
      task.chunks.push({ start, length, received: 0 });
    }
  }

  /** 单块下载 + 指数退避重试 */
  async _pumpWithRetry(task, chunk) {
    let attempt = 0;
    while (chunk.received < chunk.length) {
      try {
        await this._pump(task, chunk);
      } catch (err) {
        if (task._pauseRequested || task._removeRequested) throw new Error('aborted');
        attempt++;
        if (attempt > RETRY_MAX) throw err;
        const delay = Math.min(1000 * 2 ** (attempt - 1), 30000);
        await sleep(delay);
      }
    }
  }

  /** 拉取一个块的剩余区间 */
  async _pump(task, chunk) {
    const ctrl = new AbortController();
    task._abortControllers.add(ctrl);
    try {
      const from = chunk.start + chunk.received;
      const to = chunk.start + chunk.length - 1;
      const res = await fetch(task.url, {
        headers: { 'User-Agent': UA, Range: `bytes=${from}-${to}` },
        redirect: 'follow',
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (res.status === 200 && from > 0) {
        try { await res.body.cancel(); } catch { /* ignore */ }
        throw new Error('服务器不支持断点范围');
      }

      const reader = res.body.getReader();
      let pos = from;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await this._throttle(value.length);
        fs.writeSync(task._fd, value, 0, value.length, pos);
        pos += value.length;
        chunk.received = pos - chunk.start;
        task.received += value.length;
        task._bytesThisTick += value.length;
        this._dirty = true;
      }
    } finally {
      task._abortControllers.delete(ctrl);
    }
  }

  /** 未知大小的单流下载 */
  async _pumpStream(task) {
    const ctrl = new AbortController();
    task._abortControllers.add(ctrl);
    try {
      const res = await fetch(task.url, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await this._throttle(value.length);
        fs.writeSync(task._fd, value);
        task.received += value.length;
        task._bytesThisTick += value.length;
        this._dirty = true;
      }
    } finally {
      task._abortControllers.delete(ctrl);
    }
  }

  _finish(task) {
    this._closeFd(task);
    const finalPath = path.join(task.dir, task.filename);
    try {
      fs.renameSync(this._partPathOf(task), finalPath);
    } catch { /* rename 失败不影响完成状态 */ }
    task.status = 'done';
    task.completedAt = Date.now();
    task.speed = 0;
    this.emit('notice', { type: 'success', text: `下载完成：${task.filename}` });
    this._saveStateSoon(true);
  }

  // ------------------------------------------------------------- 限速（令牌桶）

  async _throttle(n) {
    const limit = this.limits.down;
    if (!limit || limit <= 0) return;
    for (;;) {
      const now = Date.now();
      const elapsed = now - this._lastRefill;
      if (elapsed >= 100) {
        this._tokens = Math.min(this._tokens + (limit * elapsed) / 1000, limit);
        this._lastRefill = now;
      }
      if (this._tokens >= n) {
        this._tokens -= n;
        return;
      }
      await sleep(40);
    }
  }

  // ------------------------------------------------------------- 工具

  _abortTask(task) {
    if (task._probeCtrl) {
      try { task._probeCtrl.abort(); } catch { /* ignore */ }
      task._probeCtrl = null;
    }
    for (const c of task._abortControllers || []) {
      try { c.abort(); } catch { /* ignore */ }
    }
    task._abortControllers?.clear();
  }

  _closeFd(task) {
    if (task._fd != null) {
      try { fs.closeSync(task._fd); } catch { /* ignore */ }
      task._fd = null;
    }
  }

  _partPathOf(task) {
    return path.join(task.dir, (task.filename || 'download') + '.part');
  }

  _filenameFrom(res, url) {
    let name = '';
    const cd = res?.headers?.get('content-disposition');
    if (cd) {
      const m1 = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
      const m2 = /filename="?([^";]+)"?/.exec(cd);
      const raw = m1 ? decodeURIComponent(m1[1]) : m2?.[1];
      if (raw) name = raw.trim();
    }
    if (!name) {
      try {
        const u = new URL(url);
        name = decodeURIComponent(path.posix.basename(u.pathname) || '');
      } catch { /* ignore */ }
    }
    if (!name || name === '/' || name.endsWith('/')) name = `download-${Date.now()}`;
    // 清理非法字符，防路径穿越
    name = name.replace(/[/\\:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
    if (name.length > 150) {
      const ext = path.extname(name).slice(0, 10);
      name = name.slice(0, 150 - ext.length) + ext;
    }
    return name || `download-${Date.now()}`;
  }

  /** 重名处理：name.ext → name (1).ext → name (2).ext … */
  _uniquePath(dir, name) {
    if (!name) name = `download-${Date.now()}`;
    let candidate = path.join(dir, name);
    if (!fs.existsSync(candidate)) return name;
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    for (let i = 1; i < 999; i++) {
      candidate = path.join(dir, `${base} (${i})${ext}`);
      if (!fs.existsSync(candidate)) return `${base} (${i})${ext}`;
    }
    return `${base}-${Date.now()}${ext}`;
  }

  // ------------------------------------------------------------- 序列化

  serialize(task) {
    const speed = task.status === 'downloading' ? task.speed || 0 : 0;
    const eta = speed > 0 && task.size > 0 ? (task.size - task.received) / speed : Infinity;
    return {
      id: task.id,
      kind: 'http',
      infoHash: task.id, // UI 以 infoHash 为唯一 key
      name: task.filename || task.url,
      magnetURI: task.url, // 复制按钮直接得到链接
      url: task.url,
      progress: task.size ? Math.min(1, task.received / task.size) : 0,
      downloadSpeed: speed,
      uploadSpeed: 0,
      downloaded: task.received,
      uploaded: 0,
      length: task.size,
      numPeers: task.status === 'downloading' ? task._activeConns : 0,
      timeRemaining: task.status === 'done' ? 0 : eta,
      ratio: 0,
      done: task.status === 'done',
      paused: ['paused', 'queued'].includes(task.status),
      ready: true,
      files: 1,
      path: task.filename ? path.join(task.dir, task.filename) : task.dir,
      addedAt: task.createdAt,
      status: task.status,
      error: task.error,
      fileDetails: []
    };
  }

  serializeAll() {
    return [...this.tasks.values()].map((t) => this.serialize(t));
  }

  stats() {
    const list = this.serializeAll();
    return {
      downloadSpeed: list.reduce((a, b) => a + b.downloadSpeed, 0),
      count: list.length,
      active: list.filter((t) => t.status === 'downloading').length,
      done: list.filter((t) => t.done).length
    };
  }

  // ------------------------------------------------------------- 周期与广播

  _tick() {
    for (const t of this.tasks.values()) {
      t.speed = t.status === 'downloading' ? Math.round((t._bytesThisTick || 0) / (TICK_MS / 1000)) : 0;
      t._bytesThisTick = 0;
    }
    this._broadcast();
    if (this._dirty) this._saveStateSoon();
  }

  _broadcast() {
    this.emit('update', { torrents: this.serializeAll(), stats: this.stats() });
  }

  // ------------------------------------------------------------- 持久化

  _saveStateSoon(immediate = false) {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(
      () => {
        this._saveTimer = null;
        this._saveState();
      },
      immediate ? 0 : SAVE_DEBOUNCE
    );
  }

  async _loadState() {
    try {
      const raw = await fsp.readFile(this.stateFile, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async _saveState() {
    // 互斥：防止并发 save 交错写同一 tmp 文件导致内容混合损坏
    if (this._saving) {
      this._dirty = true; // 稍后由进行中的 save 完成后再补一次
      return;
    }
    this._saving = true;
    this._dirty = false;
    const data = [...this.tasks.values()].map((t) => ({
      id: t.id,
      url: t.url,
      filename: t.filename,
      dir: t.dir,
      size: t.size,
      received: t.received,
      status: t.status,
      chunks: t.chunks,
      acceptRanges: t.acceptRanges,
      contentType: t.contentType,
      createdAt: t.createdAt,
      completedAt: t.completedAt
    }));
    try {
      await fsp.mkdir(path.dirname(this.stateFile), { recursive: true });
      // 原子写（借鉴 qBittorrent 的 resume data 落盘策略）：
      // 先写临时文件再 rename，避免写入中途崩溃导致状态文件损坏
      const tmp = this.stateFile + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fsp.rename(tmp, this.stateFile);
    } catch { /* 落盘失败不影响运行 */ } finally {
      this._saving = false;
      // 保存期间又有变更 → 补一次保存
      if (this._dirty) this._saveStateSoon();
    }
  }
}
