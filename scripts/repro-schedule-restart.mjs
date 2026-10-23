/**
 * 回归测试：HTTP 引擎调度与重启
 * - 批量添加任务时，同时下载数不得超过 MAX_ACTIVE（4）
 * - 排队任务在前面的任务完成后能全部跑完
 * - stop() 之后再 start()：定时器恢复、继续广播、任务从状态文件恢复且不重复
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpEngine } from '../src/main/http-engine.js';

const SIZE = 4 * 1024 * 1024;
const server = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
  const start = m ? Number(m[1]) : 0;
  const end = m ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
  res.writeHead(m ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    ...(m ? { 'Content-Range': `bytes ${start}-${end}/${SIZE}` } : {})
  });
  res.end(Buffer.alloc(end - start + 1, 0x41));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-schedule-'));
const stateFile = path.join(dir, 'state.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const e = new HttpEngine({ downloadDir: dir, stateFile });
await e.start();

console.log('━━━ ① 批量添加不突破并发上限 ━━━');
e.setSpeedLimit(2 * 1024 * 1024);
const ids = [];
for (let i = 0; i < 8; i++) ids.push(e.add(`${base}/f${i}.bin`));
let peak = 0;
for (let i = 0; i < 300; i++) {
  await sleep(50);
  const n = [...e.tasks.values()].filter((t) => t.status === 'downloading').length;
  peak = Math.max(peak, n);
  if (ids.every((id) => e.tasks.get(id)?.status === 'done')) break;
}
check('同时下载数 ≤ 4', peak > 0 && peak <= 4, `峰值 ${peak}`);
const doneCount = ids.filter((id) => e.tasks.get(id)?.status === 'done').length;
check('排队任务全部完成', doneCount === ids.length, `${doneCount}/${ids.length}`);
e.setSpeedLimit(-1);
for (const id of ids) await e.remove(id, true);

console.log('━━━ ② stop 后再 start ━━━');
e.setSpeedLimit(512 * 1024);
const keep = e.add(`${base}/keep.bin`);
await sleep(600);
e.pause(keep);
e.setSpeedLimit(-1);
await e.stop();
check('stop 后 started 复位', e.started === false);
await e.start();
check('restart 后定时器恢复', !!e.timer);
let updates = 0;
const onUpdate = () => updates++;
e.on('update', onUpdate);
await sleep(2000);
e.off('update', onUpdate);
check('restart 后持续广播', updates >= 2, `2 秒内 ${updates} 次`);
check('任务从状态文件恢复且不重复', e.tasks.size === 1 && e.tasks.get(keep)?.status === 'paused', `${e.tasks.size} 个，状态 ${e.tasks.get(keep)?.status}`);
e.resume(keep);
for (let i = 0; i < 100 && e.tasks.get(keep)?.status !== 'done'; i++) await sleep(100);
check('恢复的任务能续传完成', e.tasks.get(keep)?.status === 'done');
await e.remove(keep, true);

await e.stop();
server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('');
console.log(`${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
