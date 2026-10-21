// 本地测试 HTTP 服务器：可控大小、支持 Range、可控限速
// 用法: node scripts/test-server.mjs [大小MB] [端口]
import http from 'node:http';
import crypto from 'node:crypto';

const SIZE_MB = Number(process.argv[2]) || 32;
const PORT = Number(process.argv[3]) || 18081;
const SIZE = SIZE_MB * 1024 * 1024;
// 预生成 1MB 随机块，重复填充（省内存）
const BLOCK = crypto.randomBytes(1024 * 1024);

const server = http.createServer((req, res) => {
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');

  if (range) {
    const start = parseInt(range[1], 10);
    const end = range[2] ? Math.min(parseInt(range[2], 10), SIZE - 1) : SIZE - 1;
    if (start >= SIZE || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${SIZE}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${SIZE}`,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename="testfile-${SIZE_MB}mb.bin"`
    });
    let pos = start;
    const iv = setInterval(() => {
      if (pos > end) {
        clearInterval(iv);
        return res.end();
      }
      const n = Math.min(BLOCK.length, end - pos + 1);
      res.write(BLOCK.subarray(0, n));
      pos += n;
    }, 1);
    req.on('close', () => clearInterval(iv));
  } else {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': SIZE,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename="testfile-${SIZE_MB}mb.bin"`
    });
    let pos = 0;
    const iv = setInterval(() => {
      if (pos >= SIZE) {
        clearInterval(iv);
        return res.end();
      }
      res.write(BLOCK);
      pos += BLOCK.length;
    }, 1);
    req.on('close', () => clearInterval(iv));
  }
});

server.listen(PORT, () => console.log(`测试服务器就绪: http://127.0.0.1:${PORT}/file.bin (${SIZE_MB}MB, Range 支持)`));
