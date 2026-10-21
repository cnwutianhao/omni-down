// 深度测试：WebTorrent 能否连上特定种子 + 手动注入可达 peer 的效果
import WebTorrent from 'webtorrent';

const CASES = [
  { hash: '98d3e6f53e07a2d318078c8f0a29ea5b9c382883', inject: ['210.209.108.46:9959'], label: '③ 连不上(有1个可达peer)' },
  { hash: '37c0de78b0502b3bf27a17681dc2fa11217d8ff9', inject: ['58.21.103.236:51413'], label: '① 慢速可下(有1个可达peer)' }
];

for (const c of CASES) {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`${c.label}  ${c.hash}`);
  console.log(`  注入 peer: ${c.inject.join(', ')}`);

  const client = new WebTorrent({ maxConns: 80 });
  const torrent = client.add(
    `magnet:?xt=urn:btih:${c.hash}`,
    {
      path: `/tmp/tf-deep-${c.hash.slice(0, 8)}`,
      announce: [
        'udp://tracker.opentrackr.org:1337/announce',
        'udp://open.demonii.com:1337/announce'
      ]
    }
  );

  let wires = 0;
  let metadataAt = null;
  const t0 = Date.now();

  torrent.on('warning', (w) => console.log(`  [warn ${((Date.now() - t0) / 1000).toFixed(1)}s] ${w.message}`));
  torrent.on('error', (e) => console.log(`  [error] ${e.message}`));
  torrent.on('wire', (wire) => {
    wires++;
    console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ✅ wire +1 (${wire.type}) 总 ${torrent.numPeers}`);
  });
  torrent.on('metadata', () => {
    metadataAt = Date.now() - t0;
    console.log(`  [${(metadataAt / 1000).toFixed(1)}s] 🎯 元数据到手: ${torrent.name} (${(torrent.length / 1024 / 1024).toFixed(1)} MB)`);
  });

  // ready 后注入可达 peer
  torrent.once('ready', () => {
    for (const p of c.inject) {
      try {
        torrent.addPeer(p);
        console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] 已注入 ${p}`);
      } catch (e) {
        console.log(`  注入失败 ${p}: ${e.message}`);
      }
    }
  });

  await new Promise((r) => setTimeout(r, 35000));

  console.log('');
  console.log(`  ── 结果 ──`);
  console.log(`  wire 建立: ${wires} 次`);
  console.log(`  当前 peers: ${torrent.numPeers}`);
  console.log(`  元数据: ${torrent.metadata ? `✅ ${(metadataAt / 1000).toFixed(1)}s 时拿到` : '❌ 无'}`);
  console.log(`  已下载: ${(torrent.downloaded / 1024).toFixed(0)} KB | 速度 ${(torrent.downloadSpeed / 1024).toFixed(1)} KB/s`);
  await new Promise((r) => client.destroy(r));
  console.log('');
}

process.exit(0);
