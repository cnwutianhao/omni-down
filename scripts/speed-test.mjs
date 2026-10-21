// 速度诊断：观察 ① 号种子长时间下载速度 + 连到多少 peer
import WebTorrent from 'webtorrent';

const HASH = '37c0de78b0502b3bf27a17681dc2fa11217d8ff9';

const client = new WebTorrent({ maxConns: 100 });
const torrent = client.add(`magnet:?xt=urn:btih:${HASH}`, {
  path: '/tmp/tf-speed',
  announce: [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.demonii.com:1337/announce',
    'http://tracker.openbittorrent.com:80/announce'
  ]
});

const t0 = Date.now();
let peak = 0;
torrent.on('wire', () => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] peer +1 (总 ${torrent.numPeers})`));
torrent.on('metadata', () => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] 元数据: ${torrent.name}`));

const iv = setInterval(() => {
  const s = torrent.downloadSpeed;
  if (s > peak) peak = s;
  console.log(
    `  [${((Date.now() - t0) / 1000).toFixed(0)}s] peers=${torrent.numPeers} | ` +
    `速度=${(s / 1024).toFixed(0)} KB/s | 已下=${(torrent.downloaded / 1024 / 1024).toFixed(1)} MB | ` +
    `进度=${(torrent.progress * 100).toFixed(2)}%`
  );
}, 5000);

setTimeout(async () => {
  clearInterval(iv);
  console.log('');
  console.log(`  峰值速度: ${(peak / 1024).toFixed(0)} KB/s`);
  console.log(`  90 秒共下载: ${(torrent.downloaded / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  文件总大小: ${(torrent.length / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`  按平均速度 ${(torrent.downloaded / 90 / 1024).toFixed(0)} KB/s 估算，完整下载需 ${(torrent.length / (torrent.downloaded / 90)).toFixed(0)} 秒（约 ${(torrent.length / (torrent.downloaded / 90) / 3600).toFixed(1)} 小时）`);
  await new Promise((r) => client.destroy(r));
  process.exit(0);
}, 90000);
