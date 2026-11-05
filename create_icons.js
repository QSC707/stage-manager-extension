const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPNG(width, height, drawFn) {
  const bytesPerPixel = 4;
  const rawData = Buffer.alloc(height * (1 + width * bytesPerPixel));
  
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * bytesPerPixel);
    rawData[rowOffset] = 0; // Filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const pixelOffset = rowOffset + 1 + x * bytesPerPixel;
      const [r, g, b, a] = drawFn(x, y, width, height);
      rawData[pixelOffset] = r;
      rawData[pixelOffset + 1] = g;
      rawData[pixelOffset + 2] = b;
      rawData[pixelOffset + 3] = a;
    }
  }

  const deflated = zlib.deflateSync(rawData);

  function createChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = crc32(Buffer.concat([typeBuf, data]));
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  // Header chunk (IHDR)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit depth: 8
  ihdr[9] = 6; // Color type: 6 (RGBA)
  ihdr[10] = 0; // Compression: 0
  ihdr[11] = 0; // Filter: 0
  ihdr[12] = 0; // Interlace: 0

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = createChunk('IHDR', ihdr);
  const idatChunk = createChunk('IDAT', deflated);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function drawStageManagerIcon(x, y, w, h) {
  // Normalized coords
  const nx = x / w;
  const ny = y / h;

  // Background rounded rectangle
  const pad = 0.05;
  if (nx < pad || nx > 1 - pad || ny < pad || ny > 1 - pad) {
    return [0, 0, 0, 0];
  }

  // Left strip: 3 thumbnails
  const stripLeft = 0.12;
  const stripRight = 0.34;
  const strip1 = ny >= 0.16 && ny <= 0.34;
  const strip2 = ny >= 0.41 && ny <= 0.59;
  const strip3 = ny >= 0.66 && ny <= 0.84;

  if (nx >= stripLeft && nx <= stripRight && (strip1 || strip2 || strip3)) {
    // Strip card border/fill
    return [160, 185, 220, 240];
  }

  // Main stage window (center-right)
  const mainLeft = 0.44;
  const mainRight = 0.88;
  const mainTop = 0.20;
  const mainBottom = 0.80;

  if (nx >= mainLeft && nx <= mainRight && ny >= mainTop && ny <= mainBottom) {
    // Titlebar of main window
    if (ny <= mainTop + 0.14) {
      return [255, 255, 255, 250];
    }
    // Main window body (vibrant electric blue)
    return [0, 122, 255, 245];
  }

  // Modern dark glass background
  return [26, 29, 36, 255];
}

const iconsDir = path.join(__dirname, 'icons');
[16, 48, 128].forEach(size => {
  const png = createPNG(size, size, drawStageManagerIcon);
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), png);
  console.log(`Generated icon${size}.png`);
});
