import zlib from 'node:zlib';

/** Builds a small, valid PNG filled with a solid colour (used for demo data and tests, never for real captures). */
export function syntheticPng(width = 64, height = 48, rgb: [number, number, number] = [30, 60, 120]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const stride = width * 3 + 1;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = y * stride + 1 + x * 3;
    // simple gradient bands so thumbnails look like something
    const shade = (y * 255) / height / 4;
    rows[o] = Math.min(255, rgb[0] + shade); rows[o + 1] = Math.min(255, rgb[1] + shade); rows[o + 2] = Math.min(255, rgb[2] + shade);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
