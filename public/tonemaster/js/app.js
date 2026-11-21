// ToneMaster application shell: wires storage, library, engine, MIDI, licence and the UI together.
import { CONFIG } from './config.js';
import { openStorage } from './storage.js';
import { Settings, MODES } from './settings.js';
import { Library } from './library.js';
import { SampleManager } from './samples.js';
import { Engine } from './engine.js';
import { MidiManager } from './midi.js';
import { LicenceManager } from './licence.js';
import { createBackup, verifyBackup, restoreBackup } from './backup.js';
import { BeatLibrary, BeatPlayer } from './beats.js';
import { Sequencer } from './seq.js';
import { createStudio } from './studio.js';
import { api } from './api.js';
import { noteName, fmtBytes, clamp, b64 as bytesToB64 } from './util.js';

const $ = s => document.querySelector(s);
const h = (t, a = {}, ...k) => { const e = document.createElement(t); for (const [n, v] of Object.entries(a)) { if (n === 'class') e.className = v; else if (n.startsWith('on')) e.addEventListener(n.slice(2), v); else if (n === 'text') e.textContent = v; else if (v === true) e.setAttribute(n, ''); else if (v !== false && v != null) e.setAttribute(n, v); } for (const c of k.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c)); return e; };
let storage, settings, lib, licence, samples, engine, midi, beats, player, seq, studio; const syncers = []; const layerStatus = ['', '', ''];
let toastT; function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }
const MODE_LABELS = { single: 'Single', dual: 'Dual', split: 'Split', mainDual: 'Main + Dual', mainSplit: 'Main + Split' };
const ROLES = { single: ['MAIN', '', ''], dual: ['LAYER A', 'LAYER B', ''], split: ['LOW (below split)', 'HIGH (from split)', ''], mainDual: ['MAIN', 'DUAL A', 'DUAL B'], mainSplit: ['MAIN (all keys)', 'SPLIT LOW', 'SPLIT HIGH'] };
const USED = { single: 1, dual: 2, split: 2, mainDual: 3, mainSplit: 3 };

/* ---------------- forced landscape ---------------- */
const isRot = () => document.documentElement.classList.contains('rot');
function applyRot() { document.documentElement.classList.toggle('rot', innerHeight > innerWidth); }
function lockLandscape() {
  const lock = () => screen.orientation?.lock?.('landscape').catch(() => { });
  try { const p = lock(); if (p) p.catch?.(() => { }); } catch { }
  const de = document.documentElement;
  if (!document.fullscreenElement && de.requestFullscreen && matchMedia('(pointer:coarse)').matches) de.requestFullscreen({ navigationUI: 'hide' }).then(lock).catch(() => { });
}
applyRot(); addEventListener('resize', applyRot); addEventListener('orientationchange', () => setTimeout(applyRot, 120));

async function boot() {
  lockLandscape(); document.addEventListener('pointerdown', lockLandscape, { once: true });
  try {
    storage = await openStorage(); settings = new Settings(storage); await settings.load();
    lib = new Library(storage); await lib.load(); licence = new LicenceManager(storage, CONFIG); await licence.load();
    samples = new SampleManager(lib, () => engine.ensure(), settings.v.cacheMB); engine = new Engine(samples, settings, { gate: () => licence.active });
    midi = new MidiManager(engine, settings);
    beats = await new BeatLibrary(storage, () => engine.ensure()).load(); player = new BeatPlayer(engine, beats);
    seq = new Sequencer(engine, { banks: id => samples.bank(id), beatBuffer: (p, f, n) => beats.cached(p, f, n) });
    engine.onNoteOn = (n, v, src, ch) => seq.noteOn(n, v, src, ch); engine.onNoteOff = (n, src, ch) => seq.noteOff(n, src, ch);
    studio = createStudio({ h, toast, Engine, engine, settings, samples, lib, storage, beats, player, seq, api, saveBlob, licence });
  } catch (e) { document.body.innerHTML = ''; document.body.append(h('div', { class: 'sheet', style: 'margin:20px' }, h('h2', { text: 'ToneMaster could not start' }), h('p', { class: 'bad', text: e.message }), h('p', { class: 'muted', text: 'Storage (IndexedDB) must be available and not blocked. If this is a private/incognito window, open the app normally.' }))); throw e; }
  if (location.search.includes('test=1')) window.__tm = { storage, settings, lib, licence, samples, engine, midi, beats, player, seq, studio };
  // drop layer assignments that no longer exist
  settings.v.layers.forEach(l => { if (l.inst && !lib.get(l.inst)) l.inst = null; });
  buildPlay(); buildTabs(); buildModals(); renderLibrary(); midi.onChange = renderMidi; midi.onActivity = (n, on) => lightKey(n, on);
  engine.onActivity = n => $('#voices').textContent = n + (n === 1 ? ' voice' : ' voices');
  settings.onChange(() => { engine.applySettings(); sync(); }); sync(); renderLic(); show(settings.v.tab === 'owner' && !licence.isOwner ? 'play' : settings.v.tab);
  if (settings.wasRecovered || storage.recovered?.length) toast('Settings were repaired from a backup copy');
  if (lib.recovered) toast('Library index rebuilt: ' + lib.recovered.instruments + ' instruments found');
  midi.supported ? midi.start() : renderMidi();                                 // honest status: never pretends
  loadLayerBanks();
  if (!licence.active) openAct(licence.state.status === 'invalid');
  document.addEventListener('pointerdown', () => { try { engine.ensure(); } catch { } }, { once: false, passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { engine.allNotesOff(); samples.releaseUnused(); settings.save(); } else try { engine.ensure(); } catch { } });
  addEventListener('pagehide', () => { engine.allNotesOff(); settings.save(); });
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => { });
}

/* ---------------- sync helpers ---------------- */
function sync() { syncers.forEach(f => f(settings.v)); renderLayers(); }
function setRange(el, v) { el.value = v; el.style.setProperty('--p', ((v - el.min) / (el.max - el.min) * 100) + '%'); }
function slider(key, label, min, max, step, fmt, onInput) {
  const out = h('b'), inp = h('input', { type: 'range', min, max, step }), w = h('div', { class: 'ctl' }, h('label', {}, label, out), inp);
  inp.addEventListener('input', () => { settings.set({ [key]: +inp.value }); onInput?.(); });
  syncers.push(v => { setRange(inp, v[key]); out.textContent = fmt(v[key]); }); return w;
}
function stepper(label, get, set, min, max, fmt) {
  const out = h('b'); const w = h('div', { class: 'stepper' }, h('span', { text: label }), h('button', { text: '−', onclick: () => set(clamp(get() - 1, min, max)) }), out, h('button', { text: '+', onclick: () => set(clamp(get() + 1, min, max)) })); w.update = () => out.textContent = fmt(get()); return w;
}
const sgn = n => (n > 0 ? '+' : '') + n;

/* ---------------- PLAY tab ---------------- */
let layerEls = [];
function buildPlay() {
  const seg = $('#modeSeg'); MODES.forEach(m => seg.append(h('button', { 'data-m': m, text: MODE_LABELS[m], onclick: () => settings.set({ mode: m }) })));
  syncers.push(v => { seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === v.mode)); });
  const ss = $('#splitSlider'); ss.addEventListener('input', () => settings.set({ split: +ss.value })); syncers.push(v => { setRange(ss, v.split); $('#splitVal').textContent = noteName(v.split); ss.disabled = !(v.mode === 'split' || v.mode === 'mainSplit'); });
  $('#sustainBtn').onclick = () => { settings.set({ sustainEnabled: !settings.v.sustainEnabled }); if (!settings.v.sustainEnabled) engine.sustained.forEach(k => { const [s, c] = [k.slice(0, k.lastIndexOf(':')), +k.slice(k.lastIndexOf(':') + 1)]; engine.sustain(false, s, c); }); };
  syncers.push(v => { const b = $('#sustainBtn'); b.classList.toggle('on', v.sustainEnabled); b.textContent = 'Sustain pedal: ' + (v.sustainEnabled ? 'ON' : 'OFF'); });
  $('#panicBtn').onclick = () => engine.allNotesOff();
  const host = $('#layers'); layerEls = [0, 1, 2].map(i => {
    const L = () => settings.v.layers[i], title = h('span'), sw = h('span', { class: 'switch', role: 'switch', onclick: () => settings.setLayer(i, { on: !L().on }) });
    const name = h('b'), st = h('small'), pick = h('button', { class: 'inst', onclick: () => openPicker(i) }, h('span', {}, name, st), h('span', { class: 'arr', text: '▾' }));
    const vo = h('b'), vi = h('input', { type: 'range', min: 0, max: 1, step: 0.01 }); vi.addEventListener('input', () => settings.setLayer(i, { vol: +vi.value }));
    const oct = stepper('Octave', () => L().oct, v => settings.setLayer(i, { oct: v }), -3, 3, sgn), tr = stepper('Transpose', () => L().tr, v => settings.setLayer(i, { tr: v }), -12, 12, v => sgn(v) + ' st');
    const card = h('div', { class: 'layer' }, h('h3', {}, title, sw), pick, h('div', { class: 'ctl' }, h('label', {}, 'Volume', vo), vi), oct, tr); host.append(card);
    return { card, title, sw, name, st, vo, vi, oct, tr };
  });
  const c = $('#ctrls');
  [slider('master', 'Master', 0, 1, 0.01, v => Math.round(v * 100) + '%'), slider('instVol', 'Instrument', 0, 1, 0.01, v => Math.round(v * 100) + '%'), slider('bass', 'Bass', -12, 12, 0.5, v => sgn(v) + ' dB'), slider('treble', 'Treble', -12, 12, 0.5, v => sgn(v) + ' dB'),
  slider('bright', 'Brightness', -100, 100, 1, v => sgn(v)), slider('octave', 'Octave', -3, 3, 1, v => sgn(v)), slider('release', 'Release', 10, 2000, 10, v => v + ' ms')].forEach(x => c.append(x));
  const transpose = stepper('TRANSPOSE', () => settings.v.transpose, n => settings.set({ transpose: n }), -12, 12, n => sgn(n) + ' st');
  transpose.classList.add('transpose'); transpose.append(h('button', { class: 'reset', text: '↺', title: 'Reset transpose to 0', 'aria-label': 'Reset transpose to 0', onclick: () => settings.set({ transpose: 0 }) })); c.append(transpose); syncers.push(() => transpose.update());
  $('#kbDown').onclick = () => settings.set({ kbBase: clamp(settings.v.kbBase - 12, 12, 84) }); $('#kbUp').onclick = () => settings.set({ kbBase: clamp(settings.v.kbBase + 12, 12, 84) });
  $('#kbHide').onclick = () => settings.set({ kbVisible: false }); $('#kbShow').onclick = () => settings.set({ kbVisible: true });
  let lastBase = -1; syncers.push(v => { $('#kbWrap').hidden = !v.kbVisible; $('#kbShow').hidden = v.kbVisible; if (v.kbBase !== lastBase) { lastBase = v.kbBase; buildKeys(v.kbBase); } });
}
function renderLayers() {
  const v = settings.v;
  layerEls.forEach((e, i) => {
    const L = v.layers[i], used = i < USED[v.mode], inst = L.inst && lib.get(L.inst);
    e.card.className = 'layer ' + (L.on ? 'on' : 'off') + (used ? '' : ' locked'); e.title.textContent = 'Layer ' + (i + 1) + (ROLES[v.mode][i] ? ' · ' + ROLES[v.mode][i] : ' · unused in this mode');
    e.sw.classList.toggle('on', L.on); e.name.textContent = inst ? inst.name : 'Choose instrument'; e.st.textContent = inst ? (layerStatus[i] || '') : 'Tap to pick from your library';
    setRange(e.vi, L.vol); e.vo.textContent = Math.round(L.vol * 100) + '%'; e.oct.update(); e.tr.update();
  });
}
async function loadLayerBanks() {
  engine.pinActive(); const v = settings.v;
  for (let i = 0; i < 3; i++) { const id = v.layers[i].inst; if (!id || !lib.playable(id)) continue; layerStatus[i] = 'Loading…';
    try { await samples.load(id, (d, t) => { layerStatus[i] = 'Loading ' + d + '/' + t; renderLayers(); }); const b = samples.bank(id); layerStatus[i] = 'Ready · ' + b.samples.length + ' samples' + (b.failed ? ' · ' + b.failed + ' failed' : ''); }
    catch (e) { layerStatus[i] = 'Error: ' + e.message; }
    renderLayers(); }
}
async function assign(i, id) { settings.setLayer(i, { inst: id }); if (i > 0 && !settings.v.layers[i].on) settings.setLayer(i, { on: true }); layerStatus[i] = 'Loading…'; renderLayers(); engine.pinActive(); await loadLayerBanks(); }

/* ---------------- keyboard ---------------- */
const BLACK = [1, 3, 6, 8, 10];
function buildKeys(base) {
  const kb = $('#kb'); kb.innerHTML = ''; const lo = base, hi = base + 24, whites = []; for (let n = lo; n <= hi; n++) if (!BLACK.includes(n % 12)) whites.push(n);
  const w = 100 / whites.length; const bind = (k, n) => {
    const down = e => { e.preventDefault(); if (!licence.active) { toast('Activate ToneMaster to play'); return; } try { k.setPointerCapture(e.pointerId); } catch { } const r = k.getBoundingClientRect(), f = isRot() ? (r.right - e.clientX) / r.width : (e.clientY - r.top) / r.height; engine.noteOn(n, Math.round(clamp(45 + f * 82, 1, 127)), 'ui:' + e.pointerId, 0); k.classList.add('on'); k._pid = e.pointerId; };
    const up = e => { if (k._pid == null) return; engine.noteOff(n, 'ui:' + k._pid, 0); k._pid = null; k.classList.remove('on'); }; k.addEventListener('pointerdown', down); k.addEventListener('pointerup', up); k.addEventListener('pointercancel', up); k.addEventListener('lostpointercapture', up);
  };
  whites.forEach(n => { const k = h('div', { class: 'wk', 'data-n': n, text: n % 12 === 0 ? noteName(n) : '' }); bind(k, n); kb.append(k); });
  whites.forEach((n, i) => { if (BLACK.includes((n + 1) % 12) && n + 1 <= hi) { const k = h('div', { class: 'bk', 'data-n': n + 1, style: 'width:' + w * 0.6 + '%;left:' + ((i + 1) * w - w * 0.3) + '%' }); bind(k, n + 1); kb.append(k); } });
  $('#kbRange').textContent = noteName(lo) + ' – ' + noteName(hi);
}
const lightKey = (n, on) => { const k = document.querySelector('#kb [data-n="' + n + '"]'); if (k) k.classList.toggle('on', on); };

/* ---------------- tabs ---------------- */
function buildTabs() { document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => show(b.dataset.tab)); $('#midiPill').onclick = () => show('settings'); $('#licPill').onclick = () => openAct(false); }
function show(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + tab)); document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  settings.v.tab = tab; if (tab === 'library') renderLibrary(); if (tab === 'settings') renderSettings(); if (tab === 'owner') renderOwner(); if (tab === 'play') sync(); if (tab === 'beats') studio.show(); settings.save();
}
function renderMidi() {
  const p = $('#midiPill'), n = midi.inputs.size; $('#midiText').textContent = 'MIDI: ' + (n ? [...midi.inputs.values()][0].name + (n > 1 ? ' +' + (n - 1) : '') : midi.supported ? 'no device' : 'unavailable');
  p.classList.toggle('ok', n > 0); p.classList.toggle('warn', !n); p.title = midi.statusText; if ($('#tab-settings').classList.contains('on')) renderSettings();
}
function renderLic() {
  const s = licence.state, p = $('#licPill'); p.className = 'pill ' + (licence.active ? 'ok' : 'bad'); $('#licText').textContent = licence.active ? (licence.isOwner ? 'Owner licence' : 'Licensed') + (s.status === 'grace' ? ' (re-checking)' : '') : 'Not activated · tap to activate';
  $('#ownerTab').hidden = !licence.isOwner;
}

/* ---------------- modals ---------------- */
function buildModals() {
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('.modal').hidden = true));
  $('#importBtn').onclick = openImport; $('#storeBtn').onclick = openStore; $('#storeRefresh').onclick = renderStore; $('#verifyBtn').onclick = verifyLibrary;
  $('#pickZips').onclick = () => $('#zipInput').click(); $('#zipInput').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) runScan(f); };
  $('#copyId').onclick = async () => { try { await navigator.clipboard.writeText(licence.deviceId); toast('Device ID copied'); } catch { toast('Select and copy the ID manually'); } };
  $('#reqBtn').onclick = requestLicence; $('#actBtn').onclick = () => doActivate($('#licInput').value); $('#actSkip').onclick = () => $('#actModal').hidden = true;
  $('#licFileBtn').onclick = () => $('#licFile').click(); $('#licFile').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) { const t = await f.text(); $('#licInput').value = t.trim(); doActivate(t); } };
}
function openAct(showErr) {
  $('#actModal').hidden = false; $('#devId').textContent = licence.deviceId; $('#actPrice').textContent = 'ToneMaster licence: ' + CONFIG.PRICE + ' per device. Buy from MG:SOUNDS, then paste the licence key you receive. Your sample library is stored only on this phone.';
  const m = $('#actMsg'); m.className = 'msg' + (showErr ? ' err' : ''); m.textContent = showErr ? licence.state.message : '';
  $('#actSkip').hidden = false; $('#actBtn').textContent = licence.active ? 'Replace licence' : 'Activate';
}
async function doActivate(text) {
  const m = $('#actMsg'); m.className = 'msg'; m.textContent = 'Checking…'; const r = await licence.activate(text);
  if (!r.ok) { m.className = 'msg err'; m.textContent = r.message; return; }
  m.className = 'msg ok'; m.textContent = 'Activated. Thank you!'; renderLic(); sync(); setTimeout(() => { $('#actModal').hidden = true; if (!licence.isOwner && settings.v.tab === 'owner') show('play'); }, 700);
}
async function requestLicence() {
  const t = licence.requestText(), c = CONFIG.CONTACT;
  if (navigator.share) { try { await navigator.share({ title: 'ToneMaster licence request', text: t }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  if (c.email) { location.href = 'mailto:' + c.email + '?subject=' + encodeURIComponent('ToneMaster licence request') + '&body=' + encodeURIComponent(t); return; }
  try { await navigator.clipboard.writeText(t); toast('Request copied. Send it to MG:SOUNDS.'); } catch { toast('Copy the Device ID and send it to MG:SOUNDS'); }
}

/* picker + library */
function stateBadge(id) { const s = lib.status[id]?.state || 'none'; return h('span', { class: 'badge ' + s, text: s === 'none' ? 'not installed' : s }); }
function openPicker(i) {
  settings.set({ focusLayer: i }); $('#pickTitle').textContent = 'Layer ' + (i + 1) + ' instrument'; const g = $('#pickGrid'); g.innerHTML = '';
  const list = lib.list(); if (!list.length) g.append(h('p', { class: 'muted', text: 'No tones yet. Open Library and tap “Download tones”.' }));
  list.forEach(ins => g.append(h('button', { class: 'card', onclick: async () => { $('#pickModal').hidden = true; await assign(i, ins.id); } }, h('h4', { text: ins.name }), h('div', { class: 'meta', text: ins.count + ' samples' }), stateBadge(ins.id))));
  g.append(h('button', { class: 'card', onclick: () => { $('#pickModal').hidden = true; settings.setLayer(i, { inst: null }); } }, h('h4', { text: 'None' }), h('div', { class: 'meta', text: 'Clear this layer' })));
  $('#pickModal').hidden = false;
}
function renderLibrary() {
  const g = $('#libGrid'); g.innerHTML = ''; const list = lib.list(); const tot = Object.values(lib.index).reduce((a, r) => a + r.size, 0);
  $('#libSummary').textContent = list.length + ' instruments · ' + Object.keys(lib.index).length + ' samples · ' + fmtBytes(tot);
  list.forEach(ins => g.append(h('div', { class: 'card' }, h('h4', { text: ins.name }), h('div', { class: 'row' }, stateBadge(ins.id), h('span', { class: 'meta', text: ins.count + ' samples · ' + fmtBytes(ins.bytes || 0) })),
    lib.status[ins.id]?.missing?.length ? h('div', { class: 'warn', text: 'Missing markers: ' + lib.status[ins.id].missing.slice(0, 12).join(', ') }) : null,
    h('div', { class: 'row' }, [0, 1, 2].map(i => h('button', { class: 'btn', text: 'Layer ' + (i + 1), onclick: async () => { await assign(i, ins.id); toast(ins.name + ' → Layer ' + (i + 1)); } }))),
    h('div', { class: 'row' }, h('button', { class: 'btn', text: 'Rename / root note / delete', onclick: () => instrumentSheet(ins.id) })))));
  if (!list.length) g.append(h('div', { class: 'card empty', style: 'grid-column:1/-1' }, h('h4', { text: 'No tones yet' }), h('div', { class: 'meta', text: 'Tap “⬇ Download tones” to get tones. Each tone appears here with its name after it is downloaded.' })));
}
function instrumentSheet(id) {
  const ins = lib.get(id), name = h('input', { type: 'text', value: ins.name }), root = h('select', {}, [24, 36, 48, 60].map(n => h('option', { value: n, selected: n === ins.root, text: noteName(n) + ' (first sample)' })));
  let armed = false; const del = h('button', { class: 'btn danger', text: 'Delete instrument…', onclick: async () => { if (!armed) { armed = true; del.textContent = 'Tap again to permanently delete'; return; } samples.evict(id); settings.v.layers.forEach((l, i) => { if (l.inst === id) settings.setLayer(i, { inst: null }); }); await lib.deleteInstrument(id); $('#pickModal').hidden = true; renderLibrary(); sync(); } });
  const sheetBody = $('#pickGrid'); sheetBody.innerHTML = ''; $('#pickTitle').textContent = ins.name;
  sheetBody.append(h('div', { class: 'box', style: 'grid-column:1/-1' }, h('label', { text: 'Display name (use this if detection guessed wrong)' }), name, h('label', { text: 'Pitch of marker #1 / first sample' }), root,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', text: 'Save', onclick: async () => { await lib.rename(id, name.value); await lib.setRoot(id, +root.value); samples.evict(id); $('#pickModal').hidden = true; renderLibrary(); loadLayerBanks(); sync(); } }),
      h('button', { class: 'btn', text: 'Verify this instrument', onclick: async () => { const bad = await lib.verifyAll(() => { }, lib.samplesOf(id).map(r => r.id)); toast(bad.length ? bad.length + ' damaged samples — re-import this ZIP' : 'All samples verified'); renderLibrary(); } }), del)));
  $('#pickModal').hidden = false;
}
async function verifyLibrary() { const b = $('#verifyBtn'); b.disabled = true; b.textContent = 'Verifying…'; const bad = await lib.verifyAll(p => b.textContent = 'Verifying ' + p.done + '/' + p.total); b.disabled = false; b.textContent = 'Verify library'; toast(bad.length ? bad.length + ' damaged sample(s) found. Re-import the affected ZIP.' : 'Library verified: all samples intact', 4000); renderLibrary(); }

/* ---------------- tone store: the ONLY place the app uses internet ---------------- */
let storeList = null, busyPack = null;
const getInstalled = () => storage.getMeta('packs_installed', {});
async function openStore() { $('#storeModal').hidden = false; await renderStore(); }
async function renderStore() {
  const body = $('#storeBody'); if (busyPack) return; body.innerHTML = ''; body.append(h('p', { class: 'muted', text: 'Connecting to the tone store…' }));
  try {
    storeList = (await api.catalog('tone')).packs;
  } catch (e) { body.innerHTML = ''; body.append(h('p', { class: 'bad', text: 'No internet or the tone store is not reachable. Your installed tones still work offline.' }), h('p', { class: 'muted', text: String(e.message || e) })); return; }
  const inst = await getInstalled(); body.innerHTML = '';
  if (!storeList.length) { body.append(h('p', { class: 'muted', text: 'No tones are available yet. Check again later.' })); return; }
  storeList.forEach(p => {
    const rec = inst[p.id], have = rec && rec.insts?.some(id => lib.get(id)), upd = have && String(rec.version) !== String(p.version);
    const st = h('small', { text: have ? (upd ? 'Update available: v' + rec.version + ' → v' + p.version : 'Installed · v' + rec.version) : 'Not downloaded' });
    const bar = h('i'), prog = h('div', { class: 'prog', hidden: true }, bar);
    const btn = h('button', { class: 'btn ' + (!have || upd ? 'primary' : ''), text: !have ? 'Download' : upd ? 'Update' : 'Download again' });
    btn.onclick = () => installPack(p, { btn, st, prog, bar });
    body.append(h('div', { class: 'store-row' }, h('div', { class: 'grow' }, h('b', { text: p.name }), h('small', { text: 'v' + p.version + ' · ' + fmtBytes(p.file_size || 0) + (p.description ? ' · ' + p.description : '') }), st, prog), btn));
  });
}
async function installPack(p, ui) {
  if (busyPack) { toast('Wait for the current download to finish'); return; }
  busyPack = p.id; document.querySelectorAll('#storeBody .btn').forEach(b => b.disabled = true); ui.prog.hidden = false;
  try {
    ui.st.textContent = 'Downloading…';
    const blob = await api.download(p.id, 'pack', (g, t) => { ui.bar.style.width = (t ? g / t * 100 : 50) + '%'; ui.st.textContent = 'Downloading ' + fmtBytes(g) + (t ? ' of ' + fmtBytes(t) : ''); });
    const file = new File([blob], p.file_name || (p.name + '.zip'), { type: 'application/zip', lastModified: Date.parse(p.updated_at) || Date.now() });
    ui.st.textContent = 'Checking…'; ui.bar.style.width = '0%';
    const plan = await lib.scan([file], () => { }, { forceName: p.name });
    if (plan.zipErrors.length) throw new Error(plan.zipErrors[0].error);
    const ids = Object.keys(plan.groups); if (!ids.length) throw new Error('This pack has no WAV tones');
    const rep = await lib.importPlan(plan, { replaceDifferent: true, onProgress: q => { ui.bar.style.width = (q.total ? q.done / q.total * 100 : 100) + '%'; ui.st.textContent = 'Installing ' + q.done + '/' + q.total; } });
    const inst = await getInstalled(), old = inst[p.id]?.insts || [];
    for (const id of old) if (!ids.includes(id) && lib.get(id)) { samples.evict(id); settings.v.layers.forEach((l, i) => { if (l.inst === id) settings.setLayer(i, { inst: null }); }); await lib.deleteInstrument(id); }
    ids.forEach(id => samples.evict(id)); const okIds = ids.filter(id => lib.get(id));
    if (!okIds.length) throw new Error(rep.failed[0]?.error || 'No tones could be installed');
    inst[p.id] = { version: p.version, name: p.name, insts: okIds, at: new Date().toISOString() }; await storage.putMeta('packs_installed', inst);
    if (!settings.v.layers[0].inst || !lib.get(settings.v.layers[0].inst)) settings.setLayer(0, { inst: okIds[0] });
    toast(p.name + ' installed' + (rep.failed.length ? ' (' + rep.failed.length + ' file(s) failed)' : ''), 3500);
    renderLibrary(); sync(); loadLayerBanks();
  } catch (e) { ui.st.textContent = 'Failed: ' + (e.message || e); ui.st.className = 'bad'; }
  busyPack = null; if (ui.st.className !== 'bad') await renderStore(); else document.querySelectorAll('#storeBody .btn').forEach(b => b.disabled = false);
}

/* ---------------- import ---------------- */
function openImport() { $('#importModal').hidden = false; $('#impStep1').hidden = false; $('#impBody').innerHTML = ''; }
async function runScan(files) {
  $('#impStep1').hidden = true; const body = $('#impBody'); body.innerHTML = ''; const msg = h('p', { class: 'muted', text: 'Scanning…' }); body.append(msg);
  let plan; try { plan = await lib.scan(files, p => msg.textContent = 'Scanning ' + p.name + '…'); } catch (e) { body.innerHTML = ''; body.append(h('p', { class: 'bad', text: e.message }), h('button', { class: 'btn', text: 'Back', onclick: openImport })); return; }
  renderPlan(plan);
}
function renderPlan(plan) {
  const body = $('#impBody'); body.innerHTML = ''; const groups = Object.values(plan.groups); let replace = false;
  const todo = () => groups.reduce((a, g) => a + g.counts.new + (replace ? g.counts.conflict : 0), 0);
  body.append(h('p', { class: 'muted', text: 'Detected ' + groups.length + ' instrument' + (groups.length === 1 ? '' : 's') + ' in ' + plan.totalFiles + ' files. Nothing is stored until you press Import.' }));
  plan.zipDuplicates.forEach(n => body.append(h('p', { class: 'warn', text: '“' + n + '” looks like a ZIP you already imported. Identical samples will be skipped.' })));
  plan.zipErrors.forEach(z => body.append(h('p', { class: 'bad', text: z.zip + ': ' + z.error })));
  groups.forEach(g => {
    const nm = h('input', { type: 'text', value: g.name }); nm.addEventListener('change', () => { lib.renameGroup(plan, g.id, nm.value); renderPlan(plan); });
    body.append(h('div', { class: 'grp' }, h('div', { class: 'row' }, h('span', { class: 'badge ' + (g.known ? 'installed' : 'partial'), text: g.known ? 'known bank' : 'new instrument' }), h('span', { class: 'muted', text: g.items.length + ' WAV · markers ' + g.min + '–' + g.max })),
      h('label', { text: 'Instrument name (edit if wrong)' }), nm,
      h('div', { class: 'muted', text: 'New ' + g.counts.new + ' · duplicates ' + g.counts.duplicate + ' · differing ' + g.counts.conflict + ' · detected by: ' + [...g.rules].join('; ') }),
      g.missing.length ? h('div', { class: 'warn', text: 'Missing markers: ' + g.missing.slice(0, 20).join(', ') + (g.missing.length > 20 ? '…' : '') }) : null,
      g.unnumbered.length ? h('div', { class: 'warn', text: g.unnumbered.length + ' file(s) without a marker number will be skipped' }) : null,
      g.autoNumbered ? h('div', { class: 'warn', text: 'No marker numbers found: samples numbered by filename order' }) : null,
      g.dupMarkers ? h('div', { class: 'warn', text: 'Duplicate marker numbers skipped: ' + g.dupMarkers.length }) : null));
  });
  if (plan.unsupported.length || plan.ignored) body.append(h('details', {}, h('summary', { text: plan.unsupported.length + ' unsupported file(s), ' + plan.ignored + ' system file(s) ignored' }), h('div', { class: 'list' }, plan.unsupported.map(u => h('div', { text: u.file + ' — ' + u.reason })))));
  const cb = h('input', { type: 'checkbox' }); cb.onchange = () => { replace = cb.checked; go.disabled = !todo(); };
  if (groups.some(g => g.counts.conflict)) body.append(h('label', { style: 'display:flex;gap:8px;align-items:center' }, cb, 'Replace existing samples that differ from the ones in these ZIPs'));
  const go = h('button', { class: 'btn primary big', text: 'Import', disabled: !todo(), onclick: () => runImport(plan, () => replace) });
  body.append(h('div', { class: 'row end' }, h('button', { class: 'btn', text: 'Cancel', onclick: () => $('#importModal').hidden = true }), go));
}
async function runImport(plan, getReplace) {
  const body = $('#impBody'); body.innerHTML = ''; const bar = h('i'), txt = h('p', { class: 'muted', text: 'Starting…' }); body.append(h('div', { class: 'prog' }, bar), txt);
  const ids = Object.keys(plan.groups);
  const rep = await lib.importPlan(plan, { replaceDifferent: getReplace(), onProgress: p => { bar.style.width = (p.total ? p.done / p.total * 100 : 100) + '%'; txt.textContent = (p.phase === 'import' ? 'Encrypting & verifying ' : '') + (p.name || '') + ' (' + p.done + '/' + p.total + ')'; } });
  ids.forEach(id => samples.evict(id)); const first = lib.list().find(i => ids.includes(i.id) && lib.playable(i.id));
  if (first && !settings.v.layers[0].inst) settings.setLayer(0, { inst: first.id });
  body.innerHTML = ''; body.append(h('h3', { text: 'Import finished' }),
    h('p', { text: 'Installed (verified): ' + (rep.installed.join(', ') || '—') }), rep.partial.length ? h('p', { class: 'warn', text: 'Partly installed (missing/failed files): ' + rep.partial.join(', ') }) : null,
    h('p', { class: 'muted', text: rep.added + ' samples added · ' + rep.replaced + ' replaced · ' + rep.skippedDuplicate + ' duplicates skipped · ' + rep.skippedConflict + ' differing skipped' }),
    rep.failed.length ? h('details', { open: true }, h('summary', { class: 'bad', text: rep.failed.length + ' file(s) failed' }), h('div', { class: 'list' }, rep.failed.map(f => h('div', { text: f.instrument + ' / ' + f.file + ': ' + f.error })))) : null,
    h('p', { class: 'muted', text: 'Your tones are stored encrypted on this device. You do not need to import them again.' }), h('div', { class: 'row end' }, h('button', { class: 'btn primary', text: 'Done', onclick: () => $('#importModal').hidden = true })));
  renderLibrary(); sync(); loadLayerBanks();
}

/* ---------------- settings & owner ---------------- */
function box(title, ...k) { return h('div', { class: 'box' }, h('h3', { text: title }), ...k); }
const kv = (a, b) => h('div', { class: 'kv' }, h('span', { text: a }), h('span', { text: b }));
function renderSettings() {
  const root = $('#settingsBody'); root.innerHTML = ''; const v = settings.v, ctx = engine.ctx;
  const dev = h('select', {}, h('option', { value: 'all', text: 'All devices' }), [...midi.inputs.values()].map(d => h('option', { value: d.id, text: d.name, selected: v.midi.device === d.id }))); dev.onchange = () => settings.set({ midi: { ...v.midi, device: dev.value } });
  const ch = h('select', {}, h('option', { value: 0, text: 'All channels (omni)' }), Array.from({ length: 16 }, (_, i) => h('option', { value: i + 1, text: 'Channel ' + (i + 1), selected: v.midi.channel === i + 1 }))); ch.onchange = () => settings.set({ midi: { ...v.midi, channel: +ch.value } });
  root.append(box('USB MIDI', kv('Status', midi.statusText), kv('Method', { web: 'Web MIDI (browser engine)', native: 'Native Android bridge', none: 'Not available' }[midi.mode]), h('label', { text: 'Input device' }), dev, h('label', { text: 'Channel' }), ch,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', text: midi.inputs.size ? 'Rescan' : 'Connect / allow MIDI', onclick: async () => { await midi.start(); renderSettings(); toast(midi.statusText, 3500); } }), h('button', { class: 'btn', text: 'All notes off', onclick: () => engine.allNotesOff() })),
    h('p', { text: 'Plug the keyboard into the phone with a USB-OTG adapter, then tap Connect. If your app wrapper cannot expose MIDI, this page says so — see README → USB MIDI.' })));
  const cache = h('select', {}, [[0, 'Auto'], [96, '96 MB'], [160, '160 MB'], [256, '256 MB'], [384, '384 MB'], [512, '512 MB']].map(([n, t]) => h('option', { value: n, text: t, selected: v.cacheMB === n }))); cache.onchange = () => { settings.set({ cacheMB: +cache.value }); samples.setBudget(+cache.value || 0); };
  root.append(box('Audio & memory', kv('Output sample rate', ctx ? ctx.sampleRate + ' Hz' : 'starts on first touch'), kv('Base latency', ctx?.baseLatency != null ? Math.round(ctx.baseLatency * 1000) + ' ms' : '—'), kv('Sample cache in use', fmtBytes(samples.usedBytes) + ' of ' + fmtBytes(samples.budget)), h('label', { text: 'Cache budget (lower on phones with little RAM)' }), cache,
    h('button', { class: 'btn', text: 'Release unused audio memory', onclick: () => { samples.releaseUnused(); renderSettings(); } }), h('p', { text: 'Only instruments used by active layers stay decoded. Everything else is decrypted again on demand.' })));
  const st = h('div', { class: 'kv' }, h('span', { text: 'Storage use' }), h('span', { text: '…' })); storage.estimate().then(e => st.lastChild.textContent = e ? fmtBytes(e.used) + ' / ' + fmtBytes(e.quota) : 'n/a');
  root.append(box('Storage & protection', kv('Backend', storage.label), kv('Encrypted at rest', 'AES-256-GCM'), kv('Hardware Keystore', storage.kind === 'native' ? 'Yes (Android Keystore)' : 'No – browser mode'), kv('Persistent storage', storage.kind === 'native' ? 'App-private files' : storage.persisted ? 'Granted' : 'Not guaranteed'), st,
    h('div', { class: 'row' }, h('button', { class: 'btn', text: 'Verify library', onclick: verifyLibrary }), h('button', { class: 'btn', text: 'Rebuild index', onclick: async () => { const r = await lib.rebuildIndex(); renderLibrary(); toast('Rebuilt: ' + r.instruments + ' instruments, ' + r.samples + ' samples'); } })),
    h('p', { text: storage.kind === 'native' ? 'Samples live in this app’s private storage and are encrypted with a hardware-backed key.' : 'Browser mode: samples are encrypted with a non-extractable device key inside this app’s private browser storage. This deters casual copying but is not equal to native Android private storage.' })));
  const f = h('input', { type: 'file', accept: '.json,application/json', hidden: true }); f.onchange = async () => { try { await settings.import(await f.files[0].text()); toast('Settings loaded'); } catch (e) { toast('Could not load: ' + e.message); } };
  root.append(box('Settings backup & recovery', h('div', { class: 'row' }, h('button', { class: 'btn', text: 'Save settings file', onclick: () => saveBlob(new Blob([settings.export()], { type: 'application/json' }), 'tonemaster-settings.json') }), h('button', { class: 'btn', text: 'Load settings file', onclick: () => f.click() }), f, h('button', { class: 'btn danger', text: 'Reset to defaults', onclick: async () => { await settings.reset(); toast('Settings reset (your instruments are untouched)'); } })),
    h('p', { text: 'Settings are saved automatically with a checksum and a previous-version copy. If they ever become damaged, the previous copy (or defaults) is restored on start-up. Your instruments are never affected.' })));
  const s = licence.state, p = s.payload; root.append(box('Licence', kv('Status', licence.active ? 'Activated' + (s.status === 'grace' ? ' (re-check pending)' : '') : s.message), p ? kv('Licensed to', p.customer) : null, p ? kv('Licence ID', p.lid) : null, p?.role === 'owner' ? kv('Type', 'Owner') : null, kv('Device ID', licence.deviceId),
    h('div', { class: 'row' }, h('button', { class: 'btn', text: 'Enter / replace licence', onclick: () => openAct(false) }), h('button', { class: 'btn', text: 'Request licence for this device', onclick: requestLicence })),
    h('p', { text: 'New phone? Send MG:SOUNDS your new Device ID and proof of purchase to get a replacement licence. Then import your tone ZIPs again on the new phone.' })));
  root.append(updateBox());
  root.append(box('About', kv('ToneMaster', 'v' + CONFIG.VERSION + ' · MG:SOUNDS'), h('p', { text: 'Raw WAV files are never shown or exported by this app. No samples are uploaded or shared. Honest note: no software can make audio impossible to capture on a phone the user controls.' })));
}
function updateBox() {
  const nat = globalThis.ToneMasterNative; let installed = { versionName: CONFIG.VERSION, versionCode: CONFIG.VERSION_CODE };
  try { if (nat?.appInfo) installed = JSON.parse(nat.appInfo()); } catch { }
  const msg = h('p', { class: 'msg', text: 'Installed version: ' + installed.versionName }), details = h('div'), bar = h('i'), prog = h('div', { class: 'prog', hidden: true }, bar);
  const check = h('button', { class: 'btn', text: 'Check for app updates', onclick: async () => {
    check.disabled = true; msg.textContent = 'Checking…'; details.innerHTML = '';
    try {
      const { latestRelease: r } = await api.catalog();
      if (!r || r.version_code <= installed.versionCode) msg.textContent = 'You have the latest available version (' + installed.versionName + ').';
      else {
        msg.textContent = 'Update available: ' + r.version_name; details.append(h('p', { text: r.notes || 'New ToneMaster release' }));
        const download = h('button', { class: 'btn primary', text: nat?.installUpdate ? 'Download and install update' : 'Download APK', onclick: async () => {
          download.disabled = true; prog.hidden = false;
          try {
            if (nat?.installUpdate) { const { url } = await api.link(r.id, 'release'); nat.installUpdate(url, r.sha256, r.version_code); msg.textContent = 'Downloading on Android…'; }
            else {
              const blob = await api.download(r.id, 'release', (g, t) => { bar.style.width = (t ? g / t * 100 : 50) + '%'; msg.textContent = 'Downloading ' + fmtBytes(g); });
              const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
              if ([...digest].map(b => b.toString(16).padStart(2, '0')).join('') !== r.sha256) throw new Error('Downloaded APK failed integrity verification');
              await saveBlob(blob, 'ToneMaster-' + r.version_name + '.apk'); msg.textContent = 'APK downloaded. Android will verify the package and ask you to confirm installation.';
            }
          } catch (e) { msg.textContent = 'Update failed: ' + e.message; download.disabled = false; }
        } }); details.append(download);
      }
    } catch (e) { msg.textContent = 'Could not check updates: ' + e.message; } check.disabled = false;
  } });
  globalThis.onToneMasterUpdate = event => { if (!msg.isConnected) return; msg.textContent = event.message; prog.hidden = false; bar.style.width = (event.progress || 0) + '%'; };
  return box('App updates', msg, check, details, prog);
}
function renderOwner() {
  const root = $('#ownerBody'); root.innerHTML = ''; if (!licence.isOwner) { root.append(box('Owner tools', h('p', { text: 'Owner licence required.' }))); return; }
  const pw = h('input', { type: 'password', placeholder: 'Backup password (min 8 characters)' }), out = h('p', { class: 'msg' }), mk = h('button', { class: 'btn primary', text: 'Create encrypted backup', onclick: async () => {
    mk.disabled = true; try { out.className = 'msg'; const blob = await createBackup(lib, settings, pw.value, p => out.textContent = 'Encrypting ' + p.done + '/' + p.total + ' …'); await saveBlob(blob, 'ToneMaster-library-' + new Date().toISOString().slice(0, 10) + '.tmbackup'); out.className = 'msg ok'; out.textContent = 'Backup created (' + fmtBytes(blob.size) + '). Store it and the password somewhere safe.'; } catch (e) { out.className = 'msg err'; out.textContent = e.message; } mk.disabled = false; } });
  root.append(box('Create backup', h('p', { text: 'Owner-only. The backup contains your full library encrypted with your password. Without the password it cannot be opened.' }), pw, mk, out));
  const file = h('input', { type: 'file', accept: '.tmbackup,application/octet-stream' }), pw2 = h('input', { type: 'password', placeholder: 'Backup password' }), out2 = h('p', { class: 'msg' });
  const act = async mode => {
    const f = file.files[0]; if (!f) { out2.className = 'msg err'; out2.textContent = 'Choose a .tmbackup file first'; return; } out2.className = 'msg'; out2.textContent = 'Checking…';
    try { const v = await verifyBackup(f, pw2.value, p => out2.textContent = 'Checking ' + p.done + '/' + p.total); if (!v.manifest) throw new Error(v.error);
      if (mode === 'verify') { out2.className = v.ok ? 'msg ok' : 'msg err'; out2.textContent = v.ok ? 'Backup is intact: ' + Object.keys(v.manifest.instruments).length + ' instruments, ' + v.total + ' samples.' : 'Damaged: ' + v.bad.length + ' corrupted, ' + v.missing.length + ' missing samples.'; return; }
      const conf = Object.keys(v.manifest.instruments).filter(id => lib.inst[id]); let replace = false;
      if (conf.length) { if (!confirm('These instruments already exist and will be REPLACED:\n' + conf.map(id => lib.inst[id].name).join(', ') + '\n\nContinue?')) { out2.textContent = 'Restore cancelled.'; return; } replace = true; }
      const r = await restoreBackup(f, pw2.value, lib, settings, { replaceExisting: replace, onProgress: p => out2.textContent = (p.phase === 'restore' ? 'Restoring ' : 'Verifying ') + p.done + '/' + p.total });
      samples.clear(); out2.className = 'msg ok'; out2.textContent = 'Restored ' + r.instruments + ' instruments (' + r.samples + ' samples).'; renderLibrary(); sync(); loadLayerBanks();
    } catch (e) { out2.className = 'msg err'; out2.textContent = e.message; } };
  root.append(box('Verify / restore backup', file, pw2, h('div', { class: 'row' }, h('button', { class: 'btn', text: 'Check integrity', onclick: () => act('verify') }), h('button', { class: 'btn primary', text: 'Restore', onclick: () => act('restore') })), out2,
    h('p', { text: 'Changed phone? Install ToneMaster, activate your owner licence for the new Device ID, then restore this file with your password.' })));
}
async function saveBlob(blob, name) {                              // customer builds never reach this for sample data – only settings / owner backups
  const nat = globalThis.ToneMasterNative; if (nat?.saveFile) { nat.saveFile(name, bytesToB64(new Uint8Array(await blob.arrayBuffer()))); return; }
  try { const file = new File([blob], name); if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 4000);
}
boot();
