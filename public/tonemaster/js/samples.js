// SampleManager: decrypt-on-demand, memory-budgeted LRU cache of decoded AudioBuffers per instrument.
// Decrypted WAV bytes are dropped immediately after decoding; only the AudioBuffer is cached.
import { parseWav } from './wav.js';
export class SampleManager {
  constructor(library, getCtx, budgetMB = 0) {
    this.lib = library; this.getCtx = getCtx; this.banks = new Map(); this.pins = new Set(); this.loading = new Map();
    const dm = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 4; this.budget = (budgetMB || Math.min(320, Math.max(96, dm * 56))) * 1048576;
  }
  setBudget(mb) { if (mb) this.budget = mb * 1048576; this.trim(); }
  get usedBytes() { let n = 0; for (const b of this.banks.values()) n += b.bytes; return n; }
  isReady(id) { const b = this.banks.get(id); return !!b && b.complete; }
  bank(id) { const b = this.banks.get(id); if (b) { b.last = performance.now(); b.uses++; } return b; }
  pin(ids) { this.pins = new Set(ids.filter(Boolean)); this.trim(); }
  /** Loads (or returns cached) bank. onProgress(done,total). Notes can already play from partially loaded banks. */
  load(id, onProgress = () => { }) {
    if (this.isReady(id)) { this.bank(id); return Promise.resolve(this.banks.get(id)); }
    if (this.loading.has(id)) return this.loading.get(id);
    const p = this._load(id, onProgress).finally(() => this.loading.delete(id)); this.loading.set(id, p); return p;
  }
  async _load(id, onProgress) {
    const recs = this.lib.samplesOf(id); if (!recs.length) throw new Error('Instrument has no samples');
    const ctx = this.getCtx(), bank = this.banks.get(id) || { id, samples: [], map: new Array(128).fill(null), bytes: 0, last: performance.now(), uses: 0, complete: false, failed: 0 };
    this.banks.set(id, bank); const root = this.lib.get(id)?.root ?? 36; let done = bank.samples.length;
    const todo = recs.filter(r => !bank.samples.some(s => s.id === r.id));
    for (let i = 0; i < todo.length; i += 3) {
      await Promise.all(todo.slice(i, i + 3).map(async r => {
        try {
          let u8 = await this.lib.s.getSample(r.id); const w = parseWav(u8); u8 = null;          // plaintext dropped right after decoding
          const buf = ctx.createBuffer(w.channels, w.frames, w.sampleRate); w.data.forEach((ch, c) => buf.copyToChannel(ch, c));
          bank.samples.push({ id: r.id, note: root + r.marker - 1, buffer: buf, offset: r.offset || 0 }); bank.bytes += w.frames * w.channels * 4;
        } catch (e) { bank.failed++; console.warn('sample load failed', r.name, e.message); }
        onProgress(++done, recs.length);
      }));
      this.rebuild(bank); this.trim(id);
    }
    bank.complete = true; bank.last = performance.now(); return bank;
  }
  rebuild(bank) {                                                // nearest-sample lookup for every MIDI note
    const s = bank.samples.slice().sort((a, b) => a.note - b.note); if (!s.length) return;
    for (let n = 0; n < 128; n++) { let best = s[0], d = Math.abs(best.note - n); for (const x of s) { const dd = Math.abs(x.note - n); if (dd < d) { best = x; d = dd; } } bank.map[n] = best; }
  }
  trim(keep) {                                                   // evict least-recently-used unpinned banks while over budget
    while (this.usedBytes > this.budget) {
      const c = [...this.banks.values()].filter(b => !this.pins.has(b.id) && b.id !== keep && !this.loading.has(b.id)).sort((a, b) => a.last - b.last)[0];
      if (!c) break; this.banks.delete(c.id);
    }
  }
  evict(id) { this.banks.delete(id); }
  releaseUnused() { for (const id of [...this.banks.keys()]) if (!this.pins.has(id)) this.banks.delete(id); }
  clear() { this.banks.clear(); }
}
