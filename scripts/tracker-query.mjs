// 通过 UDP tracker 协议直接查询种子做种情况（绕过 DNS 污染，用真实 IP）
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';

const HASH = process.argv[2] || '1499a4a94748d06c351254d4c7e9d68648310a3c';

// UDP tracker（用域名，让系统解析；若失败可换 IP）
const UDP_TRACKERS = [
  { host: 'tracker.opentrackr.org', port: 1337, name: 'opentrackr' },
  { host: 'open.tracker.cl', port: 1337, name: 'open.tracker.cl' },
  { host: 'exodus.desync.com', port: 6969, name: 'exodus' },
  { host: 'tracker.torrent.eu.org', port: 451, name: 'torrent.eu.org' },
  { host: 'open.demonii.com', port: 1337, name: 'demonii' },
  { host: 'tracker.openbittorrent.com', port: 6969, name: 'openbittorrent' },
  { host: 'tracker.dler.org', port: 6969, name: 'dler' }
];

const infoHashBin = Buffer.from(HASH, 'hex');

function udpAnnounce({ host, port, name }) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const start = Date.now();
    let stage = 'connect';
    const transactionId = randomBytes(4);

    const cleanup = (ok, msg) => {
      try { socket.close(); } catch {}
      resolve({ ok, name, ms: Date.now() - start, msg });
    };

    const timer = setTimeout(() => cleanup(false, `${stage} 超时`), 10000);

    socket.on('error', (err) => {
      clearTimeout(timer);
      cleanup(false, err.message);
    });

    socket.on('message', (msg) => {
      if (msg.length >= 8 && stage === 'connect') {
        // connect 响应: action(4) + transaction(4) + connection_id(8)
        const action = msg.readUInt32BE(0);
        if (action === 0) {
          stage = 'announce';
          const connectionId = msg.subarray(8, 16);
          // announce 请求: connection_id(8) + action(4)=1 + transaction(4) + info_hash(20) + peer_id(20) + downloaded(8) + left(8) + uploaded(8) + event(4)=2 + ip(4)=0 + key(4) + num_want(4)=-1 + port(2)
          const req = Buffer.alloc(98);
          connectionId.copy(req, 0);
          req.writeUInt32BE(1, 8); // action: announce
          randomBytes(4).copy(req, 12); // transaction
          infoHashBin.copy(req, 16);
          Buffer.from('-TF1000-' + randomBytes(6).toString('hex')).copy(req, 36, 0, 20);
          req.writeBigUInt64BE(0n, 56); // downloaded
          req.writeBigUInt64BE(0n, 64); // left
          req.writeBigUInt64BE(0n, 72); // uploaded
          req.writeUInt32BE(2, 80); // event: started
          req.writeUInt32BE(0, 84); // ip
          randomBytes(4).copy(req, 88); // key
          req.writeInt32BE(-1, 92); // num_want
          req.writeUInt16BE(6881, 96); // port
          socket.send(req, port, host);
        }
      } else if (stage === 'announce' && msg.length >= 20) {
        clearTimeout(timer);
        const action = msg.readUInt32BE(0);
        if (action === 1) {
          // announce 响应: action(4) + transaction(4) + interval(4) + leechers(4) + seeders(4) + peers...
          const seeders = msg.readUInt32BE(12);
          const leechers = msg.readUInt32BE(16);
          const peerCount = Math.floor((msg.length - 20) / 6);
          cleanup(true, `做种:${seeders} 下载中:${leechers} peer列表:${peerCount}`);
        } else if (action === 3) {
          cleanup(false, 'tracker 返回错误（可能是种子未登记）');
        } else {
          cleanup(false, `未知响应 action=${action}`);
        }
      }
    });

    // 发送 connect 请求: connection_id(8)=0x41727101980 + action(4)=0 + transaction(4)
    const connectReq = Buffer.alloc(16);
    connectReq.writeBigUInt64BE(0x41727101980n, 0);
    connectReq.writeUInt32BE(0, 8);
    transactionId.copy(connectReq, 12);
    socket.send(connectReq, port, host);
  });
}

console.log(`查询种子: ${HASH}\n`);
for (const tr of UDP_TRACKERS) {
  const r = await udpAnnounce(tr);
  console.log(`${r.ok ? '✅' : '❌'} ${r.name.padEnd(20)} ${String(r.ms).padStart(5)}ms  ${r.msg}`);
}
console.log('\n注：做种:0 且下载中:0 表示 tracker 上没有人在分享这个种子。');
