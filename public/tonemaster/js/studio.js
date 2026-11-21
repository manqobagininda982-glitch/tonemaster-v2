// V2 Beat Studio UI: Beat Player, Installed Packs, Beat Pack Store, Sequencer, Recording Studio, Saved Projects, Audio Exports.
import { clamp, noteName, fmtBytes } from './util.js';
import { QUANT, newProject, newInstTrack, newBeatTrack, sanitizeProject, uid, lengthBeats } from './seq.js';
import { renderProject, encodeMp3 } from './render.js';

const SECTIONS = [['player', 'Beat Player'], ['installed', 'Installed Packs'], ['store', 'Beat Pack Store'], ['seq', 'Sequencer'], ['rec', 'Recording Studio'], ['projects', 'Saved Projects'], ['exports', 'Audio Exports']];

export function createStudio(x) {
  const { h, toast, engine, settings, samples, lib, storage, beats, player, seq, api, saveBlob, licence } = x;
  let section = 'player', sel = { pack: null, folder: null }, editTrack = null, rollBase = 48, noteLen = 1, exporting = false, storeBusy = false, raf = 0;
  const root = document.querySelector('#beatsBody');
  const sgn = n => (n > 0 ? '+' : '') + n;
  const instName = id => lib.get(id)?.name || 'Missing instrument';

  /* ---------- persistence: projects (editable), takes (recordings), exports (MP3) ---------- */
  const idx = async k => (await storage.getMeta(k, [])) || [];
  async function saveDoc(kind, p) {
    p.updated = Date.now(); const key = kind + 's_index', list = await idx(key), clean = sanitizeProject(p); clean.kind = kind;
    await storage.putMeta(kind + ':' + p.id, clean); const i = list.findIndex(e => e.id === p.id), entry = { id: p.id, name: p.name, updated: p.updated, bars: p.bars, bpm: p.bpm, tracks: p.tracks.length };
    if (i >= 0) list[i] = entry; else list.unshift(entry); await storage.putMeta(key, list);
  }
  async function loadDoc(kind, id) { return storage.getMeta(kind + ':' + id, null); }
  async function deleteDoc(kind, id) { await storage.deleteMeta(kind + ':' + id); await storage.putMeta(kind + 's_index', (await idx(kind + 's_index')).filter(e => e.id !== id)); }
  async function renameDoc(kind, id, name) { const d = await loadDoc(kind, id); if (!d) return; d.name = name; await saveDoc(kind, d); if (seq.p.id === id) seq.p.name = name; }

  /* ---------- audio preparation ---------- */
  const banks = id => { const b = samples.bank(id); return b && b.samples.length ? b : null; };
  const beatBuf = (p, f, n) => beats.cached(p, f, n);
  async function prepare(p, onMsg = () => { }) {
    const insts = [...new Set(p.tracks.filter(t => t.type === 'inst').map(t => t.inst))];
    samples.pin([...settings.v.layers.filter(l => l.on).map(l => l.inst), ...insts]);
    for (const id of insts) { if (!lib.playable(id)) throw new Error('Instrument "' + instName(id) + '" is not installed on this phone'); onMsg('Loading ' + instName(id) + '…'); await samples.load(id); }
    for (const t of p.tracks.filter(t => t.type === 'beat')) for (const n of new Set(t.bars.filter(b => b != null))) { onMsg('Loading beat loop ' + n + '…'); await beats.buffer(t.packId, t.folder, n); }
  }

  /* ---------- shell ---------- */
  function render() {
    cancelAnimationFrame(raf); root.innerHTML = '';
    const nav = h('div', { class: 'seg studio-nav' }, SECTIONS.map(([k, label]) => h('button', { class: k === section ? 'on' : '', text: label, onclick: () => { section = k; render(); } })));
    const body = h('div', { class: 'studio-body' }); root.append(nav, body);
    ({ player: renderPlayer, installed: renderInstalled, store: renderStore, seq: renderSeq, rec: renderRec, projects: () => renderDocs('project'), exports: renderExports })[section](body);
  }
  const box = (title, ...k) => h('div', { class: 'box' }, h('h3', { text: title }), ...k);
  const empty = (msg, btn) => h('div', { class: 'box' }, h('p', { text: msg }), btn || '');

  /* ---------- Beat Player ---------- */
  function renderPlayer(body) {
    const packs = beats.list(); if (!packs.length) { body.append(empty('No beat packs installed yet. Open the Beat Pack Store to install one; installed packs play offline.', h('button', { class: 'btn primary', text: 'Open Beat Pack Store', onclick: () => { section = 'store'; render(); } }))); return; }
    if (!sel.pack || !beats.get(sel.pack)) sel = { pack: packs[0].id, folder: null };
    const folders = beats.folders(sel.pack); if (!sel.folder || !folders.some(f => f.name === sel.folder)) sel.folder = folders[0]?.name || null;
    const packSel = h('select', { onchange: () => { sel = { pack: packSel.value, folder: null }; render(); } }, packs.map(p => h('option', { value: p.id, text: p.name + ' · v' + p.version, selected: p.id === sel.pack })));
    const folderSeg = h('div', { class: 'chips' }, folders.map(f => h('button', { class: 'chip' + (f.name === sel.folder ? ' on' : ''), text: f.name + ' (' + f.loops.length + ')', onclick: () => { sel.folder = f.name; render(); } })));
    const have = beats.available(sel.pack, sel.folder), cur = player.cur, status = h('small', { class: 'muted', text: '' });
    const grid = h('div', { class: 'loopgrid' }, Array.from({ length: 15 }, (_, i) => {
      const n = i + 1, ok = have.has(n), on = cur && cur.packId === sel.pack && cur.folder === sel.folder && cur.n === n;
      return h('button', { class: 'loop' + (on ? ' on' : ''), disabled: !ok, 'aria-label': 'Loop ' + n + (ok ? '' : ' (not in this folder)'), text: String(n), onclick: async () => {
        if (!licence.active) { toast('Activate ToneMaster to play'); return; }
        if (on) { player.stop(); render(); return; }
        try { status.textContent = 'Loading loop ' + n + '…'; await player.play(sel.pack, sel.folder, n); render(); } catch (e) { status.textContent = 'Could not play: ' + e.message; }
      } });
    }));
    const tempoOut = h('b', { text: player.tempo ? player.tempo + ' BPM' : '—' });
    const tempo = h('input', { type: 'range', min: 40, max: 240, step: 1, value: player.tempo || 100 }); tempo.addEventListener('input', () => { player.setTempo(+tempo.value); tempoOut.textContent = player.tempo + ' BPM'; });
    const nat = cur ? player.nativeBpm(cur.lb) : null;
    body.append(box('Beat Player',
      h('div', { class: 'row' }, h('label', { text: 'Pack' }), packSel, h('span', { class: 'grow' }), h('button', { class: 'btn danger', text: '■ Stop', disabled: !cur, onclick: () => { player.stop(); render(); } })),
      folderSeg, grid, status,
      h('div', { class: 'ctl' }, h('label', {}, 'Beat tempo', tempoOut), tempo),
      h('div', { class: 'row' }, h('button', { class: 'btn sm', text: '−1', onclick: () => { player.setTempo((player.tempo || 100) - 1); render(); } }), h('button', { class: 'btn sm', text: '+1', onclick: () => { player.setTempo((player.tempo || 100) + 1); render(); } }),
        nat ? h('button', { class: 'btn sm', text: 'Original (' + nat + ')', onclick: () => { player.setTempo(nat); render(); } }) : '', h('small', { class: 'muted', text: 'Changing tempo speeds the loop up or down (its pitch moves with it).' })),
      h('p', { class: 'muted', text: 'Tap a number to start instantly. Tap another to switch on the same beat position; tap the playing one to stop. Greyed numbers are not in this folder. Keep playing your tones on top.' })));
    if (sel.folder) beats.preloadFolder(sel.pack, sel.folder, (d, t) => { if (status.isConnected && !status.textContent.startsWith('Could')) status.textContent = d < t ? 'Preparing loops ' + d + '/' + t + '…' : 'All loops ready'; });
  }

  /* ---------- Installed packs ---------- */
  function renderInstalled(body) {
    const packs = beats.list(); if (!packs.length) { body.append(empty('No beat packs installed.')); return; }
    body.append(h('div', { class: 'grid' }, packs.map(p => h('div', { class: 'card' }, h('h4', { text: p.name }), h('div', { class: 'meta', text: 'v' + p.version + ' · ' + p.folders.length + ' folder(s) · ' + p.folders.reduce((a, f) => a + f.loops.length, 0) + ' loops' + (p.bpm ? ' · ' + p.bpm + ' BPM' : '') }),
      h('div', { class: 'meta', text: 'Installed ' + new Date(p.at).toLocaleDateString() + ' · plays offline' }),
      h('div', { class: 'row' }, h('button', { class: 'btn', text: 'Play', onclick: () => { sel = { pack: p.id, folder: null }; section = 'player'; render(); } }),
        h('button', { class: 'btn danger', text: 'Remove', onclick: async () => { if (!confirm('Remove "' + p.name + '" from this phone? Projects using it will have silent beat bars until you reinstall it.')) return; if (player.cur?.packId === p.id) player.stop(); await beats.remove(p.id); toast(p.name + ' removed'); render(); } }))))));
  }

  /* ---------- Store ---------- */
  async function renderStore(body) {
    const list = h('div', { class: 'col' }, h('p', { class: 'muted', text: 'Connecting to the beat store…' }));
    body.append(box('Beat Pack Store', h('p', { class: 'muted', text: 'Uses internet only while this page is open. Installed packs are stored encrypted on this phone and play offline.' }), list, h('div', { class: 'row' }, h('button', { class: 'btn', text: 'Check again', onclick: render }))));
    let packs; try { packs = (await api.catalog('beat')).packs; } catch (e) { list.innerHTML = ''; list.append(h('p', { class: 'bad', text: 'No internet or the store is not reachable. Your installed packs still work offline.' }), h('p', { class: 'muted', text: String(e.message || e) })); return; }
    list.innerHTML = ''; if (!packs.length) { list.append(h('p', { class: 'muted', text: 'No beat packs are published yet.' })); return; }
    for (const p of packs) {
      const inst = beats.get(p.id), upd = inst && String(inst.version) !== String(p.version), loops = (p.manifest?.folders || []).reduce((a, f) => a + f.loops.length, 0);
      const st = h('small', { text: inst ? (upd ? 'Newer version available: v' + inst.version + ' → v' + p.version : 'Installed · v' + inst.version) : 'Not installed' }), bar = h('i'), prog = h('div', { class: 'prog', hidden: true }, bar);
      const btn = h('button', { class: 'btn ' + (!inst || upd ? 'primary' : ''), text: !inst ? 'Install' : upd ? 'Update' : 'Reinstall' });
      btn.onclick = async () => {
        if (storeBusy) return toast('Wait for the current download to finish'); storeBusy = true; prog.hidden = false; list.querySelectorAll('.btn').forEach(b => b.disabled = true);
        try {
          st.textContent = 'Downloading…'; const blob = await api.download(p.id, 'pack', (g, t) => { bar.style.width = (t ? g / t * 100 : 50) + '%'; st.textContent = 'Downloading ' + fmtBytes(g) + (t ? ' of ' + fmtBytes(t) : ''); });
          st.textContent = 'Checking and installing…'; bar.style.width = '0%';
          if (player.cur?.packId === p.id) player.stop();
          await beats.install(p, blob, (d, t) => { bar.style.width = d / t * 100 + '%'; st.textContent = 'Installing ' + d + '/' + t; });
          toast(p.name + ' installed'); storeBusy = false; render(); return;
        } catch (e) { st.textContent = 'Failed: ' + (e.message || e); st.className = 'bad'; }
        storeBusy = false; list.querySelectorAll('.btn').forEach(b => b.disabled = false);
      };
      list.append(h('div', { class: 'store-row' }, h('div', { class: 'grow' }, h('b', { text: p.name }), h('small', { text: 'v' + p.version + ' · ' + fmtBytes(p.file_size || 0) + ' · ' + (p.manifest?.folders || []).length + ' folders · ' + loops + ' loops' + (p.bpm ? ' · ' + p.bpm + ' BPM' : '') + (p.description ? ' · ' + p.description : '') }), st, prog), btn));
    }
  }

  /* ---------- Sequencer ---------- */
  function ensureProject() { if (!seq.p.tracks.length && !seq.p._touched) { const L = settings.v.layers[0]; if (L.inst && lib.get(L.inst)) seq.p.tracks.push(newInstTrack(L.inst, instName(L.inst))); seq.p._touched = true; } }
  function transportBar(opts = {}) {
    const p = seq.p, bpmOut = h('b', { text: p.bpm + ' BPM' });
    const play = h('button', { class: 'btn primary', text: seq.playing ? '❚❚ Pause' : '▶ Play', onclick: async () => {
      if (seq.playing) { seq.pause(); render(); return; } if (!licence.active) return toast('Activate ToneMaster to play');
      try { player.stop(); await prepare(p, m => play.textContent = m); seq.play(); render(); } catch (e) { toast(e.message, 4000); render(); } } });
    const quant = h('select', { onchange: () => { p.quant = quant.value; } }, Object.keys(QUANT).map(q => h('option', { value: q, text: q === 'off' ? 'Quantise off' : 'Quantise ' + q, selected: p.quant === q })));
    const bars = h('select', { onchange: () => { p.bars = +bars.value; render(); } }, [1, 2, 4, 8, 12, 16, 24, 32].map(b => h('option', { value: b, text: b + ' bars', selected: p.bars === b })));
    return h('div', { class: 'bar transport' }, play, h('button', { class: 'btn', text: '■ Stop', onclick: () => { seq.stop(); render(); } }),
      h('button', { class: 'btn toggle' + (p.loop ? ' on' : ''), text: '⟲ Loop', onclick: () => { p.loop = !p.loop; render(); } }),
      opts.rec !== false ? h('button', { class: 'btn danger' + (seq.recording ? ' on' : ''), text: seq.recording ? '● Recording… (stop)' : '● Record notes', onclick: () => toggleRec() }) : '',
      h('div', { class: 'stepper' }, h('span', { text: 'Tempo' }), h('button', { text: '−', onclick: () => { seq.setBpm(p.bpm - 1); bpmOut.textContent = p.bpm + ' BPM'; } }), bpmOut, h('button', { text: '+', onclick: () => { seq.setBpm(p.bpm + 1); bpmOut.textContent = p.bpm + ' BPM'; } })),
      quant, bars, h('span', { class: 'pos', id: 'seqPos', text: '1.1' }));
  }
  /** Records the Play screen's active layers (Dual/Split → one track per layer, each keeps its own instrument). */
  async function toggleRec(intoTake = false) {
    if (seq.recording) { seq.pause(); render(); return; } if (!licence.active) return toast('Activate ToneMaster to record');
    const v = settings.v, used = { single: [0], dual: [0, 1], split: [0, 1], mainDual: [0, 1, 2], mainSplit: [0, 1, 2] }[v.mode].filter(i => v.layers[i].on && v.layers[i].inst && lib.get(v.layers[i].inst));
    if (!used.length) return toast('Choose a tone on the Play screen first (TONES)');
    const ids = {}; for (const i of used) { const L = v.layers[i]; const t = newInstTrack(L.inst, instName(L.inst)); t.tr = 12 * L.oct + L.tr; t.vol = L.vol / Math.sqrt(used.length); seq.p.tracks.push(t); ids[i] = t.id; }
    if (intoTake && player.cur && !seq.p.tracks.some(t => t.type === 'beat')) { const c = player.cur, bt = newBeatTrack(c.packId, c.folder, (beats.get(c.packId)?.name || 'Beat') + ' · ' + c.folder); bt.bars = Array(seq.p.bars).fill(c.n); seq.p.tracks.unshift(bt); seq.p.bpm = player.tempo || seq.p.bpm; }
    try { player.stop(); await prepare(seq.p); } catch (e) { toast(e.message, 4000); return; }
    seq.onRecordEnd = async () => { const added = seq.p.tracks.filter(t => Object.values(ids).includes(t.id)); for (const t of added) if (!t.events.length) seq.p.tracks.splice(seq.p.tracks.indexOf(t), 1); if (intoTake) { await saveDoc('take', seq.p); toast('Take saved'); } render(); };
    seq.startRecording(n => engine.layersFor(n).filter(i => ids[i]).map(i => ids[i])); render();
    toast('Recording — play on your keyboard. Stop to finish.');
  }
  function renderSeq(body) {
    ensureProject(); const p = seq.p;
    const name = h('input', { value: p.name, onchange: () => { p.name = name.value.trim() || 'Untitled project'; } });
    body.append(h('div', { class: 'row' }, name, h('button', { class: 'btn', text: '＋ New', onclick: () => { if (confirm('Start a new empty project? Unsaved changes are lost.')) { seq.load(newProject('Untitled project', p.bpm)); seq.p._touched = true; editTrack = null; render(); } } }),
      h('button', { class: 'btn', text: '💾 Save project', onclick: async () => { await saveDoc('project', p); toast('Project saved'); } }),
      h('button', { class: 'btn primary', text: '⤓ Export MP3', onclick: () => exportMp3(p) })), transportBar());
    const tracks = h('div', { class: 'tracks' });
    for (const t of p.tracks) {
      const vol = h('input', { type: 'range', min: 0, max: 1.2, step: 0.01, value: t.vol }); vol.addEventListener('input', () => { t.vol = +vol.value; seq.refreshMix(); });
      const nameIn = h('input', { class: 'tname', value: t.name, onchange: () => { t.name = nameIn.value; } });
      const instSel = t.type === 'inst' ? h('select', { onchange: async () => { t.inst = instSel.value; try { await samples.load(t.inst); } catch { } } }, lib.list().map(i => h('option', { value: i.id, text: i.name, selected: i.id === t.inst })), lib.get(t.inst) ? '' : h('option', { value: t.inst, text: 'Missing instrument', selected: true })) : h('small', { class: 'muted', text: (beats.get(t.packId)?.name || 'Pack not installed') + ' · ' + t.folder });
      tracks.append(h('div', { class: 'track' + (editTrack === t.id ? ' on' : '') + (t.type === 'beat' ? ' beat' : '') },
        h('button', { class: 'btn sm', text: editTrack === t.id ? 'Editing' : 'Edit', onclick: () => { editTrack = t.id; render(); } }), nameIn, instSel,
        h('div', { class: 'ctl tvol' }, h('label', {}, 'Vol', h('b', { text: Math.round(t.vol * 100) + '%' })), vol),
        t.type === 'inst' ? h('div', { class: 'stepper' }, h('span', { text: 'Tr' }), h('button', { text: '−', onclick: () => { t.tr = clamp(t.tr - 1, -24, 24); render(); } }), h('b', { text: sgn(t.tr) }), h('button', { text: '+', onclick: () => { t.tr = clamp(t.tr + 1, -24, 24); render(); } })) : '',
        h('button', { class: 'btn sm toggle' + (t.mute ? ' on' : ''), text: 'M', title: 'Mute', onclick: () => { t.mute = !t.mute; seq.refreshMix(); render(); } }),
        h('button', { class: 'btn sm toggle' + (t.solo ? ' on' : ''), text: 'S', title: 'Solo', onclick: () => { t.solo = !t.solo; seq.refreshMix(); render(); } }),
        h('button', { class: 'btn sm danger', text: '🗑', title: 'Delete track', onclick: () => { if (!confirm('Delete track "' + t.name + '"?')) return; p.tracks.splice(p.tracks.indexOf(t), 1); if (editTrack === t.id) editTrack = null; render(); } })));
    }
    const addInst = h('button', { class: 'btn', text: '＋ Instrument track', onclick: () => { const L = settings.v.layers[0], id = (L.inst && lib.get(L.inst)) ? L.inst : lib.list()[0]?.id; if (!id) return toast('Install a tone first (TONES)'); const t = newInstTrack(id, instName(id)); p.tracks.push(t); editTrack = t.id; render(); } });
    const addBeat = h('button', { class: 'btn', text: '＋ Beat track', onclick: () => { const pk = beats.list()[0]; if (!pk) return toast('Install a beat pack first'); const c = player.cur; const t = newBeatTrack(c?.packId || pk.id, c?.folder || pk.folders[0].name); t.name = (beats.get(t.packId)?.name || 'Beat') + ' · ' + t.folder; t.bars = Array(p.bars).fill(c?.n || [...beats.available(t.packId, t.folder)][0] || null); p.tracks.unshift(t); editTrack = t.id; render(); } });
    body.append(box('Tracks', tracks, h('div', { class: 'row' }, addInst, addBeat, h('button', { class: 'btn', text: 'Duplicate bars (×2 pattern)', onclick: () => duplicatePattern(p) }))));
    const t = p.tracks.find(x => x.id === editTrack) || p.tracks[0]; if (t) { editTrack = t.id; body.append(t.type === 'inst' ? noteGrid(p, t) : beatBars(p, t)); }
    startPlayhead();
  }
  function duplicatePattern(p) {
    if (p.bars * 2 > 64) return toast('Maximum 64 bars'); const L = lengthBeats(p);
    for (const t of p.tracks) { if (t.type === 'inst') t.events = t.events.concat(t.events.filter(e => e.t < L).map(e => ({ ...e, t: e.t + L }))); else t.bars = Array.from({ length: p.bars * 2 }, (_, i) => t.bars[i % p.bars] ?? null); }
    p.bars *= 2; render();
  }
  function beatBars(p, t) {
    const folders = beats.folders(t.packId), have = beats.available(t.packId, t.folder);
    const fSel = h('select', { onchange: () => { t.folder = fSel.value; t.name = (beats.get(t.packId)?.name || 'Beat') + ' · ' + t.folder; const ok = beats.available(t.packId, t.folder); t.bars = t.bars.map(b => (b != null && ok.has(b) ? b : null)); render(); } }, folders.map(f => h('option', { value: f.name, text: f.name, selected: f.name === t.folder })));
    const pSel = h('select', { onchange: () => { t.packId = pSel.value; t.folder = beats.folders(t.packId)[0]?.name; t.bars = t.bars.map(() => null); render(); } }, beats.list().map(pk => h('option', { value: pk.id, text: pk.name, selected: pk.id === t.packId })));
    const cells = Array.from({ length: p.bars }, (_, i) => { const s = h('select', { onchange: () => { t.bars[i] = s.value ? +s.value : null; } }, h('option', { value: '', text: '—' }), Array.from({ length: 15 }, (_, k) => h('option', { value: k + 1, text: 'Loop ' + (k + 1), disabled: !have.has(k + 1), selected: t.bars[i] === k + 1 }))); return h('div', { class: 'barcell' }, h('small', { text: 'Bar ' + (i + 1) }), s); });
    return box('Beat track · loop per bar', h('div', { class: 'row' }, pSel, fSel), h('div', { class: 'barcells' }, cells), h('p', { class: 'muted', text: 'Only loops that exist in this folder can be chosen. The loop follows the project tempo and starts exactly on each bar line.' }));
  }
  function noteGrid(p, t) {
    const q = QUANT[p.quant] || 0.25, steps = Math.round(lengthBeats(p) / q), rows = 24, top = rollBase + rows - 1;
    const roll = h('div', { class: 'roll', style: '--steps:' + steps + ';--rows:' + rows });
    for (let r = 0; r < rows; r++) { const n = top - r; roll.append(h('div', { class: 'rk' + ([1, 3, 6, 8, 10].includes(n % 12) ? ' blk' : ''), style: 'grid-row:' + (r + 1), text: n % 12 === 0 ? noteName(n) : '' })); }
    const area = h('div', { class: 'rarea', style: 'grid-row:1/' + (rows + 1) });
    for (let s = 0; s <= steps; s += Math.round(1 / q)) area.append(h('i', { class: 'beatline' + ((s * q) % 4 === 0 ? ' bar' : ''), style: 'left:' + (s / steps * 100) + '%' }));
    t.events.forEach((e, k) => { if (e.n > top || e.n < rollBase || e.t >= lengthBeats(p)) return; area.append(h('b', { class: 'note', title: noteName(e.n) + ' vel ' + e.v, style: 'left:' + (e.t / lengthBeats(p) * 100) + '%;width:' + Math.max(0.6, Math.min(e.d, lengthBeats(p) - e.t) / lengthBeats(p) * 100) + '%;top:' + ((top - e.n) / rows * 100) + '%;height:' + (100 / rows) + '%', 'data-k': k })); });
    area.append(h('i', { class: 'playhead', id: 'playhead' }));
    area.addEventListener('pointerdown', ev => {
      if (!licence.active) return toast('Activate ToneMaster to play');
      const nk = ev.target.closest('.note'); if (nk) { t.events.splice(+nk.dataset.k, 1); render(); return; }
      const r = area.getBoundingClientRect(), col = Math.floor((ev.clientX - r.left) / r.width * steps), row = Math.floor((ev.clientY - r.top) / r.height * rows); if (col < 0 || row < 0 || row >= rows) return;
      const n = top - row; t.events.push({ t: col * q, d: q * noteLen, n, v: 100 }); const b = banks(t.inst); if (b) { engine.build(); const { Engine } = x; Engine.scheduleVoice(engine.ensure(), b, engine.soundingFor(n, t.tr), 100, engine.ensure().currentTime, 0.25, seq.gainFor(t), 0.1); } render();
    });
    roll.append(area);
    const lenSel = h('select', { onchange: () => { noteLen = +lenSel.value; } }, [1, 2, 4, 8, 16].map(m => h('option', { value: m, text: 'Note length ×' + m + ' step', selected: noteLen === m })));
    return box('Notes · ' + t.name + ' (' + instName(t.inst) + ')', h('div', { class: 'row' }, h('button', { class: 'btn sm', text: '▲ Higher', onclick: () => { rollBase = clamp(rollBase + 12, 0, 103); render(); } }), h('button', { class: 'btn sm', text: '▼ Lower', onclick: () => { rollBase = clamp(rollBase - 12, 0, 103); render(); } }), lenSel,
      h('button', { class: 'btn sm', text: 'Quantise all notes', onclick: () => { const qq = QUANT[p.quant]; if (!qq) return; t.events.forEach(e => { e.t = Math.round(e.t / qq) * qq; }); render(); } }), h('button', { class: 'btn sm danger', text: 'Clear notes', onclick: () => { if (confirm('Clear all notes on this track?')) { t.events = []; render(); } } }), h('small', { class: 'muted', text: t.events.length + ' notes · tap the grid to add, tap a note to delete' })), h('div', { class: 'rollwrap' }, roll));
  }
  function startPlayhead() {
    const tick = () => { const ph = document.getElementById('playhead'), pos = document.getElementById('seqPos'); if (!pos && !ph) return; const b = seq.position(), L = lengthBeats(seq.p);
      if (ph) ph.style.left = (b / L * 100) + '%'; if (pos) pos.textContent = (Math.floor(b / 4) + 1) + '.' + (Math.floor(b % 4) + 1); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
  }

  /* ---------- Recording Studio ---------- */
  async function renderRec(body) {
    const takes = await idx('takes_index');
    const recName = seq.p.kind === 'take' ? seq.p.name : null;
    body.append(box('Record a take',
      h('p', { class: 'muted', text: 'Records what you play (MIDI keyboard or on-screen keys) as editable notes, with the beat that is playing in the Beat Player. Dual/Split layers are recorded as separate tracks, each keeping its own instrument (e.g. Strings + Fretless Bass).' }),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', text: seq.recording ? '■ Stop recording' : '● New take', onclick: async () => { if (seq.recording) { seq.pause(); render(); return; } const bars = +barsSel.value; seq.load({ ...newProject('Take ' + new Date().toLocaleString(), player.tempo || 100), bars, loop: false, quant: 'off' }); seq.p.kind = 'take'; await toggleRec(true); } }),
        recName && !seq.recording ? h('button', { class: 'btn', text: '● Record another layer on "' + recName + '"', onclick: async () => { seq.p.loop = false; seq.stop(); await toggleRec(true); } }) : ''),
      (() => { var s = h('select', {}, [2, 4, 8, 16, 32].map(b => h('option', { value: b, text: b + ' bars', selected: b === 8 }))); barsSel = s; return h('div', { class: 'row' }, h('label', { text: 'Take length' }), s, h('small', { class: 'muted', text: 'Tip: start a beat in the Beat Player first. Choose your tone(s) on the Play screen (Dual mode for two instruments).' })); })()));
    var barsSel;
    if (!takes.length) { body.append(empty('No takes yet.')); return; }
    body.append(box('Takes', h('div', { class: 'list' }, takes.map(tk => docRow('take', tk)))));
  }
  function docRow(kind, d) {
    return h('div', { class: 'store-row' }, h('div', { class: 'grow' }, h('b', { text: d.name }), h('small', { text: d.bars + ' bars · ' + d.bpm + ' BPM · ' + d.tracks + ' track(s) · ' + new Date(d.updated).toLocaleString() })),
      h('button', { class: 'btn', text: '▶ Listen', onclick: async () => { const doc = await loadDoc(kind, d.id); if (!doc) return toast('Could not open'); seq.load(doc); seq.p.kind = kind; try { player.stop(); await prepare(seq.p); seq.play(0); toast('Playing ' + d.name); } catch (e) { toast(e.message, 4000); } } }),
      h('button', { class: 'btn', text: '■', title: 'Stop', onclick: () => seq.stop() }),
      h('button', { class: 'btn', text: 'Open in Sequencer', onclick: async () => { const doc = await loadDoc(kind, d.id); if (!doc) return toast('Could not open'); seq.load(doc); seq.p.kind = kind; seq.p._touched = true; editTrack = null; section = 'seq'; render(); } }),
      kind === 'take' ? h('button', { class: 'btn', text: 'Save as project', onclick: async () => { const doc = await loadDoc(kind, d.id); doc.id = uid(); await saveDoc('project', doc); toast('Saved to projects'); } }) : '',
      h('button', { class: 'btn', text: '⤓ MP3', onclick: async () => { const doc = await loadDoc(kind, d.id); exportMp3(sanitizeProject(doc)); } }),
      h('button', { class: 'btn', text: 'Rename', onclick: async () => { const n = prompt('New name', d.name); if (n?.trim()) { await renameDoc(kind, d.id, n.trim()); render(); } } }),
      h('button', { class: 'btn danger', text: 'Delete', onclick: async () => { if (!confirm('Delete "' + d.name + '"?')) return; if (seq.p.id === d.id) seq.stop(); await deleteDoc(kind, d.id); render(); } }));
  }
  async function renderDocs(kind) {
    const body = root.querySelector('.studio-body'), list = await idx(kind + 's_index');
    if (!list.length) { body.append(empty('No saved projects yet. Build one in the Sequencer and press Save project.')); return; }
    body.append(box('Saved projects', h('div', { class: 'list' }, list.map(d => docRow(kind, d)))));
  }

  /* ---------- Export ---------- */
  async function exportMp3(p) {
    if (exporting) return; if (!licence.active) return toast('Activate ToneMaster to export'); exporting = true;
    const dlg = document.querySelector('#exportModal'), msg = dlg.querySelector('.msg'), bar = dlg.querySelector('.prog i'); dlg.hidden = false; msg.className = 'msg'; bar.style.width = '0%';
    try {
      msg.textContent = 'Loading sounds…'; await prepare(p, m => msg.textContent = m);
      msg.textContent = 'Rendering audio (high quality, 44.1 kHz stereo)…'; const r = await renderProject(p, { banks, beatBuffer: beatBuf, settings: settings.v });
      msg.textContent = 'Encoding MP3 256 kbps…'; const blob = await encodeMp3(r.buffer, { kbps: 256, onProgress: f => bar.style.width = (f * 100) + '%' });
      const id = uid(), name = (p.name || 'ToneMaster').replace(/[^\w .-]+/g, '_').slice(0, 60) + '.mp3';
      await storage.putSample('mp3:' + id, new Uint8Array(await blob.arrayBuffer()), { kind: 'mp3' });
      const list = await idx('exports_index'); list.unshift({ id, name, size: blob.size, seconds: +r.buffer.duration.toFixed(1), created: Date.now(), limited: r.gain < 1 }); await storage.putMeta('exports_index', list);
      msg.className = 'msg ok'; msg.textContent = 'Done: ' + name + ' · ' + fmtBytes(blob.size) + (r.gain < 1 ? ' · level reduced ' + (20 * Math.log10(r.gain)).toFixed(1) + ' dB to avoid clipping' : '');
      await saveBlob(blob, name);
    } catch (e) { msg.className = 'msg err'; msg.textContent = 'Export failed: ' + (e.message || e); }
    exporting = false;
  }
  async function renderExports(body) {
    const list = await idx('exports_index'); if (!list.length) { body.append(empty('No MP3 exports yet. Use Export MP3 in the Sequencer or on a take.')); return; }
    const audio = h('audio', { controls: true, class: 'expaudio' });
    body.append(box('Audio exports', audio, h('div', { class: 'list' }, list.map(e => h('div', { class: 'store-row' }, h('div', { class: 'grow' }, h('b', { text: e.name }), h('small', { text: fmtBytes(e.size) + ' · ' + e.seconds + ' s · MP3 256 kbps · ' + new Date(e.created).toLocaleString() })),
      h('button', { class: 'btn', text: '▶ Listen', onclick: async () => { const u8 = await storage.getSample('mp3:' + e.id); if (audio.src) URL.revokeObjectURL(audio.src); audio.src = URL.createObjectURL(new Blob([u8], { type: 'audio/mpeg' })); audio.play(); } }),
      h('button', { class: 'btn', text: 'Save / share', onclick: async () => saveBlob(new Blob([await storage.getSample('mp3:' + e.id)], { type: 'audio/mpeg' }), e.name) }),
      h('button', { class: 'btn danger', text: 'Delete', onclick: async () => { if (!confirm('Delete ' + e.name + '?')) return; await storage.deleteSample('mp3:' + e.id); await storage.putMeta('exports_index', (await idx('exports_index')).filter(z => z.id !== e.id)); render(); } }))))));
  }

  seq.onTick = (pos, ended) => { if (ended) render(); };
  player.onChange = () => { if (section !== 'player') return; const c = player.cur; root.querySelectorAll('.loopgrid button').forEach((b, i) => b.classList.toggle('on', !!c && c.packId === sel.pack && c.folder === sel.folder && c.n === i + 1)); };
  return { render, show: () => render(), get section() { return section; }, set section(v) { section = v; } };
}
