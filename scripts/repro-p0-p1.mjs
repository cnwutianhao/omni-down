/**
 * P0/P1 bug 复现脚本（修复前跑一遍，修复后再跑一遍）
 * 覆盖：P0-1 _saveStateSoon 缺失 / P0-2 小限速死锁 / P1-2 图表时间窗 / P1-5 deselected 不恢复
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { TorrentEngine } from '../src/main/torrent-engine.js';
import { HttpEngine } from '../src/main/http-engine.js';
import { SpeedHistory } from '../src/main/speed-history.js';

const TMP = path.join(os.tmpdir(), 'omni-bug-repro');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ───────────────────────────── P0-1：TorrentEngine 缺 _saveStateSoon
async function reproSaveStateSoon() {
  const stateFile = path.join(TMP, 'torrents.json');
  await fsp.mkdir(TMP, { recursive: true });

  const engine = new TorrentEngine({ downloadDir: TMP, stateFile });
  engine.records.set('b'.repeat(40), { uri: 'magnet:?xt=urn:btih:' + 'b'.repeat(40), path: TMP, paused: true, addedAt: Date.now() });
  engine.records.set('c'.repeat(40), { uri: 'magnet:?xt=urn:btih:' + 'c'.repeat(40), path: TMP, paused: true, addedAt: Date.now() });

  // 关键：_dirty 只有「保存进行中又有新写入」才会置位；但成功路径末尾会把
  // _dirty 重置为 false，所以只有「写入失败 + 期间有并发保存」才会让 finally
  // 里的 if (this._dirty) 成立 → 调到不存在的 _saveStateSoon()。
  // 这里用一个慢速且会失败的 writeFile 精确复现该路径。
  const origWrite = fsp.writeFile;
  let err = null;
  try {
    fsp.writeFile = async (...args) => {
      await new Promise((r) => setTimeout(r, 150)); // 拉长保存窗口
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    const p1 = engine._saveState();
    await new Promise((r) => setTimeout(r, 50)); // 确保 p1 进入写入阶段
    const p2 = engine._saveState(); // _saving=true → _dirty=true
    await Promise.all([p1, p2]);
    // finally: _saving=false; _dirty 仍为 true → this._saveStateSoon() → TypeError
    await new Promise((r) => setTimeout(r, 300));
  } catch (e) {
    err = e;
  } finally {
    fsp.writeFile = origWrite;
  }
  check(
    'P0-1 TorrentEngine 并发保存不抛异常',
    !err,
    err ? `${err.constructor.name}: ${err.message}` : '无异常'
  );
}

// ───────────────────────────── P0-2：限速 < 单块大小时死锁
async function reproThrottleDeadlock() {
  // 本地慢速服务器，1MB 文件
  const SIZE = 1024 * 1024;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', 'attachment; filename="slow.bin"');
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), SIZE - 1);
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${SIZE}`);
      res.setHeader('Content-Length', String(end - start + 1));
      res.end(Buffer.alloc(end - start + 1, 0x41));
    } else {
      res.setHeader('Content-Length', String(SIZE));
      res.end(Buffer.alloc(SIZE, 0x41));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const dir = path.join(TMP, 'dl-slow');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const eng = new HttpEngine({ downloadDir: dir, stateFile: path.join(dir, 'state.json') });
  await eng.start();
  // 10 KB/s —— 远小于单块（默认读取块常为 64KB）
  eng.setSpeedLimit(10 * 1024);
  eng.add(`http://127.0.0.1:${port}/slow.bin`);

  const t0 = Date.now();
  let task = null;
  // 给 12 秒；正常限速下每秒能挪 10KB，12 秒至少 100KB
  while (Date.now() - t0 < 12_000) {
    await new Promise((r) => setTimeout(r, 500));
    task = [...eng.tasks.values()][0];
    if (task?.status === 'done') break;
  }
  const got = task?.received || 0;
  check(
    'P0-2 限速 10KB/s 时仍有进展（无死锁）',
    got > 0,
    `12 秒内下载 ${got} 字节（状态 ${task?.status}）`
  );
  await eng.stop();
  server.close();
}
// ───────────────────────────── P1-2：高档时间窗收不到数据
function reproSpeedHistory() {
  const sh = new SpeedHistory();
  let now = 1_000_000;
  // 模拟 1 小时，每秒喂一次
  for (let i = 0; i < 3600; i++) {
    sh.push(100_000, 20_000, now);
    now += 1000;
  }
  const w5 = sh.series('5m').length;
  const w30 = sh.series('30m').length;
  const w6h = sh.series('6h').length;
  check(
    'P1-2 30m/6h 窗口有数据',
    w30 > 0 && w6h > 0,
    `5m=${w5} 点, 30m=${w30} 点, 6h=${w6h} 点`
  );
}

// ───────────────────────────── P1-5：deselected 不恢复
async function reproDeselectedRestore() {
  const dir = path.join(TMP, 'deselect');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  await fsp.writeFile(
    stateFile,
    JSON.stringify([
      {
        infoHash: 'a'.repeat(40),
        uri: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
        path: dir,
        paused: true,
        addedAt: Date.now(),
        deselected: [2, 5]
      }
    ])
  );

  const eng = new TorrentEngine({ downloadDir: dir, stateFile });
  const calls = [];
  // 桩掉 client.add，只观察 _add 传给 records 的内容
  eng.client = {
    torrents: [],
    add: () => {
      const fake = {
        infoHash: 'a'.repeat(40),
        ready: false,
        files: [],
        once: (ev, fn) => {
          if (ev === '_infoHash') queueMicrotask(fn);
        },
        on: () => {}
      };
      return fake;
    }
  };
  let saved = null;
  const origSave = eng._saveState.bind(eng);
  eng._saveState = async () => {
    saved = [...eng.records.values()].map((r) => ({ deselected: r.deselected || [] }));
    return origSave();
  };
  await eng.start();
  await new Promise((r) => setTimeout(r, 100));
  const rec = eng.records.get('a'.repeat(40));
  check(
    'P1-5 重启后 deselected 被恢复',
    Array.isArray(rec?.deselected) && rec.deselected.length === 2,
    `恢复后 deselected = ${JSON.stringify(rec?.deselected)}`
  );
  void calls;
  void saved;
}

// ───────────────────────────── 主流程
console.log('━━━━━━━━━ 修复前/后复现 ━━━━━━━━━');
await reproSaveStateSoon();
reproSpeedHistory();
await reproDeselectedRestore();
await reproThrottleDeadlock();

const failed = results.filter((r) => !r.pass);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
}

// 强制退出：被复现的引擎可能残留定时器/套接字，否则脚本会挂住
process.exit(failed.length ? 1 : 0);
