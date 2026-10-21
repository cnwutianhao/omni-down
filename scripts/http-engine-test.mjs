// HTTP 引擎完整测试：多线程分块 / 断点续传 / 暂停恢复 / 限速 / 重名 / 错误处理
import { HttpEngine } from '../src/main/http-engine.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DIR = '/tmp/tf-http-test';
const STATE = path.join(DIR, 'state.json');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

// 启动本地测试服务器（32MB）
const server = spawn('node', [new URL('./test-server.mjs', import.meta.url).pathname, '32', '18081'], { stdio: 'pipe' });
await new Promise((r) => setTimeout(r, 800));
const URL1 = 'http://127.0.0.1:18081/file.bin';
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const e = new HttpEngine({ downloadDir: DIR, stateFile: STATE });
await e.start();
console.log('━━━ ① 基本下载（多线程分块）━━━');
const id1 = e.add(URL1);
let task = null;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 500));
  task = e.tasks.get(id1);
  if (task?.status === 'done') break;
}
check('下载完成', task?.status === 'done', `${task?.status} ${((task?.received || 0) / 1024 / 1024).toFixed(1)}MB`);
check('文件名识别（Content-Disposition）', task?.filename === 'testfile-32mb.bin', task?.filename);
check('Range 分块生效', (task?.chunks?.length || 0) > 1, `${task?.chunks?.length} 块`);
const finalPath = path.join(DIR, 'testfile-32mb.bin');
check('最终文件存在且大小正确', fs.existsSync(finalPath) && fs.statSync(finalPath).size === 32 * 1024 * 1024);
check('.part 临时文件已清理', !fs.existsSync(finalPath + '.part'));

console.log('━━━ ② 暂停 / 恢复（断点续传）━━━');
fs.rmSync(finalPath, { force: true });
e.setSpeedLimit(2 * 1024 * 1024); // 限 2MB/s，确保暂停时任务未完成
const id2 = e.add(URL1);
await new Promise((r) => setTimeout(r, 2500));
e.pause(id2);
const pausedTask = e.tasks.get(id2);
const receivedAtPause = pausedTask.received;
check('暂停生效', pausedTask.status === 'paused', `已下 ${(receivedAtPause / 1024 / 1024).toFixed(1)}MB`);
check('确实下了一部分（非瞬间完成）', receivedAtPause > 0 && receivedAtPause < 32 * 1024 * 1024);
check('.part 文件保留', fs.existsSync(path.join(DIR, pausedTask.filename + '.part')));
e.resume(id2);
let task2 = null;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 500));
  task2 = e.tasks.get(id2);
  if (task2?.status === 'done') break;
}
check('恢复后完成', task2?.status === 'done');
check('最终文件大小正确', fs.existsSync(path.join(DIR, task2.filename)) && fs.statSync(path.join(DIR, task2.filename)).size === 32 * 1024 * 1024);
e.setSpeedLimit(-1);

console.log('━━━ ③ 限速 ━━');
fs.rmSync(path.join(DIR, task2.filename), { force: true });
e.setSpeedLimit(1024 * 1024); // 1 MB/s
const id3 = e.add(URL1);
await new Promise((r) => setTimeout(r, 3000));
e.pause(id3);
const t3 = e.tasks.get(id3);
const elapsed = 3;
const mbps = t3.received / 1024 / 1024 / elapsed;
check('限速约 1MB/s（允许 2.5x 容差）', mbps < 2.5, `实测 ${mbps.toFixed(2)} MB/s`);
e.setSpeedLimit(-1);
await e.remove(id3, true);

console.log('━━━ ④ 重名处理 ━━');
// 模拟真实流程：每次下载前调用 uniquePath，完成后文件落盘
const existing = task2.filename;
fs.writeFileSync(path.join(DIR, existing), 'x'); // 第一个文件已存在
const name1 = e._uniquePath(DIR, existing);
fs.writeFileSync(path.join(DIR, name1), 'x'); // 第二个落盘
const name2 = e._uniquePath(DIR, existing);
const ext = path.extname(existing);
const base = existing.slice(0, existing.length - ext.length);
check('重名自动加序号', name1 === `${base} (1)${ext}` && name2 === `${base} (2)${ext}`, `${name1} / ${name2}`);
fs.rmSync(path.join(DIR, name1), { force: true });
fs.rmSync(path.join(DIR, name2), { force: true });

console.log('━━━ ⑤ 错误处理（无效 URL）━━━');
const id5 = e.add('http://127.0.0.1:19999/nonexistent');
let task5 = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500));
  task5 = e.tasks.get(id5);
  if (task5?.status === 'error') break;
}
check('错误状态正确', task5?.status === 'error', task5?.error);
await e.remove(id5, true);

console.log('━━━ ⑥ 状态持久化 ━━');
await e.stop();
const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
check('状态已落盘', Array.isArray(saved) && saved.length > 0, `${saved.length} 条`);
check('分块进度已保存', saved.some((s) => Array.isArray(s.chunks)));

// 重启恢复
const e2 = new HttpEngine({ downloadDir: DIR, stateFile: STATE });
await e2.start();
check('重启后任务恢复', e2.tasks.size === saved.length, `${e2.tasks.size} 个`);
// 注意：② 的任务文件在 ③ 被删，引擎正确地将其重置为 paused（文件丢失保护）
const doneTask = [...e2.tasks.values()].find((t) => t.status === 'done');
const resetTask = [...e2.tasks.values()].find((t) => t.status === 'paused' && t.completedAt > 0);
check('完成任务保留或正确重置（文件丢失保护）', !!doneTask || !!resetTask, doneTask ? 'done 保留' : resetTask ? '已重置为 paused（文件被删）' : '无');
await e2.stop();

server.kill();
console.log('');
console.log(`${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
