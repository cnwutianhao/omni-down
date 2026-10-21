// 诊断脚本：分析一个磁力链接为什么卡在"连接中"（拿不到元数据）
// 用法: node scripts/diagnose.mjs "magnet:?xt=urn:btih:..."
import WebTorrent from 'webtorrent';
import parseTorrent from 'parse-torrent';

const EXTRA_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'wss://tracker.openwebtorrent.com'
];

const input = process.argv[2];
if (!input) {
  console.error('用法: node scripts/diagnose.mjs "magnet:?xt=..."');
  process.exit(1);
}

const t0 = Date.now();
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

console.log('━━━ ① 解析磁力链接 ━━━');
let parsed = null;
try {
  parsed = await parseTorrent(input);
  console.log(`  infoHash: ${parsed.infoHash}`);
  console.log(`  名称: ${parsed.name || '(无)'}`);
  console.log(`  自带 tracker 数量: ${parsed.announce?.length || 0}`);
  if (parsed.announce?.length) parsed.announce.forEach((a) => console.log(`    ${a}`));
  console.log(`  Web seed (ws): ${parsed.urlList?.length || 0}`);
  if (parsed.urlList?.length) parsed.urlList.forEach((u) => console.log(`    ${u}`));
} catch (err) {
  console.log(`  ❌ 解析失败: ${err.message}`);
  process.exit(1);
}

console.log('');
console.log('━━━ ② 启动客户端并添加（附加公共 tracker）━━━');
const client = new WebTorrent();

client.on('error', (err) => console.log(`${ts()} [client error] ${err.message}`));
client.on('warning', (err) => console.log(`${ts()} [client warning] ${err.message}`));

const torrent = client.add(parsed.infoHash, {
  path: '/tmp/tf-diagnose',
  announce: EXTRA_TRACKERS
});

torrent.on('error', (err) => console.log(`${ts()} [torrent error] ${err.message}`));
torrent.on('warning', (err) => console.log(`${ts()} [torrent warning] ${err?.message || err}`));

// DHT 事件
if (client.dht) {
  client.dht.on('ready', () => console.log(`${ts()} [DHT] ready（路由表已就绪）`));
  client.dht.on('listening', () => console.log(`${ts()} [DHT] listening（UDP 已监听）`));
  client.dht.on('error', (err) => console.log(`${ts()} [DHT error] ${err.message}`));
} else {
  console.log(`${ts()} [DHT] ❌ 未启用`);
}

// tracker 事件
torrent.on('trackerAnnounce', () => console.log(`${ts()} [tracker] 有响应`));
torrent.on('dhtAnnounce', () => console.log(`${ts()} [DHT] 已向 DHT 网络查询 peer`));
torrent.on('noPeers', (src) => console.log(`${ts()} [无 peer] 来源: ${src}`));

let firstWire = true;
torrent.on('wire', (wire) => {
  if (firstWire) {
    firstWire = false;
    console.log(`${ts()} [wire] ✅ 建立第一个 peer 连接！`);
  }
  console.log(`${ts()} [wire] +1 peer (${wire.type || '?'}) 当前 ${torrent.numPeers} 个`);
});

torrent.on('metadata', () => {
  console.log(`${ts()} [metadata] ✅✅ 元数据到手！`);
  console.log(`        名称: ${torrent.name}`);
  console.log(`        大小: ${(torrent.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`        文件: ${torrent.files.length} 个`);
  torrent.files.slice(0, 10).forEach((f) => console.log(`          - ${f.name}`));
});

torrent.on('ready', () => console.log(`${ts()} [ready] tracker/DHT 启动完成`));
torrent.on('done', () => console.log(`${ts()} [done] 下载完成`));

console.log(`${ts()} 已添加：${torrent.infoHash}`);

// 每 5 秒报告状态
const iv = setInterval(() => {
  const secs = (Date.now() - t0) / 1000;
  if (secs > 75) return;
  console.log(
    `${ts()} 状态: ready=${torrent.ready} 元数据=${torrent.metadata ? '有' : '无'} peers=${torrent.numPeers} 已下载=${(torrent.downloaded / 1024).toFixed(0)}KB`
  );
}, 5000);

// 75 秒后总结
setTimeout(async () => {
  clearInterval(iv);
  console.log('');
  console.log('━━━ ③ 诊断结论 ━━━');
  console.log(`  拿到元数据: ${torrent.metadata ? '✅ 是' : '❌ 否'}`);
  console.log(`  连到过 peer: ${torrent.numPeers > 0 ? `✅ 当前 ${torrent.numPeers} 个` : '❌ 一个都没有'}`);
  console.log(`  DHT 就绪: ${client.dht?.ready ? '✅' : '❌'}`);
  console.log(`  已下载数据: ${(torrent.downloaded / 1024).toFixed(0)} KB`);
  console.log(`  已上传数据: ${(torrent.uploaded / 1024).toFixed(0)} KB`);

  if (!torrent.metadata && torrent.numPeers === 0) {
    console.log('');
    console.log('  ⚠️ 结论：完全找不到持有这个种子的 peer。');
    console.log('     常见原因：');
    console.log('     1. 这是个"死种"——做种者已全部下线');
    console.log('     2. 种子的所有 peer 都在被墙的网络 / 或需要 WebRTC 特殊通道');
    console.log('     3. 你的网络屏蔽了 DHT（UDP 流量）和公共 tracker');
  } else if (!torrent.metadata && torrent.numPeers > 0) {
    console.log('');
    console.log('  ⚠️ 结论：能连上 peer，但对方不给元数据（对方可能没在真正做种）。');
  } else {
    console.log('');
    console.log('  ✅ 结论：种子正常，元数据获取成功。');
  }

  await new Promise((r) => client.destroy(r));
  process.exit(0);
}, 75000);
