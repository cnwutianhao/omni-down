// 改进版：从 tracker 拿到 peer 列表 → 测试每个 peer 的 TCP 连通性 → 手动注入 WebTorrent
import WebTorrent from 'webtorrent';
import Client from 'bittorrent-tracker';
import { hex2arr } from 'uint8-util';
import net from 'node:net';

const HASH = process.argv[2] || '1499a4a94748d06c351254d4c7e9d68648310a3c';

async function getPeers() {
  return new Promise((resolve) => {
    const found = new Set();
    const peerIdBuf = Buffer.concat([Buffer.from('-TF1000-'), Buffer.from('123456789012')]);
    const client = new Client({
      infoHash: hex2arr(HASH),
      peerId: new Uint8Array(peerIdBuf),
      announce: ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.demonii.com:1337/announce'],
      port: 6881
    });
    client.on('peer', (peer) => {
      const str = typeof peer === 'string' ? peer : `${peer.host || peer.ip}:${peer.port}`;
      if (str && !str.includes('undefined')) found.add(str);
    });
    client.on('update', (d) => console.log(`  [update] seeders=${d.complete} leechers=${d.incomplete} (来自 ${d.announce})`));
    client.on('warning', (w) => console.log(`  [warn] ${w.message}`));
    client.start();
    setTimeout(() => { try { client.destroy(); } catch {} resolve([...found]); }, 8000);
  });
}

console.log('━━━ ① 从 tracker 收集 peer（8 秒窗口）━━━');
const peers = await getPeers();
console.log(`  共收集到 ${peers.length} 个 peer：`);
peers.forEach((p) => console.log(`     ${p}`));

if (peers.length === 0) {
  console.log('\n  ⚠️ tracker 没返回 peer。稍后重试或换时间测试。');
  process.exit(0);
}

console.log('');
console.log('━━━ ② 测试每个 peer 的 TCP 连通性 ━━━');
const reachable = [];
for (const p of peers) {
  const [host, port] = p.split(':');
  await new Promise((res) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port: Number(port) || 6881 });
    const done = (ok, note) => {
      console.log(`  ${ok ? '✅' : '❌'} ${p.padEnd(24)} ${Date.now() - t0}ms ${note || ''}`);
      if (ok) reachable.push(p);
      sock.destroy();
      res();
    };
    sock.setTimeout(6000);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false, 'TCP 超时'));
    sock.on('error', (e) => done(false, e.code || e.message));
  });
}

console.log('');
console.log(`  可连接 peer: ${reachable.length}/${peers.length}`);
if (reachable.length === 0) {
  console.log('  ⚠️ 所有 peer 的 TCP 端口都不可达（都在 NAT 后或已下线）');
}

console.log('');
console.log('━━━ ③ 把可达 peer 注入 WebTorrent 看能否建立 BT 连接 ━━━');
const client = new WebTorrent();
const torrent = client.add(`magnet:?xt=urn:btih:${HASH}`, { path: '/tmp/tf-diag4' });
torrent.on('warning', (w) => { if (!/timed out|No nodes/.test(w.message)) console.log(`  [warn] ${w.message}`); });
torrent.once('ready', () => {
  for (const p of reachable) {
    try { torrent.addPeer(p); console.log(`  已注入 peer: ${p}`); } catch (e) { console.log(`  注入失败 ${p}: ${e.message}`); }
  }
});
let wires = 0;
torrent.on('wire', (wire) => { wires++; console.log(`  [wire] ✅ peer +1（类型 ${wire.type}，总 ${torrent.numPeers}）`); });
torrent.on('metadata', () => console.log(`  [metadata] ✅✅ 拿到元数据：${torrent.name}！`));

setTimeout(async () => {
  console.log('');
  console.log('━━━ 结果 ━━━');
  console.log(`  wire 建立次数: ${wires}`);
  console.log(`  元数据: ${torrent.metadata ? '✅ 有' : '❌ 无'}`);
  await new Promise((r) => client.destroy(r));
  process.exit(0);
}, 40000);
