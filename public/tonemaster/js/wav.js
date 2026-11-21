// WAV parser. Original bytes are never modified; this only validates and decodes to Float32 for playback.
export function parseWav(u8, { decode = true } = {}) {
  if (u8.length < 44) throw new Error('File too small to be WAV');
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');
  let fmt = null, dataOff = -1, dataLen = 0, o = 12;
  while (o + 8 <= u8.length) {
    const id = tag(o); let sz = d.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { tag: d.getUint16(o + 8, true), ch: d.getUint16(o + 10, true), sr: d.getUint32(o + 12, true), bits: d.getUint16(o + 22, true), sub: sz >= 26 ? d.getUint16(o + 32, true) : 0 };
    else if (id === 'data') { dataOff = o + 8; if (dataOff + sz > u8.length) sz = u8.length - dataOff; dataLen = sz; break; }
    o += 8 + sz + (sz & 1);
  }
  if (!fmt) throw new Error('WAV has no fmt chunk'); if (dataOff < 0) throw new Error('WAV has no data chunk');
  const type = fmt.tag === 0xFFFE ? fmt.sub : fmt.tag, float = type === 3;
  if (type !== 1 && type !== 3) throw new Error('Unsupported WAV encoding (' + fmt.tag + ')');
  if (![8, 16, 24, 32, 64].includes(fmt.bits) || (float && fmt.bits !== 32 && fmt.bits !== 64)) throw new Error('Unsupported bit depth ' + fmt.bits);
  if (fmt.ch < 1 || fmt.ch > 2) throw new Error('Only mono/stereo WAV supported (' + fmt.ch + ' ch)');
  if (fmt.sr < 8000 || fmt.sr > 192000) throw new Error('Unsupported sample rate ' + fmt.sr);
  const bps = fmt.bits / 8, frames = Math.floor(dataLen / (bps * fmt.ch));
  if (frames < 16) throw new Error('WAV contains no audio');
  const info = { sampleRate: fmt.sr, channels: fmt.ch, bits: fmt.bits, frames };
  if (!decode) return info;
  const data = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) for (let c = 0; c < fmt.ch; c++) {
    const p = dataOff + (f * fmt.ch + c) * bps; let v;
    if (float) v = fmt.bits === 32 ? d.getFloat32(p, true) : d.getFloat64(p, true);
    else if (fmt.bits === 16) v = d.getInt16(p, true) / 32768;
    else if (fmt.bits === 8) v = (u8[p] - 128) / 128;
    else if (fmt.bits === 24) { let x = u8[p] | u8[p + 1] << 8 | u8[p + 2] << 16; if (x & 0x800000) x |= ~0xFFFFFF; v = x / 8388608; }
    else v = d.getInt32(p, true) / 2147483648;
    data[c][f] = v;
  }
  // leading-silence offset (seconds) so notes start instantly (threshold -60 dB, max 0.4 s)
  const lim = Math.min(frames, Math.floor(fmt.sr * 0.4)); let s = 0; while (s < lim && Math.abs(data[0][s]) < 0.001) s++;
  info.offset = Math.max(0, s - Math.floor(fmt.sr * 0.002)) / fmt.sr;
  return { ...info, data };
}
