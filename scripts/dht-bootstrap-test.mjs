// 用真实 IP 做 DHT 引导，绕过 DNS 污染
import DHT from 'bittorrent-dht';

// 候选引导节点（host 直接用 IP，避免 DNS 解析）
const CANDIDATES = [
  { host: '212.129.33.59', port: 6881, tag: 'dht.transmissionbt.com (当前DNS解析)' },
  { host: '185.157.221.247', port: 6881, tag: 'dht.libtorrent.org (当前DNS解析)' },
  { host: '87.98.162.88', port: 6881, tag: 'dht.transmissionbt.com (历史IP)' },
  { host: '82.221.103.244', port: 6881, tag: 'dht.transmissionbt.com (历史IP-冰岛)' },
  { host: '67.215.246.10', port: 6881, tag: 'router.bittorrent.com (历史真实IP)' },
  { host: '185.125.190.59', port: 6881, tag: 'dht.transmissionbt.com (备选)' },
  { host: 'router.bitcomet.com', port: 6881, tag: 'router.bitcomet.com (域名)' },
  { host: 'dht.aelitis.com', port: 6881, tag: 'dht.aelitis.com (Vuze)' }
];

for (const c of CANDIDATES) {
  await new Promise((resolve) => {
    const dht = new DHT({ bootstrap: [{ host: c.host, port: c.port }], concurrency: 16 });
    let done = false;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      console.log(`${ok ? '✅' : '❌'} ${c.tag} — ${detail}`);
      try { dht.destroy(); } catch {}
      resolve();
    };
    dht.on('error', (err) => finish(false, `错误: ${err.message}`));
    dht.on('ready', () => finish(true, `DHT 就绪，路由表 ${dht.nodes.toArray().length} 个节点`));
    setTimeout(() => finish(false, '8 秒内无响应（UDP 不通或节点已失效）'), 8000);
  });
}
