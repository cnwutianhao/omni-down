// 验证修复后的引擎：DHT 引导 + 种子下载
import { TorrentEngine } from '../src/main/torrent-engine.js';

const e = new TorrentEngine({
  downloadDir: '/tmp/tf-verify',
  stateFile: '/tmp/tf-verify/state.json'
});

await e.start();
console.log('引擎启动 ✅');

await new Promise((r) => setTimeout(r, 6000));
console.log('DHT 路由表:', e.client.dht?.nodes?.toArray()?.length ?? '未启用', '节点');

e.add('magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel');
console.log('已添加测试种子（Sintel）');

// 同时添加用户遇到问题的那个种子，观察其真实表现
e.add('magnet:?xt=urn:btih:1499a4a94748d06c351254d4c7e9d68648310a3c');
console.log('已添加出问题的种子（1499a4a9…）');

for (let i = 1; i <= 5; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  const list = e.serializeAll();
  for (const t of list) {
    console.log(
      `  [${i * 4}s] ${t.name || '(解析元数据中)'} | 进度 ${(t.progress * 100).toFixed(1)}% | ` +
      `${(t.downloadSpeed / 1024).toFixed(0)} KB/s | peers ${t.numPeers}`
    );
  }
}

await e.stop();
console.log('引擎已停止 ✅');
process.exit(0);
