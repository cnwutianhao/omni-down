import WebTorrent from 'webtorrent';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const TICK_MS = 800;

/**
 * 补充公共 tracker。
 * 列表顺序很重要：国内环境实测 UDP tracker 存活率低，把可用的放最前，
 * 并保留 HTTP/HTTPS 与 WebSocket 通道做冗余。
 */
const EXTRA_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'http://tracker.openbittorrent.com:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.opentrackr.com:6969/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz'
];

export class TorrentEngine extends EventEmitter {
  /**
   * @param {{ downloadDir: string, stateFile: string }} opts
   */
  constructor({ downloadDir, stateFile }) {
    super();
    this.downloadDir = downloadDir;
    this.stateFile = stateFile;
    this.client = null;
    this.timer = null;
    /** infoHash -> { uri, path, paused, addedAt, deselected } */
    this.records = new Map();
    this.started = false;
    /** 全局限速 { down, up }，-1 = 不限 */
    this.limits = { down: -1, up: -1 };
    this.streamPort = null;
    /**
     * 做种限制（借鉴 qBittorrent ShareLimitAction）：
     * maxRatio: 分享率上限，-1 不限；maxSeedingMinutes: 做种分钟数上限，-1 不限
     * action: 'stop' | 'remove' | 'remove-with-content'
     */
    this.shareLimits = { maxRatio: -1, maxSeedingMinutes: -1, action: 'stop' };
  }

  setShareLimits({ maxRatio, maxSeedingMinutes, action }) {
    if (Number.isFinite(maxRatio)) this.shareLimits.maxRatio = maxRatio;
    if (Number.isFinite(maxSeedingMinutes)) this.shareLimits.maxSeedingMinutes = maxSeedingMinutes;
    if (['stop', 'remove', 'remove-with-content'].includes(action)) this.shareLimits.action = action;
  }

  /** 每个tick检查做种限制（借鉴 qBittorrent 的 ratio limit 触发逻辑） */
  _checkShareLimits() {
    if (!this.client) return;
    const { maxRatio, maxSeedingMinutes, action } = this.shareLimits;
    if (maxRatio < 0 && maxSeedingMinutes < 0) return;

    for (const t of this.client.torrents) {
      if (!t.done) continue;
      const rec = this.records.get(t.infoHash);
      if (!rec || rec.shareLimitHit) continue;
      const ratioOk = maxRatio < 0 || t.ratio >= maxRatio;
      const seedingMs = Date.now() - (rec.doneAt || rec.addedAt);
      const timeOk = maxSeedingMinutes < 0 || seedingMs >= maxSeedingMinutes * 60_000;
      if (!ratioOk && !timeOk) continue;

      rec.shareLimitHit = true;
      const name = t.name || t.infoHash.slice(0, 8);
      const reason = ratioOk ? `分享率 ${t.ratio.toFixed(2)} ≥ ${maxRatio}` : `做种时长 ${Math.floor(seedingMs / 60000)} 分钟`;
      if (action === 'remove' || action === 'remove-with-content') {
        this.remove(t.infoHash, action === 'remove-with-content');
        this.emit('notice', { type: 'info', text: `做种限制触发（${reason}），已移除任务：${name}` });
      } else {
        this.pause(t.infoHash);
        this.emit('notice', { type: 'info', text: `做种限制触发（${reason}），已停止做种：${name}` });
      }
    }
  }

  async start() {
    if (this.started) return;
    this.started = true;

    fs.mkdirSync(this.downloadDir, { recursive: true });

    this.client = new WebTorrent({ maxConns: 100 });
    this.client.on('error', (err) => {
      this.emit('notice', { type: 'error', text: `引擎错误：${err?.message || err}` });
    });

    // 恢复上一次会话
    const saved = await this._loadState();
    for (const item of saved) {
      if (!item?.uri) continue;
      try {
        this._add(item.uri, { path: item.path, paused: !!item.paused, silent: true });
      } catch (err) {
        this.emit('notice', { type: 'warn', text: `恢复失败：${err.message}` });
      }
    }

    this.timer = setInterval(() => this._broadcast(), TICK_MS);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this._saveState();
    if (this.client) {
      await new Promise((resolve) => this.client.destroy(resolve));
      this.client = null;
    }
  }

  // ---------------------------------------------------------------- 公开操作

  /** 添加 magnet 链接 / info hash / .torrent 的 Buffer */
  add(uri, opts = {}) {
    return this._add(uri, opts);
  }

  pause(infoHash) {
    const t = this._torrentOf(infoHash);
    if (!t) return false;
    if (typeof t.pause === 'function') t.pause();
    const rec = this.records.get(infoHash);
    if (rec) rec.paused = true;
    this._saveState();
    this._broadcast();
    return true;
  }

  resume(infoHash) {
    const t = this._torrentOf(infoHash);
    if (!t) return false;
    if (typeof t.resume === 'function') t.resume();
    const rec = this.records.get(infoHash);
    if (rec) rec.paused = false;
    this._saveState();
    this._broadcast();
    return true;
  }

  // -------------------------------------------------- 全局限速（借鉴迅雷 GlobalVIPThreshold 模型）

  /** 设置全局下载/上传限速（字节/秒，-1 = 不限速） */
  setSpeedLimit(downBytes, upBytes) {
    if (!this.client) return false;
    try {
      this.client.downloadLimit = Number.isFinite(downBytes) ? downBytes : -1;
      this.client.uploadLimit = Number.isFinite(upBytes) ? upBytes : -1;
      this.limits = { down: downBytes, up: upBytes };
      this.emit('notice', {
        type: 'info',
        text: `限速已更新：↓ ${downBytes < 0 ? '不限' : Math.round(downBytes / 1024) + ' KB/s'} · ↑ ${upBytes < 0 ? '不限' : Math.round(upBytes / 1024) + ' KB/s'}`
      });
      return true;
    } catch (err) {
      this.emit('notice', { type: 'error', text: `限速设置失败：${err.message}` });
      return false;
    }
  }

  // -------------------------------------------------- 文件级选择下载（借鉴迅雷任务内文件勾选）

  /** 获取某任务的文件列表（含选中状态） */
  filesOf(infoHash) {
    const t = this._torrentOf(infoHash);
    if (!t?.files) return [];
    const rec = this.records.get(infoHash) || {};
    const deselected = new Set(rec.deselected || []);
    return t.files.map((f, i) => ({
      index: i,
      name: f.name,
      path: f.path,
      size: f.length,
      downloaded: f.downloaded || 0,
      // 钳制负数进度
      progress: Math.max(0, Math.min(1, f.progress || 0)),
      selected: !deselected.has(i)
    }));
  }

  /** 勾选/取消勾选某任务中的文件（取消的不再下载，已下载的保留） */
  setFileSelection(infoHash, selections) {
    const t = this._torrentOf(infoHash);
    if (!t?.files) return false;
    const rec = this.records.get(infoHash);
    if (!rec) return false;

    if (!rec.deselected) rec.deselected = [];
    for (const { index, selected } of selections) {
      const f = t.files[index];
      if (!f) continue;
      if (selected) {
        f.select();
        rec.deselected = rec.deselected.filter((i) => i !== index);
      } else {
        f.deselect();
        if (!rec.deselected.includes(index)) rec.deselected.push(index);
      }
    }
    this._saveState();
    this._broadcast();
    return true;
  }

  // -------------------------------------------------- 边下边播（借鉴迅雷 GCDWebServer 本地流媒体）

  /**
   * 启动全局流媒体服务器（client 级，一次启动服务所有任务）。
   * URL 格式: http://localhost:<port>/webtorrent/<infoHash>/<fileIndex>/<fileName>
   */
  ensureStreamServer() {
    if (this.streamServer) return this.streamServer;
    const server = this.client.createServer({ pathname: '/webtorrent' }, 'node');
    server.listen(0); // 随机可用端口
    this.streamServer = server;
    return server;
  }

  /** 某任务第 index 个文件的流媒体地址（路径必须匹配 file.path） */
  streamUrl(infoHash, index = 0) {
    const t = this._torrentOf(infoHash);
    if (!t?.files?.[index]) return null;
    const server = this.streamServer;
    if (!server) return null;
    const port = server.address?.()?.port;
    if (!port) return null;
    // 服务器按 file.path（相对种子根目录）匹配，需保留目录结构
    const filePath = t.files[index].path.replace(/\\/g, '/');
    return `http://localhost:${port}/webtorrent/${t.infoHash}/${filePath
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
  }

  startStream(infoHash, index = 0) {
    const t = this._torrentOf(infoHash);
    if (!t) return { ok: false, error: '任务不存在' };
    if (!t.ready) return { ok: false, error: '元数据尚未就绪，无法播放' };
    try {
      this.ensureStreamServer();
      const url = this.streamUrl(infoHash, index);
      if (!url) return { ok: false, error: '无法生成播放地址' };
      return { ok: true, url };
    } catch (err) {
      return { ok: false, error: `流媒体启动失败：${err.message}` };
    }
  }

  stopStream() {
    if (this.streamServer) {
      try { this.streamServer.close(); } catch {}
      this.streamServer = null;
    }
  }

  async remove(infoHash, deleteFiles = false) {
    const t = this._torrentOf(infoHash);
    let target = null;
    if (t) {
      // 若已无其他任务，关闭流媒体服务器
      if (this.client?.torrents?.length <= 1) this.stopStream();
      const name = t.name;
      const base = t.path;
      if (name && base) target = path.join(base, name);
      try {
        await new Promise((resolve) => this.client.remove(infoHash, { destroyStore: deleteFiles }, resolve));
      } catch {
        // 忽略：文件可能被占用 / 已删除
      }
    }
    if (deleteFiles && target) {
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    }
    this.records.delete(infoHash);
    await this._saveState();
    this._broadcast();
    return true;
  }

  /** 该种子应打开的文件夹 */
  folderOf(infoHash) {
    const t = this._torrentOf(infoHash);
    const rec = this.records.get(infoHash);
    if (t) {
      const name = t.name;
      const base = t.path || rec?.path || this.downloadDir;
      if (!name) return base;
      const candidate = path.join(base, name);
      return this._isDir(candidate) ? candidate : base;
    }
    return rec?.path || this.downloadDir;
  }

  setDownloadDir(dir) {
    this.downloadDir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  // ---------------------------------------------------------------- 内部实现

  _add(uri, { path: targetPath, paused = false, silent = false } = {}) {
    if (!this.client) throw new Error('引擎尚未启动');

    const existingHash = this._hashOf(uri);
    if (existingHash && this._torrentOf(existingHash)) {
      throw new Error('该下载任务已存在');
    }

    const savePath = targetPath || this.downloadDir;
    fs.mkdirSync(savePath, { recursive: true });

    const isBuffer = Buffer.isBuffer(uri);
    const torrent = this.client.add(uri, {
      path: savePath,
      announce: EXTRA_TRACKERS,
      // WebTorrent 3.x 支持创建即暂停
      paused
    });

    if (!torrent) throw new Error('无法创建任务');

    // WebTorrent 3.x 中 infoHash 是异步设置的（通过 _infoHash 事件），
    // 因此记录与广播都放到该事件之后，保证 infoHash 一定可用。
    const finalize = () => {
      const infoHash = torrent.infoHash;
      if (!infoHash || this.records.has(infoHash)) return;

      this.records.set(infoHash, {
        uri: isBuffer ? torrent.magnetURI || this._toMagnet(torrent) : String(uri),
        path: savePath,
        paused,
        addedAt: Date.now()
      });

      torrent.on('error', (err) => {
        if (!silent) this.emit('notice', { type: 'error', text: `${err?.message || err}` });
      });
      torrent.on('warning', () => {});
      torrent.on('done', () => {
        const rec = this.records.get(torrent.infoHash);
        if (rec && !rec.doneAt) rec.doneAt = Date.now();
        this._settingsDoneNotice(torrent);
        this._broadcast();
      });

      this._saveState();
      this._broadcast();
    };

    if (torrent.infoHash) finalize();
    else torrent.once('_infoHash', finalize);
    // 兜底：若解析失败（无效种子），给出提示
    torrent.once('error', (err) => {
      if (!torrent.infoHash && !silent) {
        this.emit('notice', { type: 'error', text: `无法解析该链接：${err?.message || err}` });
      }
    });

    return torrent.infoHash || this._hashOf(uri) || 'pending';
  }

  _toMagnet(torrent) {
    try {
      return torrent.magnetURI || `magnet:?xt=urn:btih:${torrent.infoHash}`;
    } catch {
      return `magnet:?xt=urn:btih:${torrent.infoHash}`;
    }
  }

  /**
   * 同步查找 torrent（WebTorrent 3.x 的 client.get 是 async，不能直接用于同步判断）
   * 支持传 infoHash 或 magnet 链接
   */
  _torrentOf(id) {
    const list = this.client?.torrents;
    if (!list?.length) return null;
    const key = String(id || '').toLowerCase();
    const wanted = this._hashOf(key) || key;
    return list.find((t) => {
      if (!t?.infoHash) return false;
      const h = String(t.infoHash).toLowerCase();
      return h === wanted || String(t.magnetURI || '').toLowerCase().includes(wanted);
    }) || null;
  }

  _hashOf(uri) {
    if (Buffer.isBuffer(uri)) return null;
    const s = String(uri);
    const m = s.match(/xt=urn:btih:([a-zA-Z0-9]{32,40})/i);
    if (m) return m[1].toLowerCase();
    if (/^[a-f0-9]{40}$/i.test(s)) return s.toLowerCase();
    return null;
  }

  _isDir(p) {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  _settingsDoneNotice(torrent) {
    this.emit('notice', {
      type: 'success',
      text: `已完成：${torrent.name || torrent.infoHash.slice(0, 8)}`
    });
  }

  serialize(t) {
    const rec = this.records.get(t.infoHash) || {};
    const paused = rec.paused ?? t.paused ?? false;
    const deselected = rec.deselected || [];
    return {
      infoHash: t.infoHash,
      name: t.name || '',
      magnetURI: t.magnetURI || rec.uri || '',
      progress: t.done ? 1 : t.progress || 0,
      downloadSpeed: paused ? 0 : t.downloadSpeed || 0,
      uploadSpeed: paused ? 0 : t.uploadSpeed || 0,
      downloaded: t.downloaded || 0,
      uploaded: t.uploaded || 0,
      length: t.length || 0,
      numPeers: t.numPeers || 0,
      // 注意：WebTorrent 的 timeRemaining 单位是毫秒，这里统一换算成秒给界面用
      timeRemaining: t.done ? 0 : Number.isFinite(t.timeRemaining) ? t.timeRemaining / 1000 : Infinity,
      ratio: t.ratio || 0,
      done: !!t.done,
      paused,
      ready: !!t.ready,
      files: t.files ? t.files.length : 0,
      path: t.path || rec.path || this.downloadDir,
      addedAt: rec.addedAt || 0,
      // 文件明细（含勾选状态），供 UI 展开文件列表
      fileDetails: t.files
        ? t.files.map((f, i) => ({
            index: i,
            name: f.name,
            size: f.length,
            // WebTorrent 的文件级 progress 对未开始的小文件可能返回负数，钳制到 [0,1]
            progress: Math.max(0, Math.min(1, f.progress || 0)),
            selected: !deselected.includes(i)
          }))
        : []
    };
  }

  serializeAll() {
    if (!this.client) return [];
    return this.client.torrents.map((t) => this.serialize(t));
  }

  stats() {
    const list = this.serializeAll();
    return {
      downloadSpeed: list.reduce((a, b) => a + b.downloadSpeed, 0),
      uploadSpeed: list.reduce((a, b) => a + b.uploadSpeed, 0),
      count: list.length,
      active: list.filter((t) => !t.done && !t.paused).length,
      done: list.filter((t) => t.done).length,
      // 限速状态（-1 = 不限）
      limits: this.limits || { down: -1, up: -1 }
    };
  }

  _broadcast() {
    this._checkShareLimits();
    this.emit('update', { torrents: this.serializeAll(), stats: this.stats() });
  }

  // ---------------------------------------------------------------- 持久化

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
      this._dirty = true;
      return;
    }
    this._saving = true;
    const data = [...this.records.entries()].map(([infoHash, rec]) => ({
      infoHash,
      uri: rec.uri,
      path: rec.path,
      paused: !!rec.paused,
      addedAt: rec.addedAt,
      deselected: rec.deselected || []
    }));
    try {
      await fsp.mkdir(path.dirname(this.stateFile), { recursive: true });
      // 原子写：先写临时文件再 rename，防止写入中途崩溃损坏状态文件
      const tmp = this.stateFile + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fsp.rename(tmp, this.stateFile);
      this._dirty = false;
    } catch {
      // 持久化失败不影响使用
    } finally {
      this._saving = false;
      if (this._dirty) this._saveStateSoon();
    }
  }
}
