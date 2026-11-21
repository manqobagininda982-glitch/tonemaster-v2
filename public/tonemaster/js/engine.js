// Audio engine: sample playback, layers, velocity, sustain, voice management.
// Graph: voice → voiceGain → layerGain[i] → instBus → bass → treble → presence → master → compressor → output
import { clamp } from './util.js';
const MAX_VOICES = 56, velCurve = v => Math.pow(clamp(v, 1, 127) / 127, 1.35);

export class Engine {
  constructor(samples, settings, { ctx = null, gate = () => true } = {}) {
    this.samples = samples; this.set = settings; this.ctx = ctx; this.gate = gate;
    this.held = new Map(); this.voices = new Set(); this.sustained = new Set(); this.onActivity = null;
    samples.getCtx = () => this.ensure();
  }
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume().catch(() => { }); return this.ctx; }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext; if (!AC) throw new Error('Web Audio is not available');
    this.ctx = new AC({ latencyHint: 'interactive' }); this.build(); this.ctx.resume?.().catch(() => { }); return this.ctx;
  }
  build() {
    if (!this.ctx) { this.ensure(); return; } const c = this.ctx; if (this.master) return;
    this.layerGain = [0, 1, 2].map(() => { const g = c.createGain(); return g; }); this.bus = c.createGain();
    this.low = c.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 170;
    this.high = c.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 3200;
    this.pres = c.createBiquadFilter(); this.pres.type = 'peaking'; this.pres.frequency.value = 4800; this.pres.Q.value = 0.8;
    this.master = c.createGain(); this.comp = c.createDynamicsCompressor();
    Object.assign(this.comp.threshold, { value: -8 }); this.comp.knee.value = 12; this.comp.ratio.value = 4; this.comp.attack.value = 0.003; this.comp.release.value = 0.2;
    this.beatBus = c.createGain(); this.beatBus.connect(this.master);                      // V2: beat loops (post-EQ, pre-limiter)
    this.layerGain.forEach(g => g.connect(this.bus)); this.bus.connect(this.low); this.low.connect(this.high); this.high.connect(this.pres); this.pres.connect(this.master); this.master.connect(this.comp); this.comp.connect(c.destination);
    this.applySettings();
  }
  applySettings() {
    if (!this.master) { if (this.ctx) this.build(); else return; } const v = this.set.v, t = this.ctx.currentTime, k = 0.015;
    this.master.gain.setTargetAtTime(v.master * v.master, t, k); this.bus.gain.setTargetAtTime(v.instVol, t, k);
    this.low.gain.setTargetAtTime(v.bass, t, k); this.high.gain.setTargetAtTime(v.treble, t, k); this.pres.gain.setTargetAtTime(v.bright / 100 * 10, t, k);
    this.layerGain.forEach((g, i) => g.gain.setTargetAtTime(v.layers[i].on ? v.layers[i].vol : 0, t, k));
  }
  layersFor(note) {
    const v = this.set.v, L = v.layers, ok = i => L[i].on && L[i].inst; let idx;
    switch (v.mode) { case 'dual': idx = [0, 1]; break; case 'split': idx = [note < v.split ? 0 : 1]; break; case 'mainDual': idx = [0, 1, 2]; break; case 'mainSplit': idx = note < v.split ? [0, 1] : [0, 2]; break; default: idx = [0]; }
    return idx.filter(ok);
  }
  pinActive() { this.samples.pin(this.set.v.layers.filter(l => l.on).map(l => l.inst)); }

  noteOn(note, vel = 100, src = 'ui', ch = 0) {
    if (!this.gate() || !(note >= 0 && note <= 127)) return false;
    const ctx = this.ensure(); this.build(); const key = src + ':' + ch + ':' + note;
    if (this.held.has(key)) this.releaseRec(this.held.get(key), 0.02);
    const v = this.set.v, lay = this.layersFor(note), norm = 1 / Math.sqrt(Math.max(1, lay.length)), t = ctx.currentTime, rec = { key, note, src, ch, down: true, sustained: false, voices: [], live: 0 };
    for (const i of lay) {
      const L = v.layers[i], bank = this.samples.bank(L.inst); if (!bank || !bank.samples.length) continue;
      const sounding = clamp(note + 12 * v.octave + v.transpose + 12 * L.oct + L.tr, 0, 127), s = bank.map[sounding]; if (!s) continue;
      const src_ = ctx.createBufferSource(), g = ctx.createGain(); src_.buffer = s.buffer; src_.playbackRate.value = Math.pow(2, (sounding - s.note) / 12);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(velCurve(vel) * norm, t + 0.003);
      src_.connect(g); g.connect(this.layerGain[i]);
      const voice = { src: src_, g, rec, t0: t }; rec.voices.push(voice); rec.live++; this.voices.add(voice);
      src_.onended = () => { try { src_.disconnect(); g.disconnect(); } catch { } this.voices.delete(voice); if (--rec.live <= 0 && !rec.down && !rec.sustained && this.held.get(rec.key) === rec) this.held.delete(rec.key); this.onActivity?.(this.voices.size); };
      src_.start(t, s.offset || 0);
    }
    if (!rec.voices.length) return false;
    this.held.set(key, rec); const live = [...this.voices].filter(v => !v.dead).sort((a, b) => a.t0 - b.t0); while (live.length > MAX_VOICES) this.killVoice(live.shift(), 0.015);   // steal oldest
    this.onActivity?.(this.voices.size); this.onNoteOn?.(note, vel, src, ch); return true;
  }
  noteOff(note, src = 'ui', ch = 0) {
    const rec = this.held.get(src + ':' + ch + ':' + note); if (!rec) return; rec.down = false;
    if (this.sustained.has(src + ':' + ch) && this.set.v.sustainEnabled) rec.sustained = true; else this.releaseRec(rec);
  }
  sustain(down, src = 'ui', ch = 0) {
    if (!this.set.v.sustainEnabled && down) return; const k = src + ':' + ch;
    if (down) { this.sustained.add(k); return; } this.sustained.delete(k);
    for (const rec of [...this.held.values()]) if (rec.src === src && rec.ch === ch && rec.sustained && !rec.down) { rec.sustained = false; this.releaseRec(rec); }
  }
  releaseRec(rec, time) { if (!rec.recordReleased) { rec.recordReleased = true; this.onNoteOff?.(rec.note, rec.src, rec.ch); } const rel = time ?? this.set.v.release / 1000; rec.down = false; rec.sustained = false; for (const v of rec.voices) this.killVoice(v, rel); if (this.held.get(rec.key) === rec && !rec.live) this.held.delete(rec.key); }
  killVoice(v, rel) {
    v.dead = true; const t = this.ctx.currentTime, g = v.g.gain;
    try { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.setTargetAtTime(0, t, Math.max(0.004, rel / 4)); v.src.stop(t + rel * 1.6 + 0.03); } catch { }
  }
  /** Release every note (optionally only one MIDI source). Used for disconnects, panic, blur, instrument errors. */
  allNotesOff(src = null) {
    if (!this.ctx) return; for (const rec of [...this.held.values()]) if (!src || rec.src === src) { this.onNoteOff?.(rec.note, rec.src, rec.ch); this.releaseRec(rec, 0.04); }
    for (const k of [...this.sustained]) if (!src || k.startsWith(src + ':')) this.sustained.delete(k);
    if (!src) this.held.clear();
  }
  /** V2: a sequenced note with an exact start time and length, through the SAME sample map / velocity curve / release as live play.
   *  Works in any AudioContext (live or OfflineAudioContext) – AudioBuffers are context-independent. Returns the voice or null. */
  static scheduleVoice(ctx, bank, sounding, vel, when, dur, dest, release = 0.12) {
    if (!bank || !bank.map) return null; sounding = clamp(Math.round(sounding), 0, 127); const s = bank.map[sounding]; if (!s) return null;
    const src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = s.buffer; src.playbackRate.value = Math.pow(2, (sounding - s.note) / 12);
    const peak = velCurve(vel), off = when + Math.max(0.01, dur), rel = Math.max(0.01, release);
    g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(peak, when + 0.003); g.gain.setValueAtTime(peak, off); g.gain.setTargetAtTime(0, off, Math.max(0.004, rel / 4));
    src.connect(g); g.connect(dest); src.start(when, s.offset || 0); src.stop(off + rel * 1.6 + 0.03);
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { } };
    return { src, g, when, off };
  }
  /** Sounding pitch for a sequenced/recorded note: raw played note + global octave/transpose + track transpose (source files never change). */
  soundingFor(note, trackTr = 0) { const v = this.set.v; return clamp(note + 12 * v.octave + v.transpose + trackTr, 0, 127); }
  get activeVoices() { return this.voices.size; }
  get liveVoices() { let n = 0; for (const v of this.voices) if (!v.dead) n++; return n; }
}
