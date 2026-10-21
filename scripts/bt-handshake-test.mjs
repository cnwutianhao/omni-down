// 验证 ③ 号种子的那个"可达 peer"到底是真 peer 还是假信号
// 手动发 BT 握手包，看对方是否回应
import net from 'node:net';
import { randomBytes } from 'node:crypto';

const HASHES = [
  { hash: '98d3e6f53e07a2d318078c8f0a29ea5b9c382883', peers: ['210.209.108.46:9959'], label: '③' },
  { hash: '37c0de78b0502b3bf27a17681dc2fa11217d8ff9', peers: ['58.21.103.236:51413'], label: '①' },
  { hash: '39557e78e92806f7b3300eeb4c0dbca18cc0652e', peers: [], label: '④' }
];

/** 发送 BT 握手，等待 68 字节响应（handshake: 1+19+8+20+20） */
function btHandshake(hash, host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const t0 = Date.now();
    let got = false;
    const done = (ok, note) => {
      if (got) return;
      got = true;
      sock.destroy();
      resolve({ ok, ms: Date.now() - t0, note });
    };

    sock.setTimeout(timeoutMs);
    sock.on('connect', () => {
      // 构造握手包
      const pstrlen = Buffer.from([19]);
      const pstr = Buffer.from('BitTorrent protocol');
      const reserved = Buffer.alloc(8); // 全 0
      const infoHash = Buffer.from(hash, 'hex');
      const peerId = Buffer.concat([Buffer.from('-TF1000-'), randomBytes(12)]);
      const packet = Buffer.concat([pstrlen, pstr, reserved, infoHash, peerId]);
      sock.write(packet);
    });
    sock.on('data', (data) => {
      // 期望收到 68 字节握手响应
      if (data.length >= 68 && data[0] === 19) {
        const isBt = data.subarray(1, 20).toString() === 'BitTorrent protocol';
        if (isBt) return done(true, `合法 BT 握手响应 (${data.length}B)`);
        return done(false, `响应非 BT 协议: ${data.subarray(0, 30).toString('hex')}`);
      }
      done(false, `收到 ${data.length}B 非握手数据: ${data.subarray(0, 40).toString('hex')}`);
    });
    sock.on('timeout', () => done(false, '超时（TCP 通但无 BT 响应）'));
    sock.on('error', (e) => done(false, e.code || e.message));
  });
}

for (const c of HASHES) {
  console.log(`━━━ ${c.label} ${c.hash.slice(0, 12)}… ━━━`);
  if (c.peers.length === 0) {
    console.log('  （无可用 peer，跳过）\n');
    continue;
  }
  for (const p of c.peers) {
    const [host, port] = p.split(':');
    const r = await btHandshake(c.hash, host, Number(port));
    console.log(`  ${r.ok ? '✅' : '❌'} ${p.padEnd(22)} ${r.ms}ms — ${r.note}`);
  }
  console.log('');
}
process.exit(0);
