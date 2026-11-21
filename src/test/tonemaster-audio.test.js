// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Engine } from '../../public/tonemaster/js/engine.js';
import { Sequencer, newProject, newInstTrack, audibleTracks, quantize } from '../../public/tonemaster/js/seq.js';
import { BeatLibrary } from '../../public/tonemaster/js/beats.js';
import { Settings } from '../../public/tonemaster/js/settings.js';

describe('ToneMaster musical rules', () => {
  it('applies transpose to sounding notes without mutating source or recorded notes', () => {
    const settings = { v: { octave: 0, transpose: 3 } }, samples = {};
    const engine = new Engine(samples, settings), note = { n: 60 };
    expect(engine.soundingFor(note.n, 0)).toBe(63); expect(note.n).toBe(60);
    settings.v.transpose = 0; expect(engine.soundingFor(note.n, 0)).toBe(60);
  });
  it('records Strings and Fretless Bass as distinct tracks for a layered performance', () => {
    const seq = new Sequencer({}, {}), p = newProject();
    const strings = newInstTrack('STRINGS', 'Strings'), bass = newInstTrack('FRETLESS', 'Fretless Bass');
    p.tracks = [strings, bass]; p.quant = 'off'; seq.p = p; seq.recording = true; seq.playing = true;
    seq.route = () => [strings.id, bass.id]; let position = 0; seq.position = () => position;
    seq.noteOn(60, 100, 'midi', 1); position = 1; seq.noteOff(60, 'midi', 1);
    expect(strings.events).toEqual([{ t: 0, d: 1, n: 60, v: 100 }]);
    expect(bass.events).toEqual([{ t: 0, d: 1, n: 60, v: 100 }]);
    expect(strings.inst).toBe('STRINGS'); expect(bass.inst).toBe('FRETLESS');
  });
  it('keeps notes from different MIDI sources independent', () => {
    const seq = new Sequencer({}, {}), t = newInstTrack('STRINGS'); seq.p.tracks = [t]; seq.p.quant = 'off'; seq.recording = seq.playing = true; seq.route = () => [t.id]; let position = 0; seq.position = () => position;
    seq.noteOn(60, 100, 'a', 0); seq.noteOn(60, 90, 'b', 0); position = 1; seq.noteOff(60, 'a', 0);
    expect(seq.held.size).toBe(1); position = 2; seq.noteOff(60, 'b', 0); expect(t.events.map(e => e.d)).toEqual([1, 2]);
  });
  it('enables only real installed loops in a folder', () => {
    const b = new BeatLibrary({}, () => null); b.packs = { p: { folders: [{ name: 'A', loops: [{ n: 1 }, { n: 15 }] }, { name: 'B', loops: [{ n: 3 }] }] } };
    expect([...b.available('p', 'A')]).toEqual([1, 15]); expect([...b.available('p', 'B')]).toEqual([3]); expect([...b.available('p', 'Missing')]).toEqual([]);
  });
  it('honours mute and solo for simultaneous tracks', () => {
    const a = newInstTrack('a'), b = newInstTrack('b'), p = newProject(); p.tracks = [a, b];
    expect(audibleTracks(p)).toEqual([a, b]); b.solo = true; expect(audibleTracks(p)).toEqual([b]); b.mute = true; expect(audibleTracks(p)).toEqual([]);
  });
  it('quantizes notes to the selected musical division', () => { expect(quantize(0.31, '1/16')).toBe(0.25); expect(quantize(0.31, 'off')).toBe(0.31); });
  it('persists transpose and resets it to zero', async () => {
    let stored; const settings = new Settings({ putMeta: async (_k, v) => { stored = structuredClone(v); } });
    settings.set({ transpose: 7 }); await settings.save(); expect(stored.transpose).toBe(7);
    await settings.reset(); expect(stored.transpose).toBe(0);
  });
});