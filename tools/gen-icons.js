// Generates the extension and PWA icons (16/48/128/192/512 px PNGs) with no dependencies:
// a solid indigo square with three light bars — one per queue.
// Run: node tools/gen-icons.js   (or: npm run icons)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extOutDir = path.join(root, 'extension', 'icons');
const pwaOutDir = path.join(root, 'pwa', 'icons');
fs.mkdirSync(extOutDir, { recursive: true });
fs.mkdirSync(pwaOutDir, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(n, pixel) {
  const rows = [];
  for (let y = 0; y < n; y++) {
    const row = Buffer.alloc(1 + n * 3); // filter byte 0 + RGB triplets
    for (let x = 0; x < n; x++) {
      const [r, g, b] = pixel(x, y);
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [79, 70, 229];
const FG = [226, 232, 255];
const BARS = [
  [0.14, 0.28],
  [0.43, 0.57],
  [0.72, 0.86],
];

function pixel(x, y, n) {
  const fx = x / n;
  const fy = y / n;
  const inBar = BARS.some(([a, b]) => fy >= a && fy < b) && fx >= 0.2 && fx <= 0.8;
  return inBar ? FG : BG;
}

for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(extOutDir, `icon${size}.png`), png(size, (x, y) => pixel(x, y, size)));
  console.log(`wrote extension/icons/icon${size}.png`);
}

for (const size of [192, 512]) {
  fs.writeFileSync(path.join(pwaOutDir, `icon-${size}.png`), png(size, (x, y) => pixel(x, y, size)));
  console.log(`wrote pwa/icons/icon-${size}.png`);
}
