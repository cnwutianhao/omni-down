// 测试：用正确的 DHT 引导节点，能否找到指定种子的 peer
import WebTorrent from 'webtorrent';

const INPUT = process.argv[2] || 'magnet:?xt=urn:btih:1499a4a94748d06c351254d4c7e9d68648310a3c';

// 绕过 DNS 污染的引导节点（IP 直连）
const BOOTSTRAP = [
  { host: '212.129.33.59', port: 6881 }, // dht.transmissionbt.com
  { host: '185.157.221.247', port: 6881 }, // dht.libtorrent.org
  { host: '87.98.162.88', port: 6881 }, // dht.transmissionbt.com
  { host: '82.221.103.244', port: 6881 }, // dht.transmissionbt.com
  { host: '67.215.246.10', port: 6881 } // router.bittorrent.com
];

const client = new WebTorrent({
  dht: { bootstrap: BOOTSTRAP, concurrency: 16 },
  maxConns: 100
});

const t0 = Date.now();
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

client.on('error', (e) => console.log(`${ts()} [client error] ${e.message}`));
if (client.dht) {
  client.dht.on('ready', () => console.log(`${ts()} [DHT] ready，路由表 ${client.dht.nodes.toArray().length} 节点`));
}

const torrent = client.add(INPUT, { path: '/tmp/tf-diag2' });
torrent.on('warning', (w) => console.log(`${ts()} [warn] ${w?.message || w}`));
torrent.on('error', (e) => console.log(`${ts()} [error] ${e.message}`));
torrent.on('dhtAnnounce', () => console.log(`${ts()} [DHT] 开始向 DHT 查询该种子的 peer`));
torrent.on('wire', () => console.log(`${ts()} [wire] ✅ peer +1（当前 ${torrent.numPeers}）`));
torrent.on('metadata', () => {
  console.log(`${ts()} [metadata] ✅✅ 拿到元数据：${torrent.name} (${(torrent.length / 1024 / 1024).toFixed(2)} MB, ${torrent.files.length} 个文件)`);
});
torrent.on('noPeers', (src) => console.log(`${ts()} [无peer] ${src}`));

let lastPeers = 0;
const iv = setInterval(() => {
  const n = torrent.numPeers;
  if (n !== lastPeers) {
    console.log(`${ts()} peers 变化: ${lastPeers} → ${n}`);
    lastPeers = n;
  }
}, 3000);

setTimeout(async () => {
  clearInterval(iv);
  console.log('');
  console.log('━━━ 结果 ━━━');
  console.log(`  元数据: ${torrent.metadata ? '✅ 有' : '❌ 无'}`);
  console.log(`  当前 peer 数: ${torrent.numPeers}`);
  console.log(`  曾连到过 peer: ${lastPeers > 0 ? '✅' : '❌'}`);
  console.log(`  下载量: ${(torrent.downloaded / 1024).toFixed(0)} KB`);
  console.log(`  DHT 路由表: ${client.dht?.nodes?.toArray()?.length ?? 0} 节点`);
  await new Promise((r) => client.destroy(r));
  process.exit(0);
}, 60000);
