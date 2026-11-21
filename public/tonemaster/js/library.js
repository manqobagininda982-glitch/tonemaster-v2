// Library: instrument index, ZIP scan/preview, import, verification, recovery.
// Metadata files (logical names): instruments.json, sample_index.json, installation_status.json, zip_history.json
import { ZipReader } from './zip.js';
import { classify, KNOWN, instrumentFromName, OTHER_FOLDER, dynamicInstrument } from './detect.js';
import { parseWav } from './wav.js';
import { sha256, yieldUI } from './util.js';

export class Library {
  constructor(storage) { this.s = storage; this.inst = {}; this.index = {}; this.status = {}; this.zips = []; this.readers = []; }
  async load() {
    this.inst = await this.s.getMeta('instruments', {}); this.index = await this.s.getMeta('sample_index', {});
    this.status = await this.s.getMeta('installation_status', {}); this.zips = await this.s.getMeta('zip_history', []);
    this.recovered = null;
    // consistency check: metadata must describe exactly the instruments that have samples; otherwise rebuild from the stored samples
    const idxInst = new Set(Object.values(this.index).map(r => r.inst)), keys = Object.keys(this.inst);
    const consistent = keys.length === idxInst.size && keys.every(k => idxInst.has(k));
    if (!consistent || this.s.corrupt?.length) { const n = (await this.s.listSamples()).length; if (n) this.recovered = await this.rebuildIndex(); }
    return this;
  }
  async save() { await this.s.putMeta('instruments', this.inst); await this.s.putMeta('sample_index', this.index); await this.s.putMeta('installation_status', this.status); await this.s.putMeta('zip_history', this.zips); }
  list() { return Object.values(this.inst).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name)); }
  get(id) { return this.inst[id]; }
  samplesOf(id) { return Object.values(this.index).filter(r => r.inst === id).sort((a, b) => a.marker - b.marker); }
  playable(id) { const s = this.status[id]; return !!s && (s.state === 'installed' || s.state === 'partial'); }
  recount(id) { const rs = this.samplesOf(id); const inst = this.inst[id]; if (!inst) return; inst.count = rs.length; inst.bytes = rs.reduce((a, r) => a + r.size, 0); }

  /** Step 1: scan ZIPs (central directory only – nothing extracted). Returns a preview plan. */
  async scan(files, onProgress = () => { }, opts = {}) {
    this.readers = []; const plan = { groups: {}, ignored: 0, unsupported: [], zipErrors: [], zipDuplicates: [], totalFiles: 0 };
    for (let zi = 0; zi < files.length; zi++) {
      const f = files[zi]; onProgress({ phase: 'scan', done: zi, total: files.length, name: f.name });
      const fp = f.name + '|' + f.size + '|' + (f.lastModified || 0);
      if (this.zips.some(z => z.fp === fp)) plan.zipDuplicates.push(f.name);
      const zr = new ZipReader(f, f.name);
      try { await zr.open(); } catch (e) { plan.zipErrors.push({ zip: f.name, error: e.message }); continue; }
      this.readers[zi] = zr; zr.fp = fp;
      let cls = zr.entries.filter(e => !e.isDir).map(e => [e, classify(e.name, f.name)]);
      if (opts.forceName) {                                   // downloaded pack: instruments are named after the pack
        const ids = new Set(cls.filter(([, c]) => !c.skip).map(([, c]) => c.inst.id));
        cls = cls.map(([e, c]) => [e, c.skip ? c : { ...c, inst: dynamicInstrument(ids.size > 1 ? opts.forceName + ' ' + c.inst.name : opts.forceName), rule: 'downloaded pack' }]);
      }
      for (const [e, c] of cls) {
        plan.totalFiles++;
        if (c.skip === 'ignored') { plan.ignored++; continue; }
        if (c.skip) { plan.unsupported.push({ zip: f.name, file: e.name, reason: c.reason }); continue; }
        const g = plan.groups[c.inst.id] ||= { id: c.inst.id, name: c.inst.name, folder: c.inst.folder, known: c.inst.known, rules: new Set(), items: [] };
        g.rules.add(c.rule); g.items.push({ zi, entry: e, marker: c.marker, file: e.name.split('/').pop(), path: e.name, zip: f.name });
      }
    }
    for (const g of Object.values(plan.groups)) this.analyseGroup(g);
    return plan;
  }
  analyseGroup(g) {
    // markers: if none have numbers assign by filename order; a mix → unnumbered ones are unusable
    const withNo = g.items.filter(i => i.marker != null);
    g.unnumbered = [];
    if (!withNo.length) { g.items.sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true })).forEach((i, n) => i.marker = n + 1); g.autoNumbered = true; }
    else { g.unnumbered = g.items.filter(i => i.marker == null); g.items = withNo; }
    const seen = new Map(); g.items.sort((a, b) => a.marker - b.marker);
    g.items = g.items.filter(i => { if (seen.has(i.marker)) { g.dupMarkers = (g.dupMarkers || []).concat(i.file); return false; } seen.set(i.marker, 1); return true; });
    const ms = g.items.map(i => i.marker); g.min = ms[0]; g.max = ms[ms.length - 1];
    g.missing = []; for (let m = g.min; m <= g.max; m++) if (!seen.has(m)) g.missing.push(m);
    const ex = this.samplesOf(g.id), have = new Map(ex.map(r => [r.marker, r]));
    for (const i of g.items) { const r = have.get(i.marker); i.state = !r ? 'new' : (r.crc === i.entry.crc && r.size === i.entry.usize ? 'duplicate' : 'conflict'); }
    g.counts = { new: 0, duplicate: 0, conflict: 0 }; g.items.forEach(i => g.counts[i.state]++);
  }
  /** user renamed a detected group in the preview */
  renameGroup(plan, id, newName) {
    const g = plan.groups[id]; if (!g || !newName.trim()) return id; const ni = instrumentFromName(newName.trim());
    delete plan.groups[id]; const t = plan.groups[ni.id] ||= { id: ni.id, name: ni.name, folder: ni.folder, known: ni.known, rules: new Set(), items: [] };
    g.rules.forEach(r => t.rules.add(r)); t.items.push(...g.items.map(i => ({ ...i, marker: g.autoNumbered ? i.marker : i.marker }))); this.analyseGroup(t); return ni.id;
  }

  /** Step 2: extract → validate → encrypt+store → read back & verify → index. */
  async importPlan(plan, { replaceDifferent = false, onProgress = () => { } } = {}) {
    const report = { installed: [], partial: [], skippedDuplicate: 0, skippedConflict: 0, failed: [], replaced: 0, added: 0 };
    const jobs = Object.values(plan.groups).flatMap(g => g.items.filter(i => i.state === 'new' || (i.state === 'conflict' && replaceDifferent)).map(i => ({ g, i })));
    report.skippedDuplicate = Object.values(plan.groups).reduce((a, g) => a + g.counts.duplicate, 0);
    report.skippedConflict = replaceDifferent ? 0 : Object.values(plan.groups).reduce((a, g) => a + g.counts.conflict, 0);
    let done = 0; const failedBy = {};
    for (const { g, i } of jobs) {
      onProgress({ phase: 'import', done, total: jobs.length, name: g.name + ' · ' + i.file });
      try {
        const u8 = await this.readers[i.zi].read(i.entry);              // decompress + CRC check
        const w = parseWav(u8);                                          // WAV validation
        const hash = await sha256(u8), id = g.id + '|' + String(i.marker).padStart(3, '0') + '|' + hash.slice(0, 12);
        const old = Object.values(this.index).find(r => r.inst === g.id && r.marker === i.marker);
        if (old && old.hash === hash) { report.skippedDuplicate++; done++; continue; }
        const info = { inst: g.id, marker: i.marker, name: i.file, path: i.path, zip: i.zip, size: u8.length, crc: i.entry.crc, hash, sr: w.sampleRate, ch: w.channels, bits: w.bits, frames: w.frames, offset: w.offset };
        await this.s.putSample(id, u8, info);
        const back = await this.s.getSample(id);                          // read back, decrypt
        if (await sha256(back) !== hash) throw new Error('Verification failed after storing');
        if (old) { await this.s.deleteSample(old.id); delete this.index[old.id]; report.replaced++; } else report.added++;
        this.index[id] = { id, ...info, verified: true };
      } catch (e) { (failedBy[g.id] ||= []).push(i.file); report.failed.push({ instrument: g.name, file: i.file, error: e.message }); }
      done++; if (done % 4 === 0) await yieldUI();
    }
    for (const g of Object.values(plan.groups)) {
      const ex = this.inst[g.id] || {}; const idx = KNOWN.findIndex(k => k.id === g.id);
      this.inst[g.id] = { id: g.id, name: ex.name || g.name, folder: g.folder, known: g.known, root: ex.root ?? 36, order: idx >= 0 ? idx : 50, created: ex.created || new Date().toISOString() };
      this.recount(g.id); const n = this.inst[g.id].count, bad = (failedBy[g.id] || []).length;
      const state = n === 0 ? 'empty' : (bad || g.missing.length || g.unnumbered.length ? 'partial' : 'installed');
      this.status[g.id] = { state, verified: n - 0, failed: bad, missing: g.missing, checked: new Date().toISOString() };
      if (state === 'installed') report.installed.push(g.name); else if (state === 'partial') report.partial.push(g.name);
      if (!n) delete this.inst[g.id];
    }
    for (const zr of this.readers) if (zr) this.zips.push({ fp: zr.fp, name: zr.name, at: new Date().toISOString() });
    this.zips = this.zips.slice(-200); await this.save(); this.readers = []; onProgress({ phase: 'done', done: jobs.length, total: jobs.length }); return report;
  }

  /** Re-check every stored sample (decrypt + hash). Returns bad sample ids. */
  async verifyAll(onProgress = () => { }, ids = Object.keys(this.index)) {
    const bad = []; let n = 0;
    for (const id of ids) { try { const u = await this.s.getSample(id); if (await sha256(u) !== this.index[id].hash) throw 0; } catch { bad.push(id); } if (++n % 5 === 0) { onProgress({ done: n, total: ids.length }); await yieldUI(); } }
    for (const iid of Object.keys(this.inst)) { const b = this.samplesOf(iid).filter(r => bad.includes(r.id)).length; const st = this.status[iid] ||= {}; st.failed = b; st.state = b ? (b === this.inst[iid].count ? 'corrupt' : 'partial') : (st.missing?.length ? 'partial' : 'installed'); st.checked = new Date().toISOString(); }
    await this.save(); return bad;
  }
  async deleteInstrument(id) { for (const r of this.samplesOf(id)) { await this.s.deleteSample(r.id); delete this.index[r.id]; } delete this.inst[id]; delete this.status[id]; await this.save(); }
  async rename(id, name) { if (this.inst[id] && name.trim()) { this.inst[id].name = name.trim().toUpperCase(); await this.save(); } }
  async setRoot(id, note) { if (this.inst[id]) { this.inst[id].root = note; await this.save(); } }
  /** Recovery: rebuild metadata from the stored (encrypted) samples' info records. */
  async rebuildIndex() {
    const all = await this.s.listSamples(); this.inst = {}; this.index = {}; this.status = {}; let n = 0;
    for (const { id, info } of all) { if (!info?.inst || info.marker == null) continue; this.index[id] = { id, ...info, verified: true }; n++;
      if (!this.inst[info.inst]) { const k = KNOWN.findIndex(x => x.id === info.inst); this.inst[info.inst] = { id: info.inst, name: k >= 0 ? KNOWN[k].name : info.inst.replace(/^X_/, '').replace(/_/g, ' '), folder: k >= 0 ? KNOWN[k].folder : OTHER_FOLDER, known: k >= 0, root: 36, order: k >= 0 ? k : 50 }; } }
    for (const id of Object.keys(this.inst)) { this.recount(id); this.status[id] = { state: 'installed', verified: this.inst[id].count, failed: 0, missing: [], checked: new Date().toISOString() }; }
    await this.save(); return { samples: n, instruments: Object.keys(this.inst).length };
  }
  async totalBytes() { return Object.values(this.index).reduce((a, r) => a + r.size, 0); }
}
