// Generates cover.png (800x534) for gladys-lg-horizon: plain Node, no dependency.
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};

// Background: diagonal gradient, night blue to violet.
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W + y / H) / 2;
    set(x, y, [20 + 60 * t, 24 + 20 * t, 70 + 70 * t]);
  }
}
const white = [255, 255, 255];
const accent = [255, 176, 59];
const screen = [36, 120, 200];

const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
// Rounded rectangle, anti-aliased corners.
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y + 0.5, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const arc = (cx, cy, r, width, from, to, color) => {
  for (let y = Math.floor(cy - r - width); y <= cy + r + width; y += 1) {
    for (let x = Math.floor(cx - r - width); x <= cx + r + width; x += 1) {
      const ang = Math.atan2(y - cy, x - cx);
      if (ang < from || ang > to) continue;
      const a = Math.max(
        0,
        Math.min(1, width / 2 - Math.abs(Math.hypot(x - cx, y - cy) - r) + 0.5),
      );
      if (a > 0) set(x, y, color, a);
    }
  }
};
const tri = (ax, ay, bx, by, cx, cy, color) => {
  const s = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  for (let y = Math.min(ay, by, cy); y <= Math.max(ay, by, cy); y += 1) {
    for (let x = Math.min(ax, bx, cx); x <= Math.max(ax, bx, cx); x += 1) {
      const d1 = s(x, y, ax, ay, bx, by);
      const d2 = s(x, y, bx, by, cx, cy);
      const d3 = s(x, y, cx, cy, ax, ay);
      if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) set(x, y, color);
    }
  }
};

// Soft halo.
disc(400, 250, 230, white, 0.06);
disc(400, 250, 170, white, 0.06);
// TV: frame, screen, stand.
box(210, 110, 590, 340, 18, white);
box(226, 126, 574, 324, 8, screen);
for (let y = 126; y < 324; y += 1) {
  for (let x = 226; x < 574; x += 1) set(x, y, white, ((y - 126) / 198) * 0.18);
}
box(370, 340, 430, 372, 4, white);
box(320, 368, 480, 380, 6, white);
// Play triangle on the screen.
tri(375, 180, 375, 270, 450, 225, white);
// Set-top box under the TV, with its light.
box(270, 410, 530, 452, 12, [235, 238, 245]);
box(282, 446, 518, 452, 3, [180, 186, 200]);
disc(500, 428, 6, accent);
// Live link waves from the box.
for (const r of [28, 48, 68]) {
  arc(500, 428, r, 8, -Math.PI * 0.42, -Math.PI * 0.08, accent);
}
// Cloud dots in the corners.
for (const [x, y] of [
  [120, 120],
  [680, 120],
  [110, 430],
  [690, 430],
]) {
  disc(x, y, 14, white, 0.85);
  disc(x, y, 6, accent);
}

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
