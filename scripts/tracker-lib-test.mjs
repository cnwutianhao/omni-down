// 复现测试：直接用 bittorrent-tracker 库（WebTorrent 内部用的）做 announce
// 对比"裸 UDP socket 能通"vs"库调用超时"
import Client from 'bittorrent-tracker';
import { hex2arr } from 'uint8-util';

const HASH = '1499a4a94748d06c351254d4c7e9d68648310a3c';

async function testTracker(url) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // 必须 20 字节：8 字节前缀 + 12 字节随机
    const peerIdBuf = Buffer.concat([Buffer.from('-TF1000-'), Buffer.from('123456789012')]);
    const client = new Client({
      infoHash: hex2arr(HASH),
      peerId: new Uint8Array(peerIdBuf),
      announce: [url],
      port: 6881
    });

    let done = false;
    const finish = (ok, msg) => {
      if (done) return;
      done = true;
      console.log(`${ok ? '✅' : '❌'} ${url}\n     ${Date.now() - t0}ms | ${msg}`);
      try { client.destroy(); } catch {}
      resolve();
    };

    client.on('error', (err) => finish(false, `错误: ${err.message}`));
    client.on('warning', (err) => console.log(`     [warn] ${err.message}`));
    client.on('peer', (peer) => {
      console.log(`     🎯 收到 peer: ${peer.host ?? peer.ip}:${peer.port}`);
    });
    client.on('update', (data) => {
      finish(true, `announce 成功！seeders=${data.complete ?? '?'} leechers=${data.incomplete ?? '?'}`);
    });

    client.start();
    setTimeout(() => finish(false, '10 秒超时'), 10000);
  });
}

console.log('━━━ 直接测试 bittorrent-tracker 库 ━━━');
for (const url of [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce'
]) {
  await testTracker(url);
  console.log('');
}
