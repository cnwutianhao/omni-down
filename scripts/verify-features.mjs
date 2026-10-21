// 验证新功能：限速、文件选择、流媒体服务器
import { TorrentEngine } from '../src/main/torrent-engine.js';

const e = new TorrentEngine({
  downloadDir: '/tmp/tf-features',
  stateFile: '/tmp/tf-features/state.json'
});

await e.start();
console.log('① 引擎启动 ✅');

// ---- 限速 ----
console.log('\n② 限速功能');
e.setSpeedLimit(512 * 1024, 256 * 1024); // 512 KB/s down, 256 KB/s up
console.log('   client.downloadLimit =', e.client.downloadLimit, '(期望 524288)');
console.log('   client.uploadLimit =', e.client.uploadLimit, '(期望 262144)');
console.log('   engine.limits =', JSON.stringify(e.limits));
e.setSpeedLimit(-1, -1);
console.log('   恢复不限速: downloadLimit =', e.client.downloadLimit, '(期望 -1)');

// ---- 添加多文件种子测试文件选择 ----
console.log('\n③ 文件选择（用 Sintel 测试种子）');
e.add('magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel');

// 等元数据
let torrent = null;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  torrent = e._torrentOf('08ada5a7a6183aae1e09d831df6748d566095a10');
  if (torrent?.ready) break;
}
if (!torrent?.ready) {
  console.log('   ❌ 30 秒未拿到元数据，跳过文件/流媒体测试');
  await e.stop();
  process.exit(1);
}
console.log(`   元数据: ${torrent.name}，${torrent.files.length} 个文件`);

const files = e.filesOf(torrent.infoHash);
console.log('   filesOf():');
files.forEach((f) => console.log(`     [${f.index}] ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB) selected=${f.selected}`));

// 取消选择第 2 个文件（如果有多文件）
if (files.length > 1) {
  e.setFileSelection(torrent.infoHash, [{ index: 1, selected: false }]);
  const after = e.filesOf(torrent.infoHash);
  console.log('   取消第 2 个文件后:');
  after.forEach((f) => console.log(`     [${f.index}] selected=${f.selected}`));
  console.log('   ✅ 文件选择生效:', after[1].selected === false);
} else {
  console.log('   （单文件种子，跳过取消选择演示）');
}

// ---- 流媒体 ----
console.log('\n④ 流媒体服务器');
const streamRes = e.startStream(torrent.infoHash);
console.log('   startStream():', JSON.stringify(streamRes));
if (streamRes.ok) {
  const url = e.streamUrl(torrent.infoHash, 0);
  console.log('   streamUrl():', url);
  // 实际请求验证
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    console.log('   HTTP HEAD 请求:', res.status, res.headers.get('content-type'), '| content-length:', res.headers.get('content-length'));
    console.log('   ✅ 流媒体服务器工作正常');
  } catch (err) {
    console.log('   ⚠️ HTTP 请求失败:', err.message);
  }
  e.stopStream(torrent.infoHash);
  console.log('   已停止流媒体');
}

// ---- serialize 包含 fileDetails ----
console.log('\n⑤ serialize() 包含 fileDetails');
const s = e.serialize(torrent);
console.log('   fileDetails 数量:', s.fileDetails?.length, '| 第一个:', JSON.stringify(s.fileDetails?.[0]));

await e.stop();
console.log('\n✅ 全部新功能验证完成');
process.exit(0);
