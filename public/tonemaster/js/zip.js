// ZIP reader: reads the central directory only (cheap scan), extracts single entries on demand.
// Supports stored + deflate, ZIP64, CRC verification. Works on File/Blob via slice(), never loads the whole ZIP.
import { crc32 } from './util.js';
const u16 = (d, o) => d.getUint16(o, true), u32 = (d, o) => d.getUint32(o, true);
const big = (d, o) => Number(d.getBigUint64(o, true));
async function bytes(blob, a, b) { return new Uint8Array(await blob.slice(a, b).arrayBuffer()); }

export class ZipReader {
  constructor(blob, name = '') { this.blob = blob; this.name = name || blob.name || 'archive.zip'; this.entries = []; }
  async open() {
    const size = this.blob.size; if (size < 22) throw new Error('Not a ZIP file (too small)');
    const tailLen = Math.min(size, 65557 + 22), tail = await bytes(this.blob, size - tailLen, size), td = new DataView(tail.buffer);
    let p = -1; for (let i = tail.length - 22; i >= 0; i--) if (u32(td, i) === 0x06054b50) { p = i; break; }
    if (p < 0) throw new Error('Not a valid ZIP (end record not found)');
    let count = u16(td, p + 10), cdSize = u32(td, p + 12), cdOff = u32(td, p + 16);
    if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) {
      const loc = size - tailLen + p - 20, l = await bytes(this.blob, loc, loc + 20), ld = new DataView(l.buffer);
      if (u32(ld, 0) !== 0x07064b50) throw new Error('ZIP64 locator missing');
      const r = await bytes(this.blob, big(ld, 8), big(ld, 8) + 56), rd = new DataView(r.buffer);
      if (u32(rd, 0) !== 0x06064b50) throw new Error('ZIP64 record invalid');
      count = big(rd, 32); cdSize = big(rd, 40); cdOff = big(rd, 48);
    }
    const cd = await bytes(this.blob, cdOff, cdOff + cdSize), d = new DataView(cd.buffer); let o = 0;
    for (let i = 0; i < count; i++) {
      if (o + 46 > cd.length || u32(d, o) !== 0x02014b50) throw new Error('ZIP central directory is corrupt');
      const flags = u16(d, o + 8), method = u16(d, o + 10), crc = u32(d, o + 16);
      let csize = u32(d, o + 20), usize = u32(d, o + 24), off = u32(d, o + 42);
      const nl = u16(d, o + 28), el = u16(d, o + 30), cl = u16(d, o + 32);
      const name = new TextDecoder('utf-8').decode(cd.subarray(o + 46, o + 46 + nl)).replace(/\\/g, '/');
      let e = o + 46 + nl; const eEnd = e + el;
      while (e + 4 <= eEnd) { const id = u16(d, e), sz = u16(d, e + 2);
        if (id === 1) { let q = e + 4; if (usize === 0xFFFFFFFF) { usize = big(d, q); q += 8; } if (csize === 0xFFFFFFFF) { csize = big(d, q); q += 8; } if (off === 0xFFFFFFFF) { off = big(d, q); } }
        e += 4 + sz; }
      this.entries.push({ name, method, crc, csize, usize, offset: off, encrypted: !!(flags & 1), isDir: name.endsWith('/') });
      o += 46 + nl + el + cl;
    }
    return this.entries;
  }
  async read(entry) {
    if (entry.encrypted) throw new Error('Password-protected ZIP entries are not supported');
    const h = await bytes(this.blob, entry.offset, entry.offset + 30), hd = new DataView(h.buffer);
    if (u32(hd, 0) !== 0x04034b50) throw new Error('Corrupt local header: ' + entry.name);
    const start = entry.offset + 30 + u16(hd, 26) + u16(hd, 28), slice = this.blob.slice(start, start + entry.csize);
    let out;
    if (entry.method === 0) out = new Uint8Array(await slice.arrayBuffer());
    else if (entry.method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This WebView cannot decompress ZIP (DecompressionStream missing)');
      out = new Uint8Array(await new Response(slice.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    } else throw new Error('Unsupported ZIP compression method ' + entry.method);
    if (out.length !== entry.usize) throw new Error('Size mismatch (corrupt ZIP entry): ' + entry.name);
    if (crc32(out) !== entry.crc) throw new Error('CRC mismatch (corrupt ZIP entry): ' + entry.name);
    return out;
  }
}
