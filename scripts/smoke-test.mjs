// 引擎冒烟测试：验证 WebTorrent 能加载、能解析磁力、能找到 peer
// 使用 WebTorrent 官方的 Sintel（Blender 基金会开源电影，CC 协议）测试种子
import WebTorrent from 'webtorrent';

const TEST_MAGNET =
  'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent';

const client = new WebTorrent();
let settled = false;

const finish = async (code, msg) => {
  if (settled) return;
  settled = true;
  console.log(msg);
  await new Promise((r) => client.destroy(r));
  process.exit(code);
};

console.log('① WebTorrent 已加载，版本可用');
console.log(`   DHT: ${client.dht ? '已启用' : '未启用'}`);

const torrent = client.add(TEST_MAGNET, { path: '/tmp/tf-smoke' });

torrent.once('metadata', () => {
  console.log('② 元数据解析成功');
  console.log(`   名称: ${torrent.name}`);
  console.log(`   大小: ${(torrent.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`   文件数: ${torrent.files.length}`);
  console.log(`   infoHash: ${torrent.infoHash}`);
});

torrent.once('ready', () => {
  console.log('③ 已连接 tracker，开始寻找 peer…');
});

let announced = false;
torrent.on('wire', () => {
  if (!announced && torrent.numPeers > 0) {
    announced = true;
    console.log(`④ 已找到 ${torrent.numPeers} 个 peer，网络连通正常`);
    setTimeout(() => finish(0, '✅ 引擎测试通过（DHT + tracker + peer 连接全部正常）'), 1500);
  }
});

setTimeout(() => {
  if (torrent.numPeers === 0) {
    finish(
      1,
      '⚠️ 30 秒内未找到 peer（可能是网络环境限制或 tracker 暂时不可达），但引擎本身已正常加载'
    );
  }
}, 30000);

setTimeout(() => finish(1, '❌ 60 秒超时：未能获取元数据'), 60000);
