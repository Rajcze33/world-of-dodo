// World of DODO, issue #16: just enough of a TIFF reader for one band of 32-bit floats (the ImageServer's exportImage),
// strips or tiles, uncompressed, LZW or Deflate, so that the generator needs no image library.
import zlib from 'node:zlib';

function lzw(src) {
  const out = []; let dict = [], bits = 9, pos = 0, prev = null;
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push([i]); dict.push(null, null); bits = 9; };
  const read = () => {
    let v = 0;
    for (let i = 0; i < bits; i++) { const b = pos >> 3; v = (v << 1) | (b < src.length ? (src[b] >> (7 - (pos & 7))) & 1 : 0); pos++; }
    return v;
  };
  reset();
  for (;;) {
    const c = read();
    if (c === 257 || pos > src.length * 8) break;
    if (c === 256) { reset(); prev = null; continue; }
    let e;
    if (c < dict.length && dict[c]) e = dict[c];
    else if (prev) e = prev.concat(prev[0]);
    else break;
    for (const b of e) out.push(b);
    if (prev) dict.push(prev.concat(e[0]));
    prev = e;
    if (dict.length + 1 >= (1 << bits) && bits < 12) bits++;
  }
  return Buffer.from(out);
}

export function readTiff(buf) {
  const le = buf.toString('latin1', 0, 2) === 'II';
  const u16 = o => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o), u32 = o => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
  if (u16(2) !== 42) throw new Error('not a classic TIFF');
  const ifd = u32(4), n = u16(ifd), tags = {};
  const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };
  for (let i = 0; i < n; i++) {
    const o = ifd + 2 + i * 12, tag = u16(o), type = u16(o + 2), cnt = u32(o + 4), size = (SZ[type] || 1) * cnt;
    const at = size <= 4 ? o + 8 : u32(o + 8), vals = [];
    for (let k = 0; k < Math.min(cnt, 1 << 20); k++) {
      if (type === 3) vals.push(u16(at + k * 2)); else if (type === 4 || type === 16) vals.push(u32(at + k * (type === 16 ? 8 : 4)));
      else if (type === 11) vals.push(le ? buf.readFloatLE(at + k * 4) : buf.readFloatBE(at + k * 4));
      else if (type === 12) vals.push(le ? buf.readDoubleLE(at + k * 8) : buf.readDoubleBE(at + k * 8));
      else vals.push(buf[at + k]);
    }
    tags[tag] = vals;
  }
  const W = tags[256][0], H = tags[257][0], comp = (tags[259] || [1])[0], pred = (tags[317] || [1])[0];
  const bps = (tags[258] || [32])[0], fmt = (tags[339] || [3])[0], spp = (tags[277] || [1])[0];
  if (bps !== 32 || fmt !== 3 || spp !== 1) throw new Error(`TIFF: want one band of float32, got bps ${bps} fmt ${fmt} spp ${spp}`);
  const tiled = !!tags[322], tw = tiled ? tags[322][0] : W, th = tiled ? tags[323][0] : (tags[278] || [H])[0];
  const offs = tiled ? tags[324] : tags[273], cnts = tiled ? tags[325] : tags[279];
  const out = new Float32Array(W * H), across = Math.ceil(W / tw);
  offs.forEach((off, k) => {
    let raw = buf.subarray(off, off + cnts[k]);
    if (comp === 5) raw = lzw(raw); else if (comp === 8 || comp === 32946) raw = zlib.inflateSync(raw);
    else if (comp !== 1) throw new Error('TIFF compression ' + comp);
    if (pred === 3) throw new Error('TIFF floating-point predictor not supported');
    const x0 = tiled ? (k % across) * tw : 0, y0 = tiled ? Math.floor(k / across) * th : k * th;
    for (let y = 0; y < th && y0 + y < H; y++) for (let x = 0; x < tw && x0 + x < W; x++) {
      const o = (y * tw + x) * 4;
      if (o + 4 > raw.length) continue;
      out[(y0 + y) * W + x0 + x] = le ? raw.readFloatLE(o) : raw.readFloatBE(o);
    }
  });
  return { W, H, data: out, noData: tags[42113] ? parseFloat(Buffer.from(tags[42113]).toString('latin1')) : null };
}
