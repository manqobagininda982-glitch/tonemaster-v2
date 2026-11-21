// MIDI input: Web MIDI (Chrome/Android Chrome/TWA) and the optional native bridge (Android WebView wrapper).
// Honest status: reports exactly what is available; never fakes a connection.
export class MidiManager {
  constructor(engine, settings) { this.e = engine; this.set = settings; this.access = null; this.inputs = new Map(); this.mode = 'none'; this.onChange = () => { }; this.onActivity = () => { }; this.error = ''; this.mapNote = n => n; }
  get supported() { return !!(globalThis.navigator?.requestMIDIAccess) || !!globalThis.ToneMasterNative?.hasMidi?.(); }
  get statusText() { if (!this.supported) return 'MIDI unavailable in this app shell'; if (this.error) return this.error; const n = this.inputs.size; return n ? n + (n === 1 ? ' device: ' : ' devices: ') + [...this.inputs.values()].map(x => x.name).join(', ') : 'No USB MIDI device detected'; }
  async start() {
    this.error = '';
    const nat = globalThis.ToneMasterNative;
    if (nat?.hasMidi?.()) {                                     // native bridge: Kotlin MidiManager → JS
      this.mode = 'native'; globalThis.ToneMasterMidi = {
        message: (id, status, d1, d2) => this.handle(id, status, d1, d2),
        devices: json => { const list = JSON.parse(json); const old = new Set(this.inputs.keys()); this.inputs = new Map(list.map(d => [d.id, { id: d.id, name: d.name }]));
          for (const id of old) if (!this.inputs.has(id)) this.e.allNotesOff('m:' + id); this.onChange(); } };
      nat.startMidi(); this.onChange(); return true;
    }
    if (!navigator.requestMIDIAccess) { this.mode = 'none'; this.error = 'This app shell cannot access USB MIDI (see README → USB MIDI)'; this.onChange(); return false; }
    try { this.access = await navigator.requestMIDIAccess({ sysex: false }); this.mode = 'web'; }
    catch (e) { this.error = 'MIDI permission denied or failed: ' + e.message; this.onChange(); return false; }
    this.access.onstatechange = ev => { const p = ev.port; if (p.type === 'input' && p.state === 'disconnected') this.e.allNotesOff('m:' + p.id); this.refresh(); };
    this.refresh(); return true;
  }
  refresh() {
    if (!this.access) return; const seen = new Set();
    this.access.inputs.forEach(inp => { if (inp.state === 'connected' || inp.state === undefined) { seen.add(inp.id); this.inputs.set(inp.id, { id: inp.id, name: inp.name || 'MIDI device' }); inp.onmidimessage = ev => this.handle(inp.id, ev.data[0], ev.data[1], ev.data[2]); } });
    for (const id of [...this.inputs.keys()]) if (!seen.has(id)) { this.inputs.delete(id); this.e.allNotesOff('m:' + id); }   // disconnect → no stuck notes
    this.onChange();
  }
  handle(devId, status, d1, d2) {
    const pref = this.set.v.midi; if (pref.device !== 'all' && pref.device !== devId) return;
    const cmd = status & 0xF0, ch = status & 0x0F; if (status >= 0xF0) return;
    if (pref.channel && ch !== pref.channel - 1) return; const src = 'm:' + devId;
    if (cmd === 0x90 && d2 > 0) { this.e.noteOn(d1, d2, src, ch); this.onActivity(d1, true); }
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) { this.e.noteOff(d1, src, ch); this.onActivity(d1, false); }
    else if (cmd === 0xB0) { if (d1 === 64) this.e.sustain(d2 >= 64, src, ch); else if (d1 === 123 || d1 === 120) this.e.allNotesOff(src); }
  }
}
