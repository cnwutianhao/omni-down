// 通过 CDP 自动化测试 UI：添加磁力链接 → 观察进度 → 验证状态
import WebSocket from 'ws';

const CDP_URL = 'http://127.0.0.1:9222/json';
const MAGNET =
  'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce';

const targets = await (await fetch(CDP_URL)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('❌ 未找到页面');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

const evaluate = async (expression, awaitPromise = false) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (res.result?.exceptionDetails) {
    return { error: res.result.exceptionDetails.text };
  }
  return res.result?.result?.value;
};

await new Promise((r) => ws.on('open', r));

console.log('━━━ 步骤 1：检查初始 UI ━━━');
const ui = await evaluate(`JSON.stringify({
  dir: document.getElementById('dir-text').textContent,
  count: document.getElementById('c-all').textContent,
  api: typeof window.bt,
  rows: document.querySelectorAll('.row').length
})`);
console.log('  ', ui);

console.log('━━━ 步骤 2：通过输入框添加磁力链接（模拟真实用户操作）━━━');
await evaluate(`document.getElementById('magnet-input').value = ${JSON.stringify(MAGNET)}`);
await evaluate(`document.querySelectorAll('.filter').length`); // 确保脚本已绑定
await evaluate(`document.getElementById('add-btn').click()`);
await new Promise((r) => setTimeout(r, 2500));

const afterAdd = await evaluate(`JSON.stringify({
  rows: document.querySelectorAll('.row').length,
  count: document.getElementById('c-all').textContent,
  inputCleared: document.getElementById('magnet-input').value === '',
  firstRowName: document.querySelector('.row-name')?.textContent || '(无)',
  toast: document.querySelector('.toast')?.textContent || '(无)'
})`);
console.log('  ', afterAdd);

console.log('━━━ 步骤 3：等待元数据解析与 peer 连接（最多 40 秒）━━━');
let finalState = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const state = JSON.parse(
    await evaluate(`JSON.stringify({
      name: document.querySelector('.row-name')?.textContent || '',
      badge: document.querySelector('.row-badge')?.textContent || '',
      meta: document.querySelector('.row-meta')?.textContent?.trim() || '',
      ring: document.querySelector('.ring-txt')?.textContent || ''
    })`)
  );
  process.stdout.write(
    `   [${(i + 1) * 2}s] 名称=${state.name.slice(0, 28)} | 状态=${state.badge} | ${state.meta.slice(0, 40)} | ${state.ring}\n`
  );
  if (state.name && !state.name.includes('获取元数据')) {
    finalState = state;
    if (i >= 2) break; // 拿到元数据后再观察几秒速度
  }
}

console.log('━━━ 步骤 4：测试暂停 / 继续 ━━━');
await evaluate(`document.querySelector('.act-toggle')?.click()`);
await new Promise((r) => setTimeout(r, 1200));
const pausedState = await evaluate(`document.querySelector('.row-badge')?.textContent`);
console.log('   点击暂停后状态:', pausedState);

await evaluate(`document.querySelector('.act-toggle')?.click()`);
await new Promise((r) => setTimeout(r, 1200));
const resumedState = await evaluate(`document.querySelector('.row-badge')?.textContent`);
console.log('   点击继续后状态:', resumedState);

console.log('━━━ 步骤 5：测试筛选器 ━━━');
await evaluate(`document.querySelector('[data-filter="active"]').click()`);
await new Promise((r) => setTimeout(r, 600));
const activeRows = await evaluate(`document.querySelectorAll('.row').length`);
await evaluate(`document.querySelector('[data-filter="done"]').click()`);
await new Promise((r) => setTimeout(r, 600));
const doneRows = await evaluate(`document.querySelectorAll('.row').length`);
await evaluate(`document.querySelector('[data-filter="all"]').click()`);
await new Promise((r) => setTimeout(r, 600));
const allRows = await evaluate(`document.querySelectorAll('.row').length`);
console.log(`   下载中筛选: ${activeRows} 行 | 已完成筛选: ${doneRows} 行 | 全部: ${allRows} 行`);

console.log('━━━ 步骤 6：测试移除任务 ━━━');
await evaluate(`
  (async () => {
    const hash = document.querySelector('.row')?.dataset.hash;
    if (hash) await window.bt.remove(hash, false);
  })()
`, true);
await new Promise((r) => setTimeout(r, 1500));
const afterRemove = await evaluate(`JSON.stringify({
  rows: document.querySelectorAll('.row').length,
  count: document.getElementById('c-all').textContent
})`);
console.log('  ', afterRemove);

console.log('');
console.log('✅ 测试完成');
ws.close();
process.exit(0);
