// V2 offline render + real MP3 encoding (LAME via lame.js). The same sample buffers, velocity curve, EQ, master and limiter as live play.
import { Engine } from './engine.js';
import { audibleTracks, lengthBeats, loopNativeBpm } from './seq.js';
import { yieldUI } from './util.js';

export const CEILING = 0.891;                 // −1 dBFS: exported audio never clips

/** Renders a whole project (one pass, no loop) to a stereo AudioBuffer, then peak-limits to −1 dBFS. */
export async function renderProject(p, deps, { sampleRate = 44100, tail = 2.5 } = {}) {
  const spb = 60 / p.bpm, songSec = lengthBeats(p) * spb, total = Math.ceil((songSec + tail) * sampleRate);
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext; if (!OAC) throw new Error('This browser cannot render audio offline');
  const ctx = new OAC(2, total, sampleRate), v = deps.settings;
  const bus = ctx.createGain(), low = ctx.createBiquadFilter(), high = ctx.createBiquadFilter(), pres = ctx.createBiquadFilter(), master = ctx.createGain(), comp = ctx.createDynamicsCompressor(), beatBus = ctx.createGain();
  low.type = 'lowshelf'; low.frequency.value = 170; low.gain.value = v.bass; high.type = 'highshelf'; high.frequency.value = 3200; high.gain.value = v.treble;
  pres.type = 'peaking'; pres.frequency.value = 4800; pres.Q.value = 0.8; pres.gain.value = v.bright / 100 * 10;
  bus.gain.value = v.instVol; master.gain.value = v.master * v.master; comp.threshold.value = -8; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
  bus.connect(low); low.connect(high); high.connect(pres); pres.connect(master); beatBus.connect(master); master.connect(comp); comp.connect(ctx.destination);
  const rel = v.release / 1000, sound = (n, tr) => Math.max(0, Math.min(127, n + 12 * v.octave + v.transpose + tr)); let notes = 0, loops = 0;
  for (const t of audibleTracks(p)) {
    const g = ctx.createGain(); g.gain.value = t.vol; g.connect(t.type === 'beat' ? beatBus : bus);
    if (t.type === 'inst') {
      const bank = deps.banks(t.inst); if (!bank) throw new Error('Instrument for track "' + t.name + '" is not loaded');
      for (const e of t.events) { if (e.t >= lengthBeats(p)) continue; if (Engine.scheduleVoice(ctx, bank, sound(e.n, t.tr), e.v, e.t * spb, e.d * spb, g, rel)) notes++; }
    } else {
      for (let bar = 0; bar < p.bars;) {
        const n = t.bars[bar] ?? null; let span = 1; while (bar + span < p.bars && (t.bars[bar + span] ?? null) === n) span++;
        if (n != null) { const lb = deps.beatBuffer(t.packId, t.folder, n); if (!lb) throw new Error('Beat loop ' + n + ' of "' + t.name + '" is not loaded');
          const s = ctx.createBufferSource(), sg = ctx.createGain(); s.buffer = lb.buffer; s.loop = true; s.playbackRate.value = p.bpm / loopNativeBpm(lb.buffer.duration, lb.bpm);
          const a = bar * 4 * spb, b = (bar + span) * 4 * spb; sg.gain.setValueAtTime(0, a); sg.gain.linearRampToValueAtTime(1, a + 0.004); sg.gain.setValueAtTime(1, b - 0.006); sg.gain.linearRampToValueAtTime(0, b);
          s.connect(sg); sg.connect(g); s.start(a); s.stop(b + 0.01); loops++; }
        bar += span;
      }
    }
  }
  if (!notes && !loops) throw new Error('Nothing to export: the project has no audible notes or beat loops');
  const buf = await ctx.startRendering();
  let peak = 0; for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; } }
  const gain = peak > CEILING ? CEILING / peak : 1; if (gain !== 1) for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= gain; }
  return { buffer: buf, peakBefore: peak, gain, notes, loops };
}

/** Encodes an AudioBuffer to MP3 with the LAME encoder (CBR). Returns a Blob of real MPEG audio frames. */
export async function encodeMp3(buffer, { kbps = 256, onProgress = () => { } } = {}) {
  const L = globalThis.lamejs; if (!L?.Mp3Encoder) throw new Error('MP3 encoder failed to load');
  const ch = Math.min(2, buffer.numberOfChannels), sr = buffer.sampleRate, enc = new L.Mp3Encoder(ch, sr, kbps), block = 1152 * 8, out = [];
  const conv = d => { const o = new Int16Array(d.length); for (let i = 0; i < d.length; i++) { const s = Math.max(-1, Math.min(1, d[i])); o[i] = s < 0 ? s * 32768 : s * 32767; } return o; };
  const left = conv(buffer.getChannelData(0)), right = ch > 1 ? conv(buffer.getChannelData(1)) : null;
  for (let i = 0; i < left.length; i += block) {
    const l = left.subarray(i, i + block), r = right ? right.subarray(i, i + block) : null; const m = r ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
    if (m.length) out.push(new Uint8Array(m)); if ((i / block) % 20 === 0) { onProgress(i / left.length); await yieldUI(); }
  }
  const end = enc.flush(); if (end.length) out.push(new Uint8Array(end)); onProgress(1);
  return new Blob(out, { type: 'audio/mpeg' });
}
