// 生成应用图标：assets/icon.png(256, 打包用) + icon-32.png / icon-16.png(托盘用)。
// 纯 Node 实现 PNG 编码（zlib + CRC32），不依赖任何图像库。
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 珊瑚色圆角底 + 白色时钟面（坐标按 size/256 缩放）
function draw(S) {
  const px = Buffer.alloc(S * S * 4);
  const f = S / 256;
  const blend = (x, y, r, g, b, a) => {
    const i = (y * S + x) * 4;
    const sa = a / 255;
    const da = px[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
    px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
    px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
    px[i + 3] = Math.round(oa * 255);
  };
  const inRoundedRect = (x, y, rad) => {
    const half = S / 2 - 1;
    const rr = rad * f;
    const dx = Math.max(Math.abs(x - S / 2) - (half - rr), 0);
    const dy = Math.max(Math.abs(y - S / 2) - (half - rr), 0);
    return dx * dx + dy * dy <= rr * rr;
  };
  const distSeg = (px0, py0, ax, ay, bx, by) => {
    const vx = bx - ax, vy = by - ay;
    const wx = px0 - ax, wy = py0 - ay;
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
    const dx = px0 - (ax + t * vx), dy = py0 - (ay + t * vy);
    return Math.sqrt(dx * dx + dy * dy);
  };
  const C = S / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (inRoundedRect(x, y, 56)) {
        const t = y / S;
        blend(x, y, 255, Math.round(138 + 40 * t), Math.round(92 + 30 * t), 255); // 珊瑚橙渐变
      }
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - C, y - C);
      if (d >= 60 * f && d <= 74 * f) blend(x, y, 255, 255, 255, 255); // 时钟外环
      if (distSeg(x, y, C, C, C, C - 40 * f) <= 5 * f) blend(x, y, 255, 255, 255, 255); // 时针
      if (distSeg(x, y, C, C, C + 36 * f, C) <= 4 * f) blend(x, y, 255, 255, 255, 255); // 分针
      if (d <= 9 * f) blend(x, y, 255, 255, 255, 255); // 中心点
    }
  }
  return px;
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, size] of [['icon.png', 256], ['icon-32.png', 32], ['icon-16.png', 16]]) {
  const out = path.join(outDir, name);
  fs.writeFileSync(out, encodePNG(size, size, draw(size)));
  console.log('written', out, fs.statSync(out).size, 'bytes');
}
