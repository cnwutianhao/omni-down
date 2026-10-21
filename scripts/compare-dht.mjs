// 对照测试：默认 DHT vs 自定义 DHT 引导，哪个能找到 peer
import WebTorrent from 'webtorrent';

const MAGNET =
  'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce';

const DHT_BOOTSTRAP = [
  { host: '87.98.162.88', port: 6881 },
  { host: '212.129.33.59', port: 6881 },
  { host: '82.221.103.244', port: 6881 },
  { host: '185.157.221.247', port: 6881 },
  { host: '67.215.246.10', port: 6881 },
  { host: 'dht.aelitis.com', port: 6881 },
  { host: 'router.bitcomet.com', port: 6881 }
];

async function testWith(label, opts) {
  console.log(`━━━ ${label} ━━━`);
  const client = new WebTorrent(opts);
  const torrent = client.add(MAGNET, { path: `/tmp/tf-cmp-${label.slice(0, 3)}` });
  const t0 = Date.now();
  const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

  torrent.on('wire', () => console.log(`  ${ts()} wire +1（总 ${torrent.numPeers}）`));
  torrent.on('metadata', () => console.log(`  ${ts()} ✅ 元数据: ${torrent.name}`));

  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    console.log(`  ${ts()} DHT路由表=${client.dht?.nodes?.toArray()?.length ?? '?'} peers=${torrent.numPeers} 速度=${(torrent.downloadSpeed / 1024).toFixed(0)}KB/s 元数据=${torrent.metadata ? '有' : '无'}`);
  }
  await new Promise((r) => client.destroy(r));
  console.log('');
}

await testWith('A: 默认 DHT 引导', { maxConns: 100 });
await testWith('B: 自定义 IP 直连 DHT 引导', { maxConns: 100, dht: { bootstrap: DHT_BOOTSTRAP, concurrency: 16 } });
process.exit(0);
