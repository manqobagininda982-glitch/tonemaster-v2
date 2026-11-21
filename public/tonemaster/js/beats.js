// V2 beat packs: install published packs (validated on the server), keep loops ENCRYPTED on the phone with the same storage
// layer as tones, decode on demand, and play them as gap-free loops through the engine's beat bus.
import { ZipReader } from './zip.js';
import { parseWav } from './wav.js';
import { clamp } from './util.js';
import { loopBeats, loopNativeBpm } from './seq.js';

const KEY = 'beats_installed';
const sid = (packId, fi, n) => 'beat:' + packId + ':' + fi + ':' + n;

export class BeatLibrary {
  constructor(storage, getCtx) { this.s = storage; this.getCtx = getCtx; this.packs = {}; this.buffers = new Map(); this.loading = new Map(); }
  async load() { this.packs = (await this.s.getMeta(KEY, {})) || {}; return this; }
  list() { return Object.values(this.packs).sort((a, b) => a.name.localeCompare(b.name)); }
  get(id) { return this.packs[id] || null; }
  folders(id) { return this.packs[id]?.folders || []; }
  /** Which of loops 1–15 really exist in this folder (only these get enabled in the grid). */
  available(id, folder) { const f = this.folders(id).find(x => x.name === folder); return new Set(f ? f.loops.map(l => l.n) : []); }
  /** Installs a downloaded clean ZIP. Re-validates every WAV on the phone before anything is stored. */
  async install(meta, blob, onProgress = () => { }) {
    const zr = new ZipReader(blob, meta.name + '.zip'); await zr.open(); const byFolder = new Map(); const entries = zr.entries.filter(e => !e.isDir && /\.wav$/i.test(e.name));
    if (!entries.length) throw new Error('This pack contains no loops');
    let done = 0; const stored = [], generation = crypto.randomUUID();
    try {
      for (const e of entries) {
        const parts = e.name.split('/'), base = parts.pop(), folder = parts.join('/') || 'Loops', n = parseInt(base, 10);
        if (!(n >= 1 && n <= 15)) continue; const u8 = await zr.read(e); const info = parseWav(u8, { decode: false });
        if (!byFolder.has(folder)) byFolder.set(folder, []); const fi = [...byFolder.keys()].indexOf(folder);
        const id = sid(meta.id, fi, n) + ':' + generation; await this.s.putSample(id, u8, { pack: meta.id, folder, n }); stored.push(id);
        byFolder.get(folder).push({ n, id, seconds: info.frames / info.sampleRate, sampleRate: info.sampleRate });
        onProgress(++done, entries.length);
      }
    } catch (err) { for (const id of stored) await this.s.deleteSample(id).catch(() => { }); throw err; }
    if (!stored.length) throw new Error('This pack contains no numbered loops 1–15');
    const old = this.packs[meta.id];
    [...this.buffers.keys()].filter(k => k.startsWith(meta.id + '|')).forEach(k => this.buffers.delete(k));
    this.packs[meta.id] = { id: meta.id, name: meta.name, version: String(meta.version), bpm: meta.bpm || null, at: new Date().toISOString(),
      folders: [...byFolder.entries()].map(([name, loops]) => ({ name, loops: loops.sort((a, b) => a.n - b.n) })) };
    try { await this.s.putMeta(KEY, this.packs); } catch (e) { if (old) this.packs[meta.id] = old; else delete this.packs[meta.id]; for (const id of stored) await this.s.deleteSample(id).catch(() => { }); throw e; }
    if (old) for (const f of old.folders) for (const l of f.loops) await this.s.deleteSample(l.id).catch(() => { });
    return this.packs[meta.id];
  }
  async remove(id) {
    const p = this.packs[id]; if (!p) return; for (const f of p.folders) for (const l of f.loops) await this.s.deleteSample(l.id).catch(() => { });
    delete this.packs[id]; [...this.buffers.keys()].filter(k => k.startsWith(id + '|')).forEach(k => this.buffers.delete(k)); await this.s.putMeta(KEY, this.packs);
  }
  /** Synchronous lookup used by the scheduler – returns only already-decoded loops. */
  cached(packId, folder, n) { return this.buffers.get(packId + '|' + folder + '|' + n) || null; }
  /** Decrypt + decode one loop (cached). */
  async buffer(packId, folder, n) {
    const k = packId + '|' + folder + '|' + n; if (this.buffers.has(k)) return this.buffers.get(k); if (this.loading.has(k)) return this.loading.get(k);
    const pr = (async () => {
      const p = this.packs[packId], f = p?.folders.find(x => x.name === folder), l = f?.loops.find(x => x.n === n); if (!l) throw new Error('Loop ' + n + ' is not in this folder');
      let u8 = await this.s.getSample(l.id); const w = parseWav(u8); u8 = null; const ctx = this.getCtx();
      const buf = ctx.createBuffer(w.channels, w.frames, w.sampleRate); w.data.forEach((ch, c) => buf.copyToChannel(ch, c));
      const r = { buffer: buf, bpm: p.bpm || 0 }; this.buffers.set(k, r); return r;
    })().finally(() => this.loading.delete(k));
    this.loading.set(k, pr); return pr;
  }
  /** Preload every loop of a folder so switching never waits on decoding. */
  async preloadFolder(packId, folder, onProgress = () => { }) { const ns = [...this.available(packId, folder)]; let d = 0; for (const n of ns) { await this.buffer(packId, folder, n).catch(() => { }); onProgress(++d, ns.length); } }
  trim(keepPack) { for (const k of [...this.buffers.keys()]) if (!k.startsWith(keepPack + '|')) this.buffers.delete(k); }
}

/** Live beat player: immediate start/stop, phase-continuous switching between loops, adjustable tempo. */
export class BeatPlayer {
  constructor(engine, beats) { this.e = engine; this.b = beats; this.cur = null; this.tempo = 0; this.onChange = null; this.request = 0; }
  get playing() { return !!this.cur; }
  rateFor(lb) { const nat = loopNativeBpm(lb.buffer.duration, lb.bpm); return this.tempo ? this.tempo / nat : 1; }
  nativeBpm(lb) { return Math.round(loopNativeBpm(lb.buffer.duration, lb.bpm) * 10) / 10; }
  async play(packId, folder, n) {
    const request = ++this.request, ctx = this.e.ensure(); this.e.build(); const lb = await this.b.buffer(packId, folder, n); if (request !== this.request) return null; const now = ctx.currentTime;
    if (!this.tempo) this.tempo = Math.round(loopNativeBpm(lb.buffer.duration, lb.bpm));
    const rate = this.rateFor(lb); let offset = 0;
    if (this.cur) {                                                         // keep the groove's phase: continue from the same beat position
      const c = this.cur, beatsOld = loopBeats(c.lb.buffer.duration, c.lb.bpm), posBeats = (((now - c.t0) * c.rate / c.lb.buffer.duration) * beatsOld) % beatsOld;
      const beatsNew = loopBeats(lb.buffer.duration, lb.bpm); offset = ((posBeats % beatsNew) / beatsNew) * lb.buffer.duration;
      this.fade(c, now);
    }
    const src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = lb.buffer; src.loop = true; src.playbackRate.value = rate;
    g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(1, now + 0.008); src.connect(g); g.connect(this.e.beatBus); src.start(now, offset);
    this.cur = { packId, folder, n, lb, src, g, rate, t0: now - offset / rate }; this.media(); this.onChange?.(); return this.cur;
  }
  fade(c, now) { try { c.g.gain.cancelScheduledValues(now); c.g.gain.setValueAtTime(c.g.gain.value, now); c.g.gain.linearRampToValueAtTime(0, now + 0.008); c.src.stop(now + 0.03); } catch { } }
  stop() { this.request++; if (!this.cur) return; this.fade(this.cur, this.e.ensure().currentTime); this.cur = null; this.onChange?.(); if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'; }
  setTempo(bpm) {
    this.tempo = clamp(Math.round(bpm), 40, 240); const c = this.cur; if (!c) { this.onChange?.(); return; }
    const now = this.e.ensure().currentTime, pos = (now - c.t0) * c.rate, rate = this.rateFor(c.lb);
    c.src.playbackRate.setValueAtTime(rate, now); c.rate = rate; c.t0 = now - pos / rate; this.onChange?.();
  }
  setVolume(v) { this.e.build(); this.e.beatBus.gain.setTargetAtTime(clamp(v, 0, 1.5), this.e.ensure().currentTime, 0.01); }
  media() {
    const ms = navigator.mediaSession; if (!ms || !this.cur) return; const p = this.b.get(this.cur.packId);
    try { ms.metadata = new MediaMetadata({ title: (p?.name || 'Beat') + ' · ' + this.cur.folder + ' · Loop ' + this.cur.n, artist: 'ToneMaster by MG:SOUNDS' }); ms.playbackState = 'playing';
      ms.setActionHandler('pause', () => this.stop()); ms.setActionHandler('stop', () => this.stop()); } catch { }
  }
}
