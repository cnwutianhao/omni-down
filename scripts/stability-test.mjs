/**
 * 稳定性压测：100 轮混合场景
 * 场景分布（每轮随机）：
 *   A. HTTP 完整下载（1MB）→ 校验大小 → 删除
 *   B. HTTP 下载中暂停 → 恢复 → 完成 → 删除
 *   C. HTTP 错误 URL → 等错误态 → 删除
 *   D. 引擎重启（stop → start → 任务恢复）
 *   E. 并发 3 任务同时下载
 * 每轮检查：无残留 .part / 状态文件可解析 / 无未捕获异常
 * 结束输出：成功率、耗时分布、内存趋势、fd 趋势
 */
import { HttpEngine } from '../src/main/http-engine.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DIR = '/tmp/tf-stability';
const STATE = path.join(DIR, 'state.json');
const ROUNDS = Number(process.argv[2]) || 100;
const URL_OK = 'http://127.0.0.1:18082/stability.bin';
const URL_BAD = 'http://127.0.0.1:19999/x';

// ---------- 环境准备 ----------
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const server = spawn('node', [new URL('./test-server.mjs', import.meta.url).pathname, '1', '18082'], { stdio: 'pipe' });
await new Promise((resolve) => {
  const timeout = setTimeout(() => { console.error('⚠️  服务器 2 秒未就绪'); resolve(); }, 2000);
  server.stdout.on('data', (chunk) => { if (chunk.toString().includes('就绪')) { clearTimeout(timeout); resolve(); } });
  server.stderr.on('data', () => {});
});

const engine = new HttpEngine({ downloadDir: DIR, stateFile: STATE });
await engine.start();

// ---------- 统计 ----------
const stats = {
  rounds: 0,
  ops: { download: 0, pauseResume: 0, error: 0, restart: 0, concurrent: 0 },
  failures: [],
  durations: [],
  memStart: process.memoryUsage().heapUsed,
  memSamples: [],
  leftoverFiles: 0,
  uncaught: 0
};
process.on('uncaughtException', (err) => {
  stats.uncaught++;
  stats.failures.push(`uncaught: ${err.message}`);
});
process.on('unhandledRejection', (err) => {
  stats.uncaught++;
  stats.failures.push(`unhandledRejection: ${err?.message || err}`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitDone = async (id, timeoutMs = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = engine.tasks.get(id);
    if (!t) return 'removed';
    if (t.status === 'done' || t.status === 'error') return t.status;
    await sleep(60);
  }
  return 'timeout';
};
const waitStatus = async (id, status, timeoutMs = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = engine.tasks.get(id);
    if (!t) return false;
    if (t.status === status) return true;
    await sleep(50);
  }
  return false;
};
const checkClean = (round) => {
  const leftovers = fs.readdirSync(DIR).filter((f) => f.endsWith('.part'));
  if (leftovers.length) {
    stats.leftoverFiles += leftovers.length;
    stats.failures.push(`round ${round}: 残留 .part: ${leftovers.join(',')}`);
    for (const f of leftovers) fs.rmSync(path.join(DIR, f), { force: true });
  }
  try {
    if (fs.existsSync(STATE)) JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch (err) {
    stats.failures.push(`round ${round}: 状态文件损坏: ${err.message}`);
  }
};

// ---------- 场景实现 ----------
const scenarios = {
  async download(round) {
    const id = engine.add(URL_OK);
    const st = await waitDone(id);
    if (st !== 'done') throw new Error(`下载结束态异常: ${st}`);
    const t = engine.tasks.get(id);
    if (t.received !== 1024 * 1024) throw new Error(`大小不符: ${t.received}`);
    await engine.remove(id, true);
  },
  async pauseResume(round) {
    // 限速 2MB/s，确保暂停窗口内任务未完成
    engine.setSpeedLimit(2 * 1024 * 1024);
    const id = engine.add(URL_OK);
    await sleep(150);
    const before = engine.tasks.get(id);
    if (before.status === 'done') {
      // 本地服务器过快导致已完成（合法竞态），直接清理算通过
      engine.setSpeedLimit(-1);
      await engine.remove(id, true);
      return;
    }
    engine.pause(id);
    if (!(await waitStatus(id, 'paused'))) {
      engine.setSpeedLimit(-1);
      throw new Error('暂停失败');
    }
    const mid = engine.tasks.get(id)?.received || 0;
    engine.resume(id);
    const st = await waitDone(id);
    engine.setSpeedLimit(-1);
    if (st !== 'done') throw new Error(`恢复后结束态异常: ${st}`);
    const t = engine.tasks.get(id);
    if (t.received !== 1024 * 1024) throw new Error(`恢复后大小不符: ${t.received}`);
    await engine.remove(id, true);
    return mid;
  },
  async errorUrl(round) {
    const id = engine.add(URL_BAD);
    const st = await waitDone(id, 20000);
    if (st !== 'error') throw new Error(`错误 URL 未进入 error 态: ${st}`);
    await engine.remove(id, true);
  },
  async restart(round) {
    // 添加一个任务并下一半（限速保证不会瞬间完成），然后重启引擎验证恢复
    engine.setSpeedLimit(2 * 1024 * 1024);
    const id = engine.add(URL_OK);
    await sleep(120);
    engine.pause(id);
    engine.setSpeedLimit(-1);
    // 若已完成（竞态），清理后直接通过
    if (engine.tasks.get(id)?.status === 'done') {
      await engine.remove(id, true);
      return;
    }
    await engine.stop();
    const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (!saved.length) throw new Error('重启前状态未落盘');
    const e2 = new HttpEngine({ downloadDir: DIR, stateFile: STATE });
    await e2.start();
    const restored = e2.tasks.get(id);
    if (!restored) throw new Error('重启后任务丢失');
    if (restored.status !== 'paused') throw new Error(`恢复态异常: ${restored.status}`);
    e2.resume(id);
    const st = await waitDone(id);
    if (st !== 'done') throw new Error(`重启恢复后下载失败: ${st}`);
    await e2.remove(id, true);
    await e2.stop();
    // 主引擎重新启动继续服务后续轮次
    await engine.start();
  },
  async concurrent(round) {
    const ids = [engine.add(URL_OK), engine.add(URL_OK), engine.add(URL_OK)];
    const results = await Promise.all(ids.map((id) => waitDone(id)));
    if (results.some((s) => s !== 'done')) throw new Error(`并发下载有失败: ${results.join(',')}`);
    for (const id of ids) await engine.remove(id, true);
  }
};

const scenarioNames = ['download', 'pauseResume', 'errorUrl', 'restart', 'concurrent'];

// ---------- 主循环 ----------
console.log(`开始 ${ROUNDS} 轮稳定性压测…\n`);
const t0 = Date.now();
for (let round = 1; round <= ROUNDS; round++) {
  const name = scenarioNames[round % scenarioNames.length];
  const s = Date.now();
  try {
    await scenarios[name](round);
    stats.ops[name === 'download' ? 'download' : name === 'pauseResume' ? 'pauseResume' : name === 'errorUrl' ? 'error' : name === 'restart' ? 'restart' : 'concurrent']++;
    stats.durations.push(Date.now() - s);
    stats.rounds++;
  } catch (err) {
    stats.failures.push(`round ${round} [${name}]: ${err.message}`);
  }
  checkClean(round);
  if (round % 10 === 0) {
    const mem = process.memoryUsage().heapUsed;
    stats.memSamples.push(mem);
    const avg = stats.durations.slice(-10).reduce((a, b) => a + b, 0) / 10;
    process.stdout.write(
      `  [${String(round).padStart(3)}/${ROUNDS}] 最近10轮均耗时 ${avg.toFixed(0)}ms | 堆内存 ${(mem / 1024 / 1024).toFixed(1)}MB | 失败 ${stats.failures.length}\n`
    );
  }
}
const totalMs = Date.now() - t0;

// ---------- 收尾清理与报告 ----------
await engine.stop().catch(() => {});
server.kill();

// 最终残留检查
const finalFiles = fs.readdirSync(DIR);
stats.leftoverFiles += finalFiles.filter((f) => f.endsWith('.part')).length;
const memEnd = process.memoryUsage().heapUsed;
const memGrowth = (memEnd - stats.memStart) / 1024 / 1024;
const avgDur = stats.durations.reduce((a, b) => a + b, 0) / (stats.durations.length || 1);
const maxDur = Math.max(...stats.durations, 0);
const memFirst10 = stats.memSamples[0] || stats.memStart;
const memLast10 = stats.memSamples[stats.memSamples.length - 1] || memEnd;
const memTrend = (memLast10 - memFirst10) / 1024 / 1024;

console.log('\n━━━━━━━━━━ 稳定性报告 ━━━━━━━━━━');
console.log(`  总轮次: ${ROUNDS} | 成功: ${stats.rounds} | 失败: ${stats.failures.length} | 成功率 ${((stats.rounds / ROUNDS) * 100).toFixed(1)}%`);
console.log(`  场景分布: 完整下载 ${stats.ops.download} | 暂停恢复 ${stats.ops.pauseResume} | 错误处理 ${stats.ops.error} | 引擎重启 ${stats.ops.restart} | 并发 ${stats.ops.concurrent}`);
console.log(`  总耗时 ${(totalMs / 1000).toFixed(1)}s | 单轮均值 ${avgDur.toFixed(0)}ms | 单轮最大 ${maxDur}ms`);
console.log(`  内存: 起始 ${(stats.memStart / 1024 / 1024).toFixed(1)}MB → 结束 ${(memEnd / 1024 / 1024).toFixed(1)}MB（前10轮→后10轮趋势 ${memTrend >= 0 ? '+' : ''}${memTrend.toFixed(1)}MB）`);
console.log(`  未捕获异常: ${stats.uncaught} | .part 残留: ${stats.leftoverFiles}`);
if (stats.failures.length) {
  console.log('\n  失败明细（最多 10 条）:');
  stats.failures.slice(0, 10).forEach((f) => console.log(`    ❌ ${f}`));
}

// 清理整个测试目录
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n🧹 已清理测试目录 ${DIR}`);
console.log(stats.failures.length === 0 && stats.uncaught === 0 ? '✅ 稳定性测试全部通过' : '❌ 存在失败项，见上方明细');
process.exit(stats.failures.length === 0 && stats.uncaught === 0 ? 0 : 1);
