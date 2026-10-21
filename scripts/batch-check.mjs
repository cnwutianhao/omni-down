// 批量体检多个磁力链接：做种人数 + peer 连通性
// 用法: node scripts/batch-check.mjs
import Client from 'bittorrent-tracker';
import { hex2arr } from 'uint8-util';
import net from 'node:net';

const HASHES = [
  ['37c0de78b0502b3bf27a17681dc2fa11217d8ff9', '① 慢速可下'],
  ['df00cff3fffcb84d5d521ad7d21e369cd7e4fc8c', '② 慢速可下'],
  ['98d3e6f53e07a2d318078c8f0a29ea5b9c382883', '③ 连不上'],
  ['39557e78e92806f7b3300eeb4c0dbca18cc0652e', '④ 连不上'],
  ['1499a4a94748d06c351254d4c7e9d68648310a3c', '⑤ 连不上']
];

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce'
];

/** 查询 tracker：返回 seeders/leechers/peers */
function queryTrackers(hash) {
  return new Promise((resolve) => {
    const peers = new Set();
    const stats = [];
    const peerIdBuf = Buffer.concat([Buffer.from('-TF1000-'), Buffer.from('234567890123')]);
    const client = new Client({
      infoHash: hex2arr(hash),
      peerId: new Uint8Array(peerIdBuf),
      announce: TRACKERS,
      port: 6881
    });
    client.on('peer', (peer) => {
      const str = typeof peer === 'string' ? peer : `${peer.host || peer.ip}:${peer.port}`;
      if (str && !str.includes('undefined')) peers.add(str);
    });
    client.on('update', (d) => {
      const name = TRACKERS.find((t) => d.announce?.startsWith(t.split('/')[2])) || d.announce;
      stats.push({ tracker: name, seeders: d.complete, leechers: d.incomplete });
    });
    client.on('warning', () => {});
    client.start();
    setTimeout(() => {
      try { client.destroy(); } catch {}
      resolve({ peers: [...peers], stats });
    }, 9000);
  });
}

/** 并发测 TCP 连通性 */
async function testPeers(peers, timeoutMs = 4000) {
  const results = await Promise.all(
    peers.map(
      (p) =>
        new Promise((res) => {
          const [host, port] = p.split(':');
          const t0 = Date.now();
          const sock = net.connect({ host, port: Number(port) || 6881 });
          const done = (ok, note) => {
            sock.destroy();
            res({ p, ok, ms: Date.now() - t0, note });
          };
          sock.setTimeout(timeoutMs);
          sock.on('connect', () => done(true));
          sock.on('timeout', () => done(false, '超时'));
          sock.on('error', (e) => done(false, e.code || e.message));
        })
    )
  );
  return results;
}

console.log('批量体检 5 个磁力链接（每项约 15 秒）\n');

for (const [hash, label] of HASHES) {
  console.log(`${'━'.repeat(58)}`);
  console.log(`${label}  ${hash}`);
  const { peers, stats } = await queryTrackers(hash);

  if (stats.length === 0) {
    console.log('  tracker: ❌ 无任何响应');
  } else {
    for (const s of stats) {
      console.log(`  tracker: 做种 ${s.seeders ?? '?'} | 下载中 ${s.leechers ?? '?'}  (${s.tracker})`);
    }
  }

  console.log(`  tracker 返回 peer: ${peers.length} 个`);

  if (peers.length > 0) {
    const t0 = Date.now();
    const results = await testPeers(peers.slice(0, 40));
    const ok = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok && /ECONNREFUSED/.test(r.note || '')).length;
    const timeout = results.filter((r) => !r.ok && r.note === '超时').length;
    console.log(
      `  TCP 连通测试: ✅ 可达 ${ok.length} | ❌ 拒绝 ${refused} | ❌ 超时 ${timeout}  (耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s)`
    );
    if (ok.length > 0) {
      ok.slice(0, 5).forEach((r) => console.log(`      ✅ ${r.p}  ${r.ms}ms`));
    }
  }
  console.log('');
}

console.log('体检完成。');
process.exit(0);
