/**
 * 从 build/icon.png 生成多尺寸 build/icon.ico
 *
 * 为什么需要这个脚本：
 * - Windows 在标题栏 / 任务栏 / 资源管理器 / 桌面分别使用 16–256px 的不同尺寸，
 *   ICO 只含一张 256px 时系统会缩放，小尺寸下图标会糊。
 * - 纯 Node 实现（只用内置 zlib），macOS / Windows / Linux 都能跑，
 *   替代只能在 macOS 上运行的 scripts/gen-icon.js。
 *
 * 用法：node scripts/gen-icon-ico.mjs [源 PNG] [输出 ICO]
 *   node scripts/gen-icon-ico.mjs
 *   node scripts/gen-icon-ico.mjs build/icon.png build/icon.ico
 *
 * 编码策略：
 * - 16–128px 用 BMP（DIB）条目，兼容性最好
 * - 256px 用 PNG 条目，体积小且 Vista+ 全支持
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZES = [16, 24, 32, 48, 64, 128, 256];
/** 该尺寸及以上用 PNG 条目，其余用 BMP */
const PNG_THRESHOLD = 256;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.argv[2] || path.join(__dirname, '../build/icon.png'));
const OUT = path.resolve(process.argv[3] || path.join(__dirname, '../build/icon.ico'));

// ---------------------------------------------------------------- PNG 解码

/** Paeth 预测器（PNG 规范 9.4） */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 解码 PNG 为 8-bit RGBA。
 * 支持 bitDepth 8/16、colorType 0/2/3/4/6、非交错。
 * 16-bit 取高字节（等价于 >> 8 截断到 8-bit）。
 */
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('不是有效的 PNG 文件');
  }

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  const idat = [];

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  if (interlace !== 0) throw new Error('不支持交错（Adam7）PNG，请另存为非交错格式');
  if (![8, 16].includes(bitDepth)) throw new Error(`不支持的位深 ${bitDepth}（仅支持 8 / 16）`);

  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`);

  const sampleBytes = bitDepth / 8;
  const bpp = channels * sampleBytes; // 每个像素占用的字节数（用于 filter 还原）
  const stride = width * bpp;

  // 1) 解压 + 逐行还原 filter
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  let rp = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = pixels.subarray(y * stride, (y + 1) * stride);

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (v + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`未知的 PNG filter ${filter}（第 ${y} 行）`);
      }
      cur[x] = v;
    }
    prev = cur;
  }

  // 2) 转成 8-bit RGBA
  const rgba = Buffer.alloc(width * height * 4);
  const readSample = (base, index) =>
    sampleBytes === 2 ? pixels.readUInt16BE(base + index * 2) >> 8 : pixels[base + index];

  for (let i = 0; i < width * height; i++) {
    const base = i * bpp;
    const o = i * 4;
    let r;
    let g;
    let b;
    let a = 255;
    switch (colorType) {
      case 0: // 灰度
        r = g = b = readSample(base, 0);
        break;
      case 2: // RGB
        r = readSample(base, 0);
        g = readSample(base, 1);
        b = readSample(base, 2);
        break;
      case 3: { // 调色板
        if (!palette) throw new Error('调色板 PNG 缺少 PLTE 块');
        const idx = pixels[base];
        r = palette[idx * 3];
        g = palette[idx * 3 + 1];
        b = palette[idx * 3 + 2];
        break;
      }
      case 4: // 灰度 + alpha
        r = g = b = readSample(base, 0);
        a = readSample(base, 1);
        break;
      case 6: // RGBA
        r = readSample(base, 0);
        g = readSample(base, 1);
        b = readSample(base, 2);
        a = readSample(base, 3);
        break;
    }
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = a;
  }

  return { width, height, rgba };
}

// ---------------------------------------------------------------- 缩放

/**
 * 面积平均（box filter）缩放。
 * 用预乘 alpha 做加权平均，避免透明边缘出现暗边。
 */
function resize(rgba, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;

  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * yRatio;
    const y1 = y0 + yRatio;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(Math.ceil(y1), sh);

    for (let dx = 0; dx < dw; dx++) {
      const x0 = dx * xRatio;
      const x1 = x0 + xRatio;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(Math.ceil(x1), sw);

      let r = 0;
      let g = 0;
      let b = 0;
      let aSum = 0;
      let wSum = 0;

      for (let sy = iy0; sy < iy1; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = ix0; sx < ix1; sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const so = (sy * sw + sx) * 4;
          const alpha = rgba[so + 3];
          r += rgba[so] * alpha * w;
          g += rgba[so + 1] * alpha * w;
          b += rgba[so + 2] * alpha * w;
          aSum += alpha * w;
          wSum += w;
        }
      }

      const o = (dy * dw + dx) * 4;
      if (wSum === 0) continue;
      if (aSum > 0) {
        out[o] = Math.round(r / aSum);
        out[o + 1] = Math.round(g / aSum);
        out[o + 2] = Math.round(b / aSum);
      }
      out[o + 3] = Math.round(aSum / wSum);
    }
  }

  return out;
}

// ---------------------------------------------------------------- 编码

/** 生成 ICO 条目：32bpp BMP（DIB） */
function encodeBmpEntry(rgba, w, h) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(w, 4); // biWidth
  header.writeInt32LE(h * 2, 8); // biHeight：XOR 图 + AND 掩码
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(w * h * 4, 20); // biSizeImage
  // 其余字段（分辨率 / 调色板）保持 0

  // XOR 位图：BGRA、自下而上
  const xor = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRow = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const so = (srcRow * w + x) * 4;
      const o = (y * w + x) * 4;
      xor[o] = rgba[so + 2]; // B
      xor[o + 1] = rgba[so + 1]; // G
      xor[o + 2] = rgba[so]; // R
      xor[o + 3] = rgba[so + 3]; // A
    }
  }

  // AND 掩码：1bpp，每行按 4 字节对齐。32bpp 下靠 alpha 通道，掩码全 0 即可
  const maskRowBytes = ((w + 31) >> 5) * 4;
  const mask = Buffer.alloc(maskRowBytes * h);

  return Buffer.concat([header, xor, mask]);
}

/** 生成 ICO 条目：PNG */
function encodePngEntry(rgba, w, h) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter = None
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 把若干条目组装成 ICO 容器 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = 1 (ICO)
  header.writeUInt16LE(entries.length, 4);

  const dirs = [];
  let offset = 6 + entries.length * 16;
  for (const e of entries) {
    const dir = Buffer.alloc(16);
    dir[0] = e.size >= 256 ? 0 : e.size; // 0 表示 256
    dir[1] = e.size >= 256 ? 0 : e.size;
    dir[2] = 0; // 调色板颜色数
    dir[3] = 0; // reserved
    dir.writeUInt16LE(1, 4); // planes
    dir.writeUInt16LE(32, 6); // bit count
    dir.writeUInt32LE(e.data.length, 8);
    dir.writeUInt32LE(offset, 12);
    dirs.push(dir);
    offset += e.data.length;
  }

  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.data)]);
}

// ---------------------------------------------------------------- 主流程

const srcBuf = fs.readFileSync(SRC);
const { width, height, rgba } = decodePng(srcBuf);
console.log(`源文件：${path.relative(process.cwd(), SRC)}`);
console.log(`尺寸：${width}×${height}`);

if (width !== height) {
  console.warn('⚠️  源图不是正方形，ICO 图标建议使用正方形源图');
}

const entries = SIZES.map((size) => {
  const scaled = size === width ? rgba : resize(rgba, width, height, size, size);
  const usePng = size >= PNG_THRESHOLD;
  const data = usePng ? encodePngEntry(scaled, size, size) : encodeBmpEntry(scaled, size, size);
  console.log(`  ${String(size).padStart(3)}×${String(size).padEnd(3)}  ${usePng ? 'PNG' : 'BMP'}  ${String(data.length).padStart(7)} 字节`);
  return { size, data };
});

const ico = buildIco(entries);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, ico);

console.log(`\n已生成：${path.relative(process.cwd(), OUT)}`);
console.log(`尺寸数：${entries.length}（${SIZES.join(', ')}）`);
console.log(`总大小：${(ico.length / 1024).toFixed(1)} KB`);
