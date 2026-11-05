// make-icons.js —— 生成 16/48/128 图标（纯 Node，无依赖）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crcBuf]);
}

// 画一个蓝底圆角 + 白色播放三角 + 底部进度条
function draw(size) {
  const px = (x, y) => {
    const cx = size / 2, cy = size / 2;
    const r = size * 0.46;
    // 圆角方形（超椭圆近似）
    const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
    const inside = Math.pow(dx / r, 4) + Math.pow(dy / r, 4) <= 1;
    if (!inside) return [0, 0, 0, 0];

    // 底色渐变
    const t = y / size;
    let R = Math.round(48 + t * 40);
    let G = Math.round(96 + t * 40);
    let B = Math.round(240 - t * 20);

    // 播放三角
    const ax = size * 0.36, ay = size * 0.32, bx = size * 0.68, by = size * 0.5, cyy = size * 0.68;
    const tri = (x >= ax && y >= ay && y <= cyy && x <= bx - (y - ay) * 0.62);
    if (tri) { R = 255; G = 255; B = 255; }

    // 底部进度条
    if (y > size * 0.76 && y < size * 0.86 && x > size * 0.24 && x < size * 0.76) {
      if (x < size * 0.55) { R = 255; G = 255; B = 255; } else { R = 255; G = 255; B = 255; }
    }
    return [R, G, B, 255];
  };

  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px(x, y);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 48, 128]) {
  const buf = draw(size);
  fs.writeFileSync(path.join(dir, size + '.png'), buf);
  console.log('icons/' + size + '.png  ' + buf.length + ' 字节');
}
