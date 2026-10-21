// 深入排查：WebTorrent 为什么连不上 tracker / DHT
import WebTorrent from 'webtorrent';
import dns from 'node:dns';

const HASH = '1499a4a94748d06c351254d4c7e9d68648310a3c';

console.log('━━━ ① 检查 tracker 域名在你机器上的实际解析 ━━━');
for (const h of ['tracker.opentrackr.org', 'open.demonii.com', 'router.bittorrent.com', 'router.utorrent.com', 'dht.transmissionbt.com']) {
  await new Promise((res) => {
    dns.lookup(h, { all: true }, (err, addrs) => {
      console.log(`  ${h.padEnd(28)} → ${err ? '❌ ' + err.code : addrs.map((a) => a.address).join(', ')}`);
      res();
    });
  });
}

console.log('');
console.log('━━━ ② WebTorrent 默认 DHT 引导（不传 bootstrap）━━━');
const c1 = new WebTorrent();
await new Promise((res) => {
  const t = setTimeout(() => { console.log('  ❌ 15 秒未 ready'); res(); }, 15000);
  c1.dht.once('ready', () => {
    clearTimeout(t);
    console.log(`  ✅ DHT ready — 路由表 ${c1.dht.nodes.toArray().length} 节点`);
    res();
  });
});
await new Promise((r) => c1.destroy(r));

console.log('');
console.log('━━━ ③ WebTorrent + IP 直连 DHT 引导 ━━━');
const BOOTSTRAP = [
  { host: '212.129.33.59', port: 6881 },
  { host: '185.157.221.247', port: 6881 },
  { host: '87.98.162.88', port: 6881 },
  { host: '82.221.103.244', port: 6881 },
  { host: '67.215.246.10', port: 6881 }
];
const c2 = new WebTorrent({ dht: { bootstrap: BOOTSTRAP, concurrency: 16 } });
await new Promise((res) => {
  const t = setTimeout(() => { console.log('  ❌ 15 秒未 ready'); res(); }, 15000);
  c2.dht.once('ready', () => {
    clearTimeout(t);
    console.log(`  ✅ DHT ready — 路由表 ${c2.dht.nodes.toArray().length} 节点`);
    res();
  });
});
// 给它 20 秒长大
for (let i = 0; i < 4; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  console.log(`  [${(i + 1) * 5}s] 路由表 ${c2.dht.nodes.toArray().length} 节点`);
}
await new Promise((r) => c2.destroy(r));
