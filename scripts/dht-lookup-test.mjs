// 直接用 DHT 协议查询：这个 infoHash 在全网 DHT 里有没有 peer？
// 这是判断"死种"最直接的方法
import DHT from 'bittorrent-dht';
import { hex2arr } from 'uint8-util';

const HASH = process.argv[2] || '1499a4a94748d06c351254d4c7e9d68648310a3c';

const BOOTSTRAP = [
  { host: '212.129.33.59', port: 6881 },
  { host: '185.157.221.247', port: 6881 },
  { host: '87.98.162.88', port: 6881 },
  { host: '82.221.103.244', port: 6881 },
  { host: '67.215.246.10', port: 6881 },
  { host: 'dht.transmissionbt.com', port: 6881 },
  { host: 'router.bitcomet.com', port: 6881 },
  { host: 'dht.aelitis.com', port: 6881 }
];

const dht = new DHT({ bootstrap: BOOTSTRAP, concurrency: 16 });
const t0 = Date.now();
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

dht.on('error', (e) => console.log(`${ts()} [DHT error] ${e.message}`));

dht.on('ready', async () => {
  console.log(`${ts()} DHT 就绪，初始路由表 ${dht.nodes.toArray().length} 节点`);

  // 等路由表长大一点
  await new Promise((r) => setTimeout(r, 8000));
  console.log(`${ts()} 8 秒后路由表: ${dht.nodes.toArray().length} 节点`);

  const infoHash = hex2arr(HASH);
  console.log(`${ts()} 开始查询 infoHash=${HASH} 的 peer…`);

  let peerCount = 0;
  const peers = new Set();

  const lookup = dht.lookup(infoHash);

  dht.on('peer', (peer, hash) => {
    peerCount++;
    const key = `${peer.host}:${peer.port}`;
    if (!peers.has(key)) {
      peers.add(key);
      console.log(`${ts()} 🎯 找到 peer #${peerCount}: ${key}`);
    }
  });

  // 监听 lookup 完成
  lookup.on?.('done', () => console.log(`${ts()} lookup 完成`));

  setTimeout(() => {
    console.log('');
    console.log('━━━ DHT 全网查询结果 ━━━');
    console.log(`  路由表规模: ${dht.nodes.toArray().length} 节点`);
    console.log(`  找到 peer: ${peers.size} 个`);
    if (peers.size > 0) {
      console.log('  ✅ 这个种子在 DHT 网络里是活的！peer 列表：');
      [...peers].slice(0, 20).forEach((p) => console.log(`     ${p}`));
    } else {
      console.log('  ❌ DHT 全网没有找到任何 peer —— 这是一个死种');
      console.log('     （做种者已全部下线，谁都下不动，不是你客户端的问题）');
    }
    dht.destroy();
    process.exit(0);
  }, 25000);
});

setTimeout(() => {
  console.log(`${ts()} ❌ DHT 未能就绪`);
  process.exit(1);
}, 30000);
