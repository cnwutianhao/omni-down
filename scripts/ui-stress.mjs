// 桌面端 200 轮稳定性压测：通过 CDP 驱动运行中的 OmniDown（需 --remote-debugging-port=9222）
// 用法: node scripts/ui-stress.mjs [轮数=200] [测试服务器端口=18090] [下载目录]
// 每轮：真实 UI 输入框添加 HTTP 任务 →（部分轮次暂停/继续）→ 等待完成 → 校验磁盘文件 → 删除任务及文件
// 每 10 轮：一次性添加 6 个任务，验证并发上限 4 与排队
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROUNDS = Number(process.argv[2]) || 200;
const PORT = Number(process.argv[3]) || 18090;
const DL_DIR = process.argv[4] || '/tmp/omnidown-stress-dl';
const FILE_MB = 8;
const ROUND_TIMEOUT = 30_000;
const MAX_ACTIVE = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CDP
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('❌ 未找到应用页面');
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let msgId = 0;
const pending = new Map();
const consoleErrors = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});
await new Promise((r) => ws.on('open', r));
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description || 'eval 失败');
  return res.result?.result?.value;
};
await send('Runtime.enable');
await send('Performance.enable');

const getState = () => evaluate('window.bt.getState()');
const domRows = () => evaluate(`document.querySelectorAll('.row').length`);

async function rendererMetrics() {
  const { result } = await send('Performance.getMetrics');
  const m = Object.fromEntries(result.metrics.map((x) => [x.name, x.value]));
  return { heapMB: m.JSHeapUsedSize / 1048576, nodes: m.Nodes, listeners: m.JSEventListeners };
}
function electronRssMB() {
  try {
    const out = execSync(`ps -axo rss=,command= | grep -i "Electron.app/Contents" | grep -v grep`, { encoding: 'utf8' });
    return out.trim().split('\n').reduce((a, l) => a + Number(l.trim().split(/\s+/)[0]), 0) / 1024;
  } catch {
    return NaN;
  }
}

// ---------------------------------------------------------------- 准备
const health = await fetch(`http://127.0.0.1:${PORT}/probe`, { headers: { Range: 'bytes=0-0' } }).catch(() => null);
if (!health || health.status !== 206) {
  console.error(`❌ 测试服务器 ${PORT} 不可用`);
  process.exit(1);
}
fs.mkdirSync(DL_DIR, { recursive: true });
const setDir = await evaluate(`window.bt.setDownloadDir(${JSON.stringify(DL_DIR)})`);
const st0 = await getState();
if (st0.downloadDir !== DL_DIR) {
  console.error('❌ 下载目录切换失败', setDir, st0.downloadDir);
  process.exit(1);
}
if (st0.torrents.length) {
  console.error(`❌ 应用中已有 ${st0.torrents.length} 个任务，请使用独立 user-data-dir 运行`);
  process.exit(1);
}
// 用应用自身的全局限速把单任务拉长到可观测（本地回环否则 ~100ms 即完成，暂停/并发都观测不到）
const LIMIT = 16 * 1048576;
await evaluate(`window.bt.setLimits(${LIMIT}, -1)`);

// ---------------------------------------------------------------- 单轮逻辑
let seq = 0;
async function addViaUi(urls) {
  await evaluate(`(() => {
    const el = document.getElementById('magnet-input');
    el.value = ${JSON.stringify(urls.join(' '))}; // 单行 input 会吞掉 \\n，用空格分隔（与用户粘贴一致）
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('add-btn').click();
  })()`);
}

async function waitAllDone(ids, { onTick } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < ROUND_TIMEOUT) {
    const st = await getState();
    const mine = st.torrents.filter((t) => ids.has(t.infoHash));
    if (onTick) await onTick(st, mine);
    const err = mine.find((t) => t.status === 'error');
    if (err) return { ok: false, reason: `任务出错：${err.error}`, st };
    if (mine.length === ids.size && mine.every((t) => t.done)) return { ok: true, st, mine };
    await sleep(100);
  }
  return { ok: false, reason: '超时' };
}

async function waitNewIds(before, n) {
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    const st = await getState();
    const fresh = st.torrents.filter((t) => !before.has(t.infoHash));
    if (fresh.length >= n) return new Set(fresh.map((t) => t.infoHash));
    await sleep(50);
  }
  return null;
}

function verifyFiles(mine) {
  for (const t of mine) {
    if (!fs.existsSync(t.path)) return `文件不存在：${t.path}`;
    const size = fs.statSync(t.path).size;
    if (size !== FILE_MB * 1048576) return `大小不符：${path.basename(t.path)} ${size}`;
    if (fs.existsSync(t.path + '.part')) return `残留 .part：${t.path}`;
  }
  return null;
}

async function removeAll(ids) {
  for (const id of ids) await evaluate(`window.bt.remove(${JSON.stringify(id)}, true)`);
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    const [st, rows] = [await getState(), await domRows()];
    if (st.torrents.length === 0 && rows === 0) return null;
    await sleep(80);
  }
  return `移除后仍残留：state=${(await getState()).torrents.length} dom=${await domRows()}`;
}

async function runRound(i) {
  const batch = i % 10 === 0 ? 6 : 1;
  const doPause = batch === 1 && i % 3 === 0;
  const urls = Array.from({ length: batch }, () => `http://127.0.0.1:${PORT}/f${++seq}.bin?r=${seq}`);
  const before = new Set((await getState()).torrents.map((t) => t.infoHash));

  await addViaUi(urls);
  const ids = await waitNewIds(before, batch);
  if (!ids) return { ok: false, reason: '添加后任务未出现' };

  let maxActive = 0;
  let pauseInfo = null;
  if (doPause) {
    const id = [...ids][0];
    await sleep(60); // 让任务先进入下载中
    await evaluate(`window.bt.pause(${JSON.stringify(id)})`);
    await sleep(150);
    const s1 = (await getState()).torrents.find((t) => t.infoHash === id);
    const recvA = s1.downloaded;
    await sleep(400);
    const s2 = (await getState()).torrents.find((t) => t.infoHash === id);
    pauseInfo = { status: s2.status, frozen: s2.done || s2.downloaded === recvA };
    if (!s2.done && s2.status !== 'paused') return { ok: false, reason: `暂停无效：${s2.status}` };
    if (!pauseInfo.frozen) return { ok: false, reason: '暂停后仍在增长' };
    if (!s2.done) await evaluate(`window.bt.resume(${JSON.stringify(id)})`);
  }

  const res = await waitAllDone(ids, {
    onTick: (st, mine) => {
      maxActive = Math.max(maxActive, mine.filter((t) => t.status === 'downloading').length);
    }
  });
  if (!res.ok) return { ok: false, reason: res.reason };
  if (maxActive > MAX_ACTIVE) return { ok: false, reason: `并发超限：${maxActive}` };

  const rows = await domRows();
  if (rows !== res.st.torrents.length) return { ok: false, reason: `DOM 行数 ${rows} ≠ 任务数 ${res.st.torrents.length}` };
  const fileErr = verifyFiles(res.mine);
  if (fileErr) return { ok: false, reason: fileErr };
  const rmErr = await removeAll(ids);
  if (rmErr) return { ok: false, reason: rmErr };
  for (const t of res.mine) if (fs.existsSync(t.path)) return { ok: false, reason: `删除后文件仍存在：${t.path}` };

  return { ok: true, batch, maxActive, paused: !!pauseInfo };
}

// ---------------------------------------------------------------- 主循环
console.log(`━━━ OmniDown 桌面端稳定性压测：${ROUNDS} 轮，单文件 ${FILE_MB}MB，下载目录 ${DL_DIR} ━━━`);
const m0 = { ...(await rendererMetrics()), rss: electronRssMB() };
console.log(`初始：渲染堆 ${m0.heapMB.toFixed(1)}MB | DOM 节点 ${m0.nodes} | 监听器 ${m0.listeners} | Electron 总 RSS ${m0.rss.toFixed(0)}MB`);

const durations = [];
const failures = [];
const samples = [];
let tasks = 0, batches = 0, pauses = 0, maxActiveSeen = 0;
const tStart = Date.now();

for (let i = 1; i <= ROUNDS; i++) {
  const t0 = Date.now();
  let r;
  try {
    r = await runRound(i);
  } catch (err) {
    r = { ok: false, reason: `异常：${err.message}` };
  }
  const dt = Date.now() - t0;
  durations.push(dt);
  if (r.ok) {
    tasks += r.batch;
    if (r.batch > 1) batches += 1;
    if (r.paused) pauses += 1;
    maxActiveSeen = Math.max(maxActiveSeen, r.maxActive);
  } else {
    failures.push({ round: i, reason: r.reason });
    console.log(`  ❌ 第 ${i} 轮失败：${r.reason}`);
    // 清场后继续，避免一次失败连锁影响后续轮次
    const st = await getState().catch(() => ({ torrents: [] }));
    await removeAll(st.torrents.map((t) => t.infoHash)).catch(() => {});
  }
  if (i % 20 === 0) {
    await send('HeapProfiler.collectGarbage').catch(() => {});
    const m = { ...(await rendererMetrics()), rss: electronRssMB() };
    samples.push({ i, ...m });
    console.log(
      `  [${String(i).padStart(3)}/${ROUNDS}] 通过 ${i - failures.length} | 失败 ${failures.length} | ` +
        `本轮 ${dt}ms | 堆 ${m.heapMB.toFixed(1)}MB | 节点 ${m.nodes} | 监听器 ${m.listeners} | RSS ${m.rss.toFixed(0)}MB`
    );
  }
}

// ---------------------------------------------------------------- 报告
const sorted = [...durations].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const first = samples[0], last = samples[samples.length - 1];
const leftover = fs.readdirSync(DL_DIR);

console.log('\n━━━ 结果 ━━━');
console.log(`轮次：${ROUNDS - failures.length}/${ROUNDS} 通过（${(((ROUNDS - failures.length) / ROUNDS) * 100).toFixed(1)}%）`);
console.log(`任务：完成 ${tasks} 个（含 ${batches} 次 6 任务并发批次、${pauses} 次暂停/继续）`);
console.log(`并发：观测到最大同时下载 ${maxActiveSeen}（上限 ${MAX_ACTIVE}）`);
console.log(`耗时：总 ${((Date.now() - tStart) / 1000).toFixed(1)}s | 单轮 p50 ${pct(50)}ms p95 ${pct(95)}ms max ${sorted.at(-1)}ms`);
if (first && last) {
  console.log(
    `资源（第 ${first.i} 轮 → 第 ${last.i} 轮）：堆 ${first.heapMB.toFixed(1)}→${last.heapMB.toFixed(1)}MB | ` +
      `节点 ${first.nodes}→${last.nodes} | 监听器 ${first.listeners}→${last.listeners} | RSS ${first.rss.toFixed(0)}→${last.rss.toFixed(0)}MB`
  );
}
console.log(`下载目录残留文件：${leftover.length ? leftover.join(', ') : '无'}`);
console.log(`渲染进程报错：${consoleErrors.length ? consoleErrors.length + ' 条' : '无'}`);
for (const e of consoleErrors.slice(0, 5)) console.log('   ', String(e).slice(0, 200));
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures.slice(0, 20)) console.log(`   第 ${f.round} 轮：${f.reason}`);
}
await evaluate(`window.bt.setLimits(-1, -1)`).catch(() => {});
ws.close();
process.exit(failures.length || consoleErrors.length ? 1 : 0);
