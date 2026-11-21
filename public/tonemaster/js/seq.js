// V2 sequencer core: project model, quantisation and a look-ahead scheduler that drives the EXISTING engine voices.
// Times inside a project are in BEATS (quarter notes). Seconds only exist at schedule time, so BPM changes never drift.
import { clamp } from './util.js';
import { Engine } from './engine.js';

export const QUANT = { off: 0, '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/32': 0.125 };
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function newProject(name = 'Untitled project', bpm = 100) {
  return { v: 1, id: uid(), name, bpm, bars: 4, quant: '1/16', loop: true, created: Date.now(), updated: Date.now(), tracks: [] };
}
export function newInstTrack(inst, name) { return { id: uid(), type: 'inst', name: name || 'Track', inst, vol: 0.85, mute: false, solo: false, tr: 0, events: [] }; }
/** Beat track: one WAV loop per bar (null = silent bar). packId/folder refer to an INSTALLED beat pack. */
export function newBeatTrack(packId, folder, name) { return { id: uid(), type: 'beat', name: name || 'Beat', packId, folder, vol: 0.9, mute: false, solo: false, bars: [] }; }

export function quantize(t, quant) { const q = QUANT[quant] ?? 0; return q ? Math.round(t / q) * q : t; }
export const lengthBeats = p => p.bars * 4;
export function sanitizeProject(raw) {
  const p = { ...newProject(), ...(raw && typeof raw === 'object' ? raw : {}) };
  p.bpm = clamp(+p.bpm || 100, 40, 240); p.bars = clamp(Math.round(+p.bars || 4), 1, 64); if (!(p.quant in QUANT)) p.quant = '1/16'; p.loop = p.loop !== false;
  p.tracks = (Array.isArray(p.tracks) ? p.tracks : []).filter(t => t && (t.type === 'inst' || t.type === 'beat')).map(t => ({
    ...t, vol: clamp(+t.vol, 0, 1.5) || 0, mute: !!t.mute, solo: !!t.solo, tr: Math.round(clamp(+t.tr || 0, -24, 24)),
    events: t.type === 'inst' ? (t.events || []).filter(e => isFinite(e.t) && isFinite(e.n)).map(e => ({ t: Math.max(0, +e.t), d: clamp(+e.d || 0.25, 0.03, 64), n: clamp(Math.round(e.n), 0, 127), v: clamp(Math.round(e.v || 100), 1, 127) })) : undefined,
    bars: t.type === 'beat' ? (t.bars || []).map(b => (b == null ? null : clamp(Math.round(b), 1, 15))) : undefined,
  }));
  return p;
}
/** Which tracks are audible given mute/solo. */
export function audibleTracks(p) { const solo = p.tracks.some(t => t.solo); return p.tracks.filter(t => !t.mute && (!solo || t.solo)); }
/** Notes whose start falls in [from, to) beats of the song (handles loop wrap by the caller). */
export function eventsIn(track, from, to) { return track.events.filter(e => e.t >= from && e.t < to); }
/** Beat-loop length in beats from its duration and the pack's BPM. Unknown BPM: assume a whole number of bars in 70–160 BPM. */
export function loopBeats(seconds, packBpm) {
  if (packBpm > 0) { const b = seconds * packBpm / 60; return Math.max(1, Math.round(b)); }
  for (const bars of [1, 2, 4, 8, 16]) { const bpm = bars * 4 * 60 / seconds; if (bpm >= 70 && bpm <= 160) return bars * 4; }
  return 16;
}
export function loopNativeBpm(seconds, packBpm) { return packBpm > 0 ? packBpm : loopBeats(seconds, 0) * 60 / seconds; }

/**
 * Transport + look-ahead scheduler. Uses the engine's AudioContext clock (not timers) for every start time.
 * deps: { engine, banks(instId)->bank|null, beatBuffer(packId, folder, n)->{buffer,bpm}|null }
 */
export class Sequencer {
  constructor(engine, deps) {
    this.e = engine; this.deps = deps; this.p = newProject(); this.playing = false; this.recording = false; this.recTrack = null;
    this.timer = null; this.lookahead = 0.12; this.startCtx = 0; this.startBeat = 0; this.nextBeat = 0; this.trackGains = new Map(); this.liveBeat = new Map(); this.onTick = null; this.held = new Map();
    this.scheduled = new Set();
  }
  get ctx() { return this.e.ensure(); }
  load(p) { this.stop(); this.p = sanitizeProject(p); this.trackGains.forEach(g => { try { g.disconnect(); } catch { } }); this.trackGains.clear(); }
  spb() { return 60 / this.p.bpm; }
  beatAt(time) { return this.startBeat + (time - this.startCtx) / this.spb(); }
  timeAt(beat) { return this.startCtx + (beat - this.startBeat) * this.spb(); }
  /** Song position (beats) right now, wrapped when looping. */
  position() { if (!this.playing) return this.startBeat; const b = Math.max(0, this.beatAt(this.ctx.currentTime)), L = lengthBeats(this.p); return this.p.loop ? ((b % L) + L) % L : Math.min(b, L); }
  gainFor(t) {
    this.e.build(); let g = this.trackGains.get(t.id);
    if (!g) { g = this.ctx.createGain(); g.connect(t.type === 'beat' ? this.e.beatBus : this.e.bus); this.trackGains.set(t.id, g); }
    const aud = audibleTracks(this.p).includes(t); g.gain.setTargetAtTime(aud ? t.vol : 0, this.ctx.currentTime, 0.01); return g;
  }
  refreshMix() { this.p.tracks.forEach(t => this.gainFor(t)); }
  setBpm(bpm) {
    bpm = clamp(Math.round(bpm), 40, 240); if (this.playing) { const now = this.ctx.currentTime, b = this.beatAt(now); this.startBeat = b; this.startCtx = now; this.p.bpm = bpm; this.restartBeats(b, now); } else this.p.bpm = bpm;
  }
  play(fromBeat = null) {
    if (this.playing) return; const ctx = this.ctx; this.e.build(); this.refreshMix();
    this.startBeat = fromBeat ?? (this.startBeat >= lengthBeats(this.p) ? 0 : this.startBeat); this.startCtx = ctx.currentTime + 0.05; this.nextBeat = this.startBeat; this.playing = true;
    this.resumeBeatPhase(this.startBeat);
    this.timer = setInterval(() => this.pump(), 25); this.pump();
  }
  pause() { if (!this.playing) return; this.startBeat = this.position(); this.halt(); }
  stop() { if (this.playing) this.halt(); this.startBeat = 0; this.onTick?.(0); }
  halt() {
    this.playing = false; clearInterval(this.timer); this.timer = null; const t = this.ctx.currentTime;
    for (const v of this.scheduled) { try { v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(0, t, 0.01); v.src.stop(t + 0.06); } catch { } } this.scheduled.clear();
    this.stopBeats(t); this.finishRecording();
  }
  /** Schedules everything that starts within the look-ahead window. Called every 25 ms. */
  pump() {
    if (!this.playing) return; const ctx = this.ctx, until = this.beatAt(ctx.currentTime + this.lookahead), L = lengthBeats(this.p);
    if (!this.p.loop && this.nextBeat >= L) { if (ctx.currentTime > this.timeAt(L) + 0.2) { this.pause(); this.startBeat = 0; this.onTick?.(0, true); } return; }
    while (this.nextBeat < until) {
      const step = Math.min(until, Math.floor(this.nextBeat) + 1) - this.nextBeat; const from = this.nextBeat, to = from + step;
      const sf = this.p.loop ? ((from % L) + L) % L : from, base = from - sf; const st = sf + step;
      if (this.p.loop || from < L) this.scheduleSpan(sf, Math.min(st, L), base);
      if (this.p.loop && st > L) this.scheduleSpan(0, st - L, base + L);
      this.nextBeat = to;
    }
    // prune finished voices
    const now = ctx.currentTime; for (const v of this.scheduled) if (v.off + 1 < now) this.scheduled.delete(v);
    this.onTick?.(this.position());
  }
  scheduleSpan(from, to, base) {
    const aud = new Set(audibleTracks(this.p)), rel = this.e.set.v.release / 1000;
    for (const t of this.p.tracks) {
      if (t.type === 'inst') {
        const bank = this.deps.banks(t.inst); if (!bank) continue; const dest = this.gainFor(t);
        for (const ev of eventsIn(t, from, to)) {
          const when = Math.max(this.ctx.currentTime, this.timeAt(base + ev.t)), dur = ev.d * this.spb();
          const v = Engine.scheduleVoice(this.ctx, bank, this.e.soundingFor(ev.n, t.tr), ev.v, when, dur, dest, rel); if (v) this.scheduled.add(v);
        }
      } else if (t.type === 'beat') {
        for (let bar = Math.ceil(from / 4 - 1e-9) * 4; bar < to; bar += 4) this.scheduleBeatBar(t, bar / 4, base + bar);
      }
    }
    void aud;
  }
  /** Starts the bar's loop exactly on the bar line, phase-continuous when the same loop continues (no restart click). */
  scheduleBeatBar(t, barIdx, songBeat, phaseBeats = 0) {
    const n = t.bars[barIdx] ?? null, prev = this.liveBeat.get(t.id), when = this.timeAt(songBeat);
    if (prev && prev.n === n && n != null && prev.until > songBeat) return;              // same loop still covering this bar
    if (prev) { this.fadeOut(prev.voice, when); this.liveBeat.delete(t.id); }
    if (n == null) return; const lb = this.deps.beatBuffer(t.packId, t.folder, n); if (!lb) return;
    const beats = loopBeats(lb.buffer.duration, lb.bpm), rate = this.p.bpm / loopNativeBpm(lb.buffer.duration, lb.bpm);
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain(); src.buffer = lb.buffer; src.loop = true; src.playbackRate.value = rate;
    g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(1, when + 0.004); src.connect(g); g.connect(this.gainFor(t));
    src.start(Math.max(this.ctx.currentTime, when), (phaseBeats * 60 / loopNativeBpm(lb.buffer.duration, lb.bpm)) % lb.buffer.duration); const voice = { src, g, when, off: Infinity };
    // keep covering following bars that use the same loop number
    let span = 1; while (t.bars[barIdx + span] === n && barIdx + span < this.p.bars) span++;
    this.liveBeat.set(t.id, { n, voice, until: songBeat - (songBeat % 4) + Math.max(span * 4, 4), beats });
    this.scheduled.add(voice);
  }
  fadeOut(v, when) { try { v.g.gain.setValueAtTime(1, when); v.g.gain.linearRampToValueAtTime(0, when + 0.006); v.src.stop(when + 0.02); v.off = when; } catch { } }
  stopBeats(t) { for (const b of this.liveBeat.values()) this.fadeOut(b.voice, t); this.liveBeat.clear(); }
  restartBeats(beat, now) { this.stopBeats(now); this.nextBeat = beat; for (const v of this.scheduled) if (v.when > now) { try { v.src.stop(now); } catch { } this.scheduled.delete(v); } this.resumeBeatPhase(beat); }
  resumeBeatPhase(beat) {
    const position = ((beat % lengthBeats(this.p)) + lengthBeats(this.p)) % lengthBeats(this.p), bar = Math.floor(position / 4);
    for (const track of this.p.tracks.filter(t => t.type === 'beat')) {
      const n = track.bars[bar]; if (n == null) continue; let first = bar;
      while (first > 0 && track.bars[first - 1] === n) first--;
      this.scheduleBeatBar(track, bar, beat, position - first * 4);
    }
  }

  /* ---- note recording (from MIDI / on-screen keys). route(note) -> track ids, so Dual/Split layers land on separate tracks ---- */
  startRecording(route) { this.route = route; this.recording = true; this.held.clear(); if (!this.playing) this.play(); }
  noteOn(n, v, src = 'ui', ch = 0) { if (!this.recording || !this.playing) return; const pos = this.position(); for (const id of this.route(n)) { const key = id + ':' + src + ':' + ch + ':' + n; const old = this.held.get(key); if (old) this.commit(old); this.held.set(key, { id, n, t: pos, v, src, ch }); } }
  noteOff(n, src = 'ui', ch = 0) { if (!this.recording) return; for (const [k, h] of [...this.held]) if (h.n === n && h.src === src && h.ch === ch) { this.held.delete(k); this.commit(h); } }
  commit(h) {
    const t = this.p.tracks.find(x => x.id === h.id); if (!t || t.type !== 'inst') return; const L = lengthBeats(this.p);
    let end = this.position(); if (end < h.t) end += L; const st = quantize(h.t, this.p.quant); if (st >= L) return;
    t.events.push({ t: st, d: Math.max(QUANT[this.p.quant] || 0.0625, end - h.t), n: h.n, v: h.v }); this.p.updated = Date.now();
  }
  finishRecording() { if (!this.recording) return; for (const h of [...this.held.values()]) this.commit(h); this.held.clear(); this.recording = false; this.onRecordEnd?.(); }
}
