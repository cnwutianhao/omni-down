// UI 回归测试：验证新按钮、弹窗、限速、文件选择在界面层正常工作
import WebSocket from 'ws';

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('❌ 未找到页面'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.on('message', (raw) => { const msg = JSON.parse(raw); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
await new Promise((r) => ws.on('open', r));

const evalx = async (expr, ap = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: ap, returnByValue: true });
  if (r.result?.exceptionDetails) return '❌ ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 200);
  return r.result?.result?.value;
};

console.log('━━━ ① 新 UI 元素存在性 ━━━');
console.log('  ', await evalx(`JSON.stringify({
  speedBtn: !!document.getElementById('speed-btn'),
  speedModal: !!document.getElementById('speed-modal'),
  filesModal: !!document.getElementById('files-modal'),
  playBtnInTpl: !!document.querySelector('#row-template .act-play'),
  filesBtnInTpl: !!document.querySelector('#row-template .act-files')
})`));

console.log('━━━ ② 限速弹窗交互 ━━━');
await evalx(`document.getElementById('speed-btn').click()`);
await new Promise((r) => setTimeout(r, 400));
console.log('  打开弹窗:', await evalx(`!document.getElementById('speed-modal').hidden`));
await evalx(`document.getElementById('limit-down').value = '512'`);
await evalx(`document.getElementById('speed-save').click()`);
await new Promise((r) => setTimeout(r, 600));
console.log('  保存后标签:', await evalx(`document.getElementById('speed-label').textContent`));
console.log('  按钮高亮:', await evalx(`document.getElementById('speed-btn').classList.contains('limited')`));
console.log('  引擎侧限速:', await evalx(`window.bt.getState().then(s => JSON.stringify(s.stats.limits))`, true));

// 恢复不限速
await evalx(`document.getElementById('speed-btn').click()`);
await new Promise((r) => setTimeout(r, 300));
await evalx(`document.getElementById('limit-down').value = ''`);
await evalx(`document.getElementById('speed-save').click()`);
await new Promise((r) => setTimeout(r, 500));
console.log('  恢复不限速后标签:', await evalx(`document.getElementById('speed-label').textContent`));

console.log('━━━ ③ 添加种子 → 播放/文件按钮出现 ━━━');
await evalx(`document.getElementById('magnet-input').value = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel'`);
await evalx(`document.getElementById('add-btn').click()`);
let ready = false;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const st = JSON.parse(await evalx(`JSON.stringify({
    rows: document.querySelectorAll('.row').length,
    playVisible: [...document.querySelectorAll('.act-play')].some(b => b.style.display !== 'none'),
    filesVisible: [...document.querySelectorAll('.act-files')].some(b => b.style.display !== 'none')
  })`));
  if (i % 5 === 0) console.log(`  [${(i + 1) * 2}s]`, JSON.stringify(st));
  if (st.playVisible) { ready = true; break; }
}
console.log('  播放按钮出现:', ready ? '✅' : '❌');

console.log('━━━ ④ 文件选择弹窗 ━━━');
await evalx(`document.querySelector('.act-files').click()`);
await new Promise((r) => setTimeout(r, 400));
console.log('  弹窗打开:', await evalx(`!document.getElementById('files-modal').hidden`));
console.log('  文件条目数:', await evalx(`document.querySelectorAll('.file-item').length`));
// 取消勾选第一个文件并保存
await evalx(`
  (function(){
    const cb = document.querySelector('.file-item input');
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    document.getElementById('files-save').click();
  })()
`);
await new Promise((r) => setTimeout(r, 800));
console.log('  保存后引擎侧勾选状态:', await evalx(`window.bt.getState().then(s => JSON.stringify(s.torrents[0]?.fileDetails?.slice(0,3).map(f=>f.selected)))`, true));

console.log('━━━ ⑤ 清理 ━━━');
const hash = await evalx(`window.bt.getState().then(s => s.torrents[0]?.infoHash)`, true);
if (hash) await evalx(`window.bt.remove('${hash}', true)`, true);
await new Promise((r) => setTimeout(r, 800));
console.log('  已清理测试任务');

console.log('');
console.log('✅ UI 回归测试完成');
ws.close();
process.exit(0);
