const api = window.bt;

const RING_LEN = 2 * Math.PI * 15.5; // ≈ 97.4

const el = {
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  input: document.getElementById('magnet-input'),
  addBtn: document.getElementById('add-btn'),
  fileBtn: document.getElementById('file-btn'),
  dirBtn: document.getElementById('dir-btn'),
  dirText: document.getElementById('dir-text'),
  statusText: document.getElementById('status-text'),
  statusHint: document.getElementById('status-hint'),
  toasts: document.getElementById('toasts'),
  gsDown: document.getElementById('gs-down'),
  gsUp: document.getElementById('gs-up'),
  gsCount: document.getElementById('gs-count'),
  cAll: document.getElementById('c-all'),
  cActive: document.getElementById('c-active'),
  cDone: document.getElementById('c-done'),
  cPaused: document.getElementById('c-paused'),
  tpl: document.getElementById('row-template'),
  // 限速弹窗
  speedBtn: document.getElementById('speed-btn'),
  speedLabel: document.getElementById('speed-label'),
  speedModal: document.getElementById('speed-modal'),
  limitDown: document.getElementById('limit-down'),
  limitUp: document.getElementById('limit-up'),
  speedSave: document.getElementById('speed-save'),
  speedCancel: document.getElementById('speed-cancel'),
  // 文件选择弹窗
  filesModal: document.getElementById('files-modal'),
  filesTitle: document.getElementById('files-title'),
  filesList: document.getElementById('files-list'),
  filesSave: document.getElementById('files-save'),
  filesCancel: document.getElementById('files-cancel'),
  // 速度图表
  chartBtn: document.getElementById('chart-btn'),
  chartModal: document.getElementById('chart-modal'),
  chartTabs: document.getElementById('chart-tabs'),
  chartCanvas: document.getElementById('chart-canvas'),
  chartNow: document.getElementById('chart-now'),
  chartClose: document.getElementById('chart-close')
};

const state = { torrents: [], stats: {}, downloadDir: '', filter: 'all' };
/** infoHash -> { root, refs } */
const nodes = new Map();
/** 文件选择弹窗当前编辑的任务 hash 与勾选状态 */
let filesEditing = null; // { hash, selections: Map<index, boolean> }

// ---------------------------------------------------------------- 工具函数
function fmtBytes(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${u[i]}`;
}

/**
 * 按当前操作系统返回系统术语（platform.js 写入 html[data-os]）。
 * 仅用于面向用户的文案，逻辑判断仍应以主进程的 process.platform 为准。
 */
const OS = document.documentElement.dataset.os || 'linux';
/** 「在文件管理器中显示」在各平台的说法 */
const OS_TERMS = {
  mac: { reveal: '在访达中显示', fileManager: '访达' },
  win: { reveal: '在资源管理器中显示', fileManager: '资源管理器' },
  linux: { reveal: '在文件管理器中显示', fileManager: '文件管理器' }
};
const terms = OS_TERMS[OS] || OS_TERMS.linux;
function fmtSpeed(n) {
  return n > 0 ? `${fmtBytes(n)}/s` : '—';
}
function fmtEta(sec) {
  if (sec === 0) return '已完成';
  if (!Number.isFinite(sec) || sec < 0) return '剩余 —';

  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);

  if (d > 0) return `剩余 ${d}天${h}小时`;
  if (h > 0) return `剩余 ${h}小时${m}分`;
  if (m > 0) return `剩余 ${m}分${s}秒`;
  if (s > 0) return `剩余 ${s}秒`;
  return '即将完成';
}
/** 格式化"已等待时长" */
function fmtWaited(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

let toastId = 0;
function toast(text, type = 'info', ms = 3200) {
  const id = ++toastId;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.dataset.id = String(id);
  node.textContent = text;
  el.toasts.appendChild(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  }, ms);
}

function closeMenus() {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
}

// ---------------------------------------------------------------- 渲染
function statusOf(t) {
  if (t.kind === 'http') {
    if (t.status === 'done') return 'done';
    if (t.status === 'error') return 'error';
    if (t.status === 'paused' || t.status === 'queued') return 'paused';
    if (t.status === 'probing') return 'meta';
    return 'active';
  }
  if (t.done) return 'done';
  if (t.paused) return 'paused';
  return t.ready === false ? 'meta' : 'active';
}

function visible(t) {
  if (state.filter === 'active') return !t.done && !t.paused;
  if (state.filter === 'done') return t.done;
  if (state.filter === 'paused') return t.paused;
  return true;
}

function createRow(t) {
  const root = el.tpl.content.firstElementChild.cloneNode(true);
  const refs = {
    ringFg: root.querySelector('.ring-fg'),
    ringTxt: root.querySelector('.ring-txt'),
    name: root.querySelector('.row-name'),
    badge: root.querySelector('.row-badge'),
    barFill: root.querySelector('.bar-fill'),
    size: root.querySelector('.m-size'),
    speed: root.querySelector('.m-speed'),
    peers: root.querySelector('.m-peers'),
    eta: root.querySelector('.m-eta'),
    toggle: root.querySelector('.act-toggle'),
    folder: root.querySelector('.act-folder'),
    more: root.querySelector('.act-more'),
    play: root.querySelector('.act-play'),
    files: root.querySelector('.act-files')
  };
  refs.ringFg.style.strokeDasharray = String(RING_LEN);

  // 复制下载链接（HTTP 任务复制直链，BT 任务复制磁力）
  refs.name.addEventListener('click', () => {
    const cur = nodes.get(root.dataset.hash);
    if (!cur?.data?.magnetURI) return;
    navigator.clipboard.writeText(cur.data.magnetURI);
    toast(cur.data.kind === 'http' ? '下载链接已复制' : '磁力链接已复制', 'success', 1600);
  });
  refs.name.title = '点击复制下载链接';

  // 暂停 / 继续
  refs.toggle.addEventListener('click', async () => {
    const cur = nodes.get(root.dataset.hash);
    if (!cur) return;
    if (cur.data.paused) await api.resume(cur.data.infoHash);
    else await api.pause(cur.data.infoHash);
  });

  // 播放（边下边播 / 打开本地文件）
  refs.play.addEventListener('click', async () => {
    const cur = nodes.get(root.dataset.hash);
    if (!cur) return;
    // 多文件任务先弹文件选择，单文件直接播
    const details = cur.data.fileDetails || [];
    if (details.length > 1) {
      openFilesModal(cur.data, 'play');
      return;
    }
    const res = await api.play(cur.data.infoHash, 0);
    if (!res.ok && res.error) toast(res.error, 'error');
    else if (res.ok) toast(res.local ? '已用系统播放器打开本地文件' : '已启动边下边播（用系统播放器打开）', 'success');
  });

  // 文件选择
  refs.files.addEventListener('click', () => {
    const cur = nodes.get(root.dataset.hash);
    if (!cur) return;
    openFilesModal(cur.data, 'select');
  });

  // 打开文件夹
  refs.folder.addEventListener('click', async () => {
    const cur = nodes.get(root.dataset.hash);
    if (!cur) return;
    const res = await api.openFolder(cur.data.infoHash);
    if (!res.ok && res.error) toast(res.error, 'error');
  });

  // 更多菜单
  refs.more.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeMenus();
    const cur = nodes.get(root.dataset.hash);
    if (!cur) return;
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.innerHTML = `
      <button data-act="copy">复制下载链接</button>
      <button data-act="folder">${terms.reveal}</button>
      <button data-act="remove" class="danger">移除任务（保留文件）</button>
      <button data-act="remove-files" class="danger">移除任务并删除文件</button>`;
    document.body.appendChild(menu);
    const r = ev.currentTarget.getBoundingClientRect();
    menu.style.left = `${Math.min(r.left - 140, window.innerWidth - 196)}px`;
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 190)}px`;

    menu.addEventListener('click', async (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      menu.remove();
      const hash = cur.data.infoHash;
      if (act === 'copy') {
        navigator.clipboard.writeText(cur.data.magnetURI);
        toast(cur.data.kind === 'http' ? '下载链接已复制' : '磁力链接已复制', 'success', 1600);
      } else if (act === 'folder') {
        await api.reveal(hash);
      } else if (act === 'remove') {
        await api.remove(hash, false);
        toast('已移除任务（文件保留）', 'info');
      } else if (act === 'remove-files') {
        await api.remove(hash, true);
        toast('已移除任务并删除文件', 'warn');
      }
    });
  });

  return { root, refs };
}

function updateRow(entry, t) {
  const { root, refs, data } = entry;
  const status = statusOf(t);
  const pct = Math.round(t.progress * 100);

  root.classList.toggle('is-done', status === 'done');
  root.classList.toggle('is-paused', status === 'paused');
  root.classList.toggle('is-meta', status === 'meta');
  root.classList.toggle('is-error', status === 'error');
  root.classList.toggle('is-http', t.kind === 'http');

  refs.ringFg.style.strokeDashoffset = String(RING_LEN * (1 - (status === 'done' ? 1 : t.progress)));
  refs.ringTxt.textContent = `${pct}%`;
  refs.name.textContent = t.name || `获取元数据中… ${t.infoHash.slice(0, 10)}`;
  refs.barFill.style.width = `${(status === 'done' ? 1 : t.progress) * 100}%`;

  const badgeText =
    status === 'done'
      ? '已完成'
      : status === 'paused'
        ? t.status === 'queued'
          ? '排队中'
          : '已暂停'
        : status === 'error'
          ? '失败'
          : status === 'meta'
            ? t.kind === 'http'
              ? '解析中'
              : '连接中'
            : t.kind === 'http'
              ? '直链下载'
              : '下载中';
  refs.badge.textContent = badgeText;

  const done = t.length ? (t.downloaded + (t.done ? 0 : 0)) : 0;
  refs.size.textContent = t.length
    ? `${fmtBytes(Math.min(t.downloaded, t.length))} / ${fmtBytes(t.length)}`
    : '大小未知';

  if (status === 'done') {
    refs.speed.textContent = t.uploaded > 0 ? `已上传 ${fmtBytes(t.uploaded)}` : t.kind === 'http' ? '已保存到下载目录' : '持续做种中';
  } else if (status === 'paused') {
    refs.speed.textContent = t.status === 'queued' ? '排队等待中' : '已暂停';
  } else if (status === 'error') {
    refs.speed.textContent = `失败：${t.error || '未知错误'}`;
  } else {
    refs.speed.textContent = `${fmtSpeed(t.downloadSpeed)}  ↓   ${fmtSpeed(t.uploadSpeed)}  ↑`;
  }
  refs.peers.textContent =
    t.kind === 'http'
      ? `${t.numPeers} 线程${t.length ? ` · ${fmtBytes(t.length)}` : ''}`
      : `${t.numPeers} 个连接${t.files ? ` · ${t.files} 个文件` : ''}`;
  refs.eta.textContent = status === 'paused' || status === 'error' ? '' : fmtEta(t.timeRemaining);

  // 播放按钮：BT 元数据就绪 / HTTP 已完成时显示
  const hasFiles = t.kind === 'http' ? t.status === 'done' : (t.fileDetails?.length || 0) > 0;
  refs.play.style.display = hasFiles ? '' : 'none';
  // 文件选择按钮：多文件 BT 任务才显示
  refs.files.style.display = t.kind !== 'http' && hasFiles && t.fileDetails.length > 1 ? '' : 'none';

  // 卡住诊断提示：连线中但长时间 0 peer，或已有 peer 但速度极低
  const waited = t.addedAt ? Date.now() - t.addedAt : 0;
  let hint = '';
  if (status === 'error') {
    hint = `❌ ${t.error || '下载失败'}。点击 ▶ 按钮可重试（已下载的部分会保留）。`;
  } else if (t.kind === 'http' && t.status === 'probing' && waited > 20000) {
    hint = `⚠️ 服务器响应缓慢（已等待 ${fmtWaited(waited)}）。可能是链接失效或服务器限流，可稍后暂停再继续重试。`;
  } else if (status === 'meta' && waited > 90000) {
    hint = `⚠️ 已等待 ${fmtWaited(waited)} 仍找不到分享者。该资源可能已无人在做种（死种），或做种者都处于 NAT 后无法连接。建议换个种源，或稍后再试。`;
  } else if (status === 'meta' && waited > 25000) {
    hint = `正在寻找分享者…（已等 ${fmtWaited(waited)}）。如果长时间不动，多半是资源本身没有可用做种者。`;
  } else if (status === 'active' && t.numPeers > 0 && t.downloadSpeed < 20 * 1024 && t.progress < 1 && waited > 60000) {
    hint = `⚡ 已连上 ${t.numPeers} 个分享者，但总速度只有 ${fmtSpeed(t.downloadSpeed)}。说明分享者上传带宽有限（BT 速度由对方决定，不是你的网速问题）。此文件 ${fmtBytes(t.length)}，按此速度需要很久。`;
  } else if (status === 'active' && t.numPeers === 0 && waited > 60000) {
    hint = `⚠️ 曾连上分享者但又全部断开（当前 0 连接）。可能对方已下线，请稍等或换个种源。`;
  }

  let hintEl = root.querySelector('.row-hint');
  if (hint) {
    if (!hintEl) {
      hintEl = document.createElement('div');
      hintEl.className = 'row-hint';
      refs.peers.parentElement.after(hintEl);
    }
    hintEl.textContent = hint;
  } else if (hintEl) {
    hintEl.remove();
  }

  refs.toggle.title = t.paused ? '继续' : '暂停';
  refs.toggle.innerHTML = t.paused
    ? `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M4.5 2.8 13 8l-8.5 5.2z" fill="currentColor"/></svg>`
    : `<svg viewBox="0 0 16 16" width="15" height="15"><rect x="4" y="3" width="2.6" height="10" rx="1" fill="currentColor"/><rect x="9.4" y="3" width="2.6" height="10" rx="1" fill="currentColor"/></svg>`;

  void done;
}

function render() {
  const all = state.torrents;
  el.cAll.textContent = String(all.length);
  el.cActive.textContent = String(all.filter((t) => !t.done && !t.paused).length);
  el.cDone.textContent = String(all.filter((t) => t.done).length);
  el.cPaused.textContent = String(all.filter((t) => t.paused).length);

  el.gsDown.textContent = fmtSpeed(state.stats.downloadSpeed);
  el.gsUp.textContent = fmtSpeed(state.stats.uploadSpeed);
  el.gsCount.textContent = `${state.stats.count || 0} 个任务`;
  el.dirText.textContent = state.downloadDir || '—';
  updateSpeedLabel();

  const shown = all.filter(visible);
  el.empty.style.display = shown.length ? 'none' : 'flex';
  if (!shown.length) {
    el.empty.querySelector('h2').textContent =
      state.filter === 'all' ? '还没有任务' : '这个分类下没有任务';
  }

  // 排序：未完成在前，按添加时间倒序
  const order = [...shown].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (b.addedAt || 0) - (a.addedAt || 0);
  });

  const seen = new Set();
  let cursor = el.empty;
  for (const t of order) {
    seen.add(t.infoHash);
    let entry = nodes.get(t.infoHash);
    if (!entry) {
      const created = createRow(t);
      created.root.dataset.hash = t.infoHash;
      entry = { ...created, data: t };
      nodes.set(t.infoHash, entry);
    } else {
      entry.data = t;
    }
    entry.root.dataset.status = statusOf(t);
    updateRow(entry, t);
    // 保持顺序
    const desired = cursor.nextElementSibling;
    if (desired !== entry.root) el.list.insertBefore(entry.root, desired || null);
    cursor = entry.root;
  }

  for (const [hash, entry] of nodes) {
    if (!seen.has(hash)) {
      entry.root.remove();
      nodes.delete(hash);
    }
  }

  // 状态栏
  const active = all.filter((t) => !t.done && !t.paused).length;
  el.statusText.textContent = active ? `${active} 个任务下载中` : '空闲';
  el.statusHint.textContent = `${fmtSpeed(state.stats.downloadSpeed)} ↓ · ${fmtSpeed(state.stats.uploadSpeed)} ↑`;
}

// ---------------------------------------------------------------- 事件绑定
el.addBtn.addEventListener('click', async () => {
  const text = el.input.value.trim();
  if (!text) return el.input.focus();
  const res = await api.addMagnet(text);
  if (res.ok) {
    el.input.value = '';
    toast(`已添加 ${res.added} 个任务`, 'success');
    if (res.error) toast(res.error, 'warn', 4200);
  } else {
    toast(res.error || '添加失败', 'error', 4200);
  }
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.addBtn.click();
});

el.fileBtn.addEventListener('click', async () => {
  const res = await api.addTorrentFile();
  if (res.canceled) return;
  if (res.ok) {
    toast(`已添加 ${res.added} 个下载任务`, 'success');
    if (res.error) toast(res.error, 'warn', 4200);
  } else {
    toast(res.error || '添加失败', 'error');
  }
});

el.dirBtn.addEventListener('click', async () => {
  const picked = await api.chooseDir();
  if (picked.canceled || !picked.ok) return;
  const res = await api.setDownloadDir(picked.dir);
  if (res.ok) {
    state.downloadDir = res.dir;
    render();
    toast('下载目录已更新（仅对新任务生效）', 'success');
  }
});

document.querySelectorAll('.filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    render();
  });
});

// ---------------------------------------------------------------- 文件选择弹窗
function openFilesModal(t, mode) {
  filesEditing = { hash: t.infoHash, mode, selections: new Map(), picked: -1 };
  el.filesTitle.textContent = t.name || '文件列表';
  el.filesList.innerHTML = '';
  // 播放模式下按钮语义不同：选文件是为了播它，不是为了勾选下载
  el.filesSave.textContent = mode === 'play' ? '播放选中文件' : '应用';

  for (const f of t.fileDetails || []) {
    const item = document.createElement('label');
    item.className = `file-item${f.selected ? '' : ' skipped'}`;
    item.innerHTML = `
      <input type="checkbox" data-index="${f.index}" ${f.selected ? 'checked' : ''} />
      <span class="f-name" title="${f.name}">${f.name}</span>
      <span class="f-prog">${Math.round((f.progress || 0) * 100)}%</span>
      <span class="f-size">${fmtBytes(f.size)}</span>`;
    const cb = item.querySelector('input');
    cb.addEventListener('change', () => {
      filesEditing.selections.set(Number(cb.dataset.index), cb.checked);
      item.classList.toggle('skipped', !cb.checked);
    });
    // 播放模式：点文件名直接选中这一个（不受勾选状态影响）
    if (mode === 'play') {
      const nameEl = item.querySelector('.f-name');
      nameEl.style.cursor = 'pointer';
      nameEl.title = `${f.name}（点击选中播放）`;
      nameEl.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        filesEditing.picked = f.index;
        el.filesList
          .querySelectorAll('.file-item')
          .forEach((n) => n.classList.remove('playing'));
        item.classList.add('playing');
      });
    }
    el.filesList.appendChild(item);
  }
  el.filesModal.hidden = false;
}

el.filesSave.addEventListener('click', async () => {
  if (!filesEditing) return closeModals();
  const { hash, selections, mode, picked } = filesEditing;

  // 播放模式：播用户点选的文件；没点选则回退到第一个已下载/已勾选的文件
  if (mode === 'play') {
    const details = state.torrents.find((t) => t.infoHash === hash)?.fileDetails || [];
    const fallback =
      details.find((f) => f.selected && f.progress > 0) || details.find((f) => f.selected);
    const index = picked >= 0 ? picked : fallback?.index ?? 0;
    filesEditing = null;
    closeModals();
    const res = await api.play(hash, index);
    if (!res.ok && res.error) toast(res.error, 'error');
    else if (res.ok) {
      toast(res.local ? '已用系统播放器打开本地文件' : '已启动边下边播（用系统播放器打开）', 'success');
    }
    return;
  }

  // 选择模式：提交勾选结果
  if (selections.size > 0) {
    const list = [...selections.entries()].map(([index, selected]) => ({ index, selected }));
    const res = await api.setFileSelection(hash, list);
    if (res.ok) toast('文件选择已更新', 'success');
    else toast('更新失败', 'error');
  }
  filesEditing = null;
  closeModals();
});
el.filesCancel.addEventListener('click', () => { filesEditing = null; closeModals(); });

// ---------------------------------------------------------------- 限速弹窗
function openSpeedModal() {
  const limits = state.stats?.limits || { down: -1, up: -1 };
  el.limitDown.value = limits.down > 0 ? Math.round(limits.down / 1024) : '';
  el.limitUp.value = limits.up > 0 ? Math.round(limits.up / 1024) : '';
  el.speedModal.hidden = false;
}

el.speedBtn.addEventListener('click', openSpeedModal);
el.speedCancel.addEventListener('click', closeModals);
el.speedSave.addEventListener('click', async () => {
  const d = parseFloat(el.limitDown.value);
  const u = parseFloat(el.limitUp.value);
  const down = Number.isFinite(d) && d > 0 ? Math.round(d * 1024) : -1;
  const up = Number.isFinite(u) && u > 0 ? Math.round(u * 1024) : -1;
  const res = await api.setLimits(down, up);
  if (res.ok) {
    state.stats.limits = { down, up };
    updateSpeedLabel();
    closeModals();
  }
});

function updateSpeedLabel() {
  const l = state.stats?.limits || { down: -1, up: -1 };
  if (l.down < 0 && l.up < 0) {
    el.speedLabel.textContent = '不限速';
    el.speedBtn.classList.remove('limited');
  } else {
    const parts = [];
    if (l.down > 0) parts.push(`↓${fmtSpeed(l.down)}`);
    if (l.up > 0) parts.push(`↑${fmtSpeed(l.up)}`);
    el.speedLabel.textContent = parts.join(' ') || '已限速';
    el.speedBtn.classList.add('limited');
  }
}

function closeModals() {
  el.speedModal.hidden = true;
  el.filesModal.hidden = true;
  el.chartModal.hidden = true;
  stopChartLoop();
}

// ---------------------------------------------------------------- 速度图表
let chartWindow = '5m';
let chartTimer = null;
let chartWindows = [];

function openChart() {
  el.chartModal.hidden = false;
  buildChartTabs();
  drawChart();
  // 打开期间每秒刷新
  stopChartLoop();
  chartTimer = setInterval(drawChart, 1000);
}
function stopChartLoop() {
  if (chartTimer) clearInterval(chartTimer);
  chartTimer = null;
}

async function buildChartTabs() {
  if (!chartWindows.length) {
    const res = await api.speedSeries(chartWindow);
    chartWindows = res.windows || [];
    el.chartTabs.innerHTML = '';
    for (const w of chartWindows) {
      const b = document.createElement('button');
      b.textContent = w.label;
      b.dataset.key = w.key;
      b.addEventListener('click', () => {
        chartWindow = w.key;
        el.chartTabs.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.dataset.key === w.key));
        drawChart();
      });
      el.chartTabs.appendChild(b);
    }
  }
  el.chartTabs.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.dataset.key === chartWindow));
}

async function drawChart() {
  const res = await api.speedSeries(chartWindow);
  const points = res.points || [];
  const canvas = el.chartCanvas;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const padL = 64;
  const padR = 12;
  const padT = 12;
  const padB = 24;
  ctx.clearRect(0, 0, W, H);

  // 网格与 Y 轴刻度
  const maxV = Math.max(1024 * 100, ...points.map((p) => Math.max(p.down, p.up))) * 1.15;
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.fillStyle = '#5d6a80';
  ctx.font = '11px -apple-system';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + ((H - padT - padB) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillText(fmtBytes(maxV * (1 - i / 4)) + '/s', 6, y + 4);
  }

  if (points.length < 2) {
    ctx.fillStyle = '#5d6a80';
    ctx.font = '13px -apple-system';
    ctx.fillText('正在积累数据…（保持窗口打开）', W / 2 - 90, H / 2);
    return;
  }

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t || t0 + 1;
  const x = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - v / maxV) * (H - padT - padB);

  const line = (key, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    points.forEach((p, i) => {
      const px = x(p.t);
      const py = y(p[key]);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.stroke();
    // 曲线下渐变填充
    const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
    grad.addColorStop(0, color + '33');
    grad.addColorStop(1, color + '00');
    ctx.fillStyle = grad;
    ctx.lineTo(x(points[points.length - 1].t), H - padB);
    ctx.lineTo(x(points[0].t), H - padB);
    ctx.closePath();
    ctx.fill();
  };
  line('down', '#4aa8ff');
  line('up', '#34d399');

  // 当前速度
  const last = points[points.length - 1];
  el.chartNow.textContent = `当前 ↓ ${fmtSpeed(last.down)} · ↑ ${fmtSpeed(last.up)}`;
}

el.chartBtn.addEventListener('click', openChart);
el.chartClose.addEventListener('click', closeModals);

// 点击遮罩关闭
for (const mask of [el.speedModal, el.filesModal]) {
  mask.addEventListener('click', (e) => {
    if (e.target === mask) closeModals();
  });
}

document.addEventListener('click', closeMenus);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMenus();
    closeModals();
  }
  if (e.key === 'v' && (e.metaKey || e.ctrlKey)) {
    // ⌘V 时如剪贴板是磁力链接，自动填入待确认
    navigator.clipboard.readText().then((txt) => {
      if (/^magnet:\?/i.test(txt.trim()) && !el.input.value.trim()) {
        el.input.value = txt.trim();
        toast('已从剪贴板填入下载链接，按回车添加', 'info', 2600);
      }
    }).catch(() => {});
  }
});

// 拖放 .torrent 文件 / 拖放磁力链接文本
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragover');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dragover');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragover');

  const text = e.dataTransfer.getData('text/plain');
  if (text && /magnet:\?/i.test(text)) {
    const res = await api.addMagnet(text.trim());
    if (res.ok) toast('已从拖放的链接添加任务', 'success');
    else toast(res.error || '添加失败', 'error');
    return;
  }

  const files = [...(e.dataTransfer.files || [])];
  const torrents = files.filter((f) => f.name.toLowerCase().endsWith('.torrent'));
  if (!torrents.length) return toast('只支持 .torrent 种子文件或下载链接', 'warn');
  for (const f of torrents) {
    const p = api.getFilePath ? api.getFilePath(f) : f.path;
    if (p) await api.addTorrentPath(p);
  }
  toast(`已添加 ${torrents.length} 个下载任务`, 'success');
});

// 实时更新
api.onUpdate((payload) => {
  state.torrents = payload.torrents || [];
  state.stats = payload.stats || {};
  render();
});

api.onNotice((payload) => {
  toast(payload.text, payload.type === 'warn' ? 'warn' : payload.type === 'success' ? 'success' : payload.type === 'error' ? 'error' : 'info', 4200);
});

// 初始化
(async () => {
  const initial = await api.getState();
  state.torrents = initial.torrents || [];
  state.stats = initial.stats || {};
  state.downloadDir = initial.downloadDir || '';
  render();
  // 磁盘信息（30s 周期由主进程维护，这里拉取显示）
  const refreshDisk = async () => {
    const d = await api.diskInfo();
    el.statusHint.textContent = `${fmtSpeed(state.stats.downloadSpeed)} ↓ · ${fmtSpeed(state.stats.uploadSpeed)} ↑ · ${d.text || ''}`;
  };
  refreshDisk();
  setInterval(refreshDisk, 30000);
})();
