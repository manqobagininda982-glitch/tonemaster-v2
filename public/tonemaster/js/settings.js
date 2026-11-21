// Persistent settings with validation (corrupt/missing values fall back to defaults) and debounced saving.
import { clamp } from './util.js';
export const MODES = ['single', 'dual', 'split', 'mainDual', 'mainSplit'];
const layer = on => ({ inst: null, on, vol: 0.85, oct: 0, tr: 0 });
export const DEFAULTS = () => ({
  v: 1, mode: 'single', layers: [layer(true), layer(false), layer(false)], split: 60,
  master: 0.8, instVol: 0.9, bass: 0, treble: 0, bright: 0, transpose: 0, octave: 0, release: 120,
  sustainEnabled: true, midi: { device: 'all', channel: 0 }, cacheMB: 0, kbVisible: true, kbBase: 48, tab: 'play', focusLayer: 0,
});
const num = (v, a, b, d) => (typeof v === 'number' && isFinite(v)) ? clamp(v, a, b) : d;
export function sanitize(raw) {
  const d = DEFAULTS(); if (!raw || typeof raw !== 'object') return d;
  const o = { ...d, v: 1 };
  o.mode = MODES.includes(raw.mode) ? raw.mode : d.mode;
  o.layers = d.layers.map((dl, i) => { const r = raw.layers?.[i] || {}; return { inst: typeof r.inst === 'string' ? r.inst : null, on: typeof r.on === 'boolean' ? r.on : dl.on, vol: num(r.vol, 0, 1, dl.vol), oct: Math.round(num(r.oct, -3, 3, 0)), tr: Math.round(num(r.tr, -12, 12, 0)) }; });
  o.split = Math.round(num(raw.split, 24, 96, d.split));
  o.master = num(raw.master, 0, 1, d.master); o.instVol = num(raw.instVol, 0, 1, d.instVol);
  o.bass = num(raw.bass, -12, 12, 0); o.treble = num(raw.treble, -12, 12, 0); o.bright = num(raw.bright, -100, 100, 0);
  o.transpose = Math.round(num(raw.transpose, -12, 12, 0)); o.octave = Math.round(num(raw.octave, -3, 3, 0)); o.release = Math.round(num(raw.release, 10, 3000, d.release));
  o.sustainEnabled = raw.sustainEnabled !== false; o.kbVisible = raw.kbVisible !== false;
  o.midi = { device: typeof raw.midi?.device === 'string' ? raw.midi.device : 'all', channel: Math.round(num(raw.midi?.channel, 0, 16, 0)) };
  o.cacheMB = Math.round(num(raw.cacheMB, 0, 1024, 0)); o.kbBase = Math.round(num(raw.kbBase, 12, 96, 48)); o.tab = ['play', 'library', 'beats', 'settings', 'owner'].includes(raw.tab) ? raw.tab : 'play';
  o.focusLayer = Math.round(num(raw.focusLayer, 0, 2, 0)); return o;
}
export class Settings {
  constructor(storage) { this.s = storage; this.v = DEFAULTS(); this.listeners = []; this._t = null; this.wasRecovered = false; }
  async load() { const raw = await this.s.getMeta('settings'); this.wasRecovered = !!(this.s.corrupt?.length && this.s.corrupt.some(k => k.startsWith('settings'))); this.v = sanitize(raw); return this.v; }
  onChange(fn) { this.listeners.push(fn); }
  set(patch) { Object.assign(this.v, patch); this.changed(); }
  setLayer(i, patch) { Object.assign(this.v.layers[i], patch); this.changed(); }
  changed() { this.listeners.forEach(f => f(this.v)); clearTimeout(this._t); this._t = setTimeout(() => this.save(), 400); }
  async save() { clearTimeout(this._t); await this.s.putMeta('settings', this.v); }
  async reset() { this.v = DEFAULTS(); await this.save(); this.listeners.forEach(f => f(this.v)); }
  export() { return JSON.stringify({ tonemasterSettings: 1, settings: this.v }, null, 1); }
  async import(text) { const j = JSON.parse(text); if (!j.tonemasterSettings) throw new Error('Not a ToneMaster settings file'); this.v = sanitize(j.settings); await this.save(); this.listeners.forEach(f => f(this.v)); }
}
