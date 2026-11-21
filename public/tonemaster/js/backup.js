// OWNER backup/restore. Password-encrypted (PBKDF2-SHA256 → AES-256-GCM per record), integrity-checked, portable between devices.
// Format: "TMBK1\0" | u32 headerLen | header JSON {salt,iter,count,created} | records: u32 len | iv(12) | ciphertext
// Record 0 = manifest (instrument/index/status/settings JSON). Records 1..n = [u32 infoLen][info JSON][original WAV bytes].
import { sanitize } from './settings.js';
import { enc, dec, u32, concat, sha256, b64, unb64, yieldUI } from './util.js';
const MAGIC = enc.encode('TMBK1\0'), ITER = 400000;
const aad = (i, n) => enc.encode('tmbk1:' + i + ':' + n);
async function deriveKey(pw, salt, iter) { const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']); return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
async function seal(key, plain, i, n) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(i, n) }, key, plain)); return concat([u32(12 + ct.length), iv, ct]); }

export async function createBackup(lib, settings, password, onProgress = () => { }) {
  if (!password || password.length < 8) throw new Error('Use a backup password of at least 8 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16)), key = await deriveKey(password, salt, ITER), ids = Object.keys(lib.index), n = ids.length + 1;
  const header = enc.encode(JSON.stringify({ v: 1, salt: b64(salt), iter: ITER, count: n, created: new Date().toISOString(), app: 'ToneMaster' }));
  const parts = [MAGIC, u32(header.length), header];
  parts.push(await seal(key, enc.encode(JSON.stringify({ instruments: lib.inst, index: lib.index, status: lib.status, settings: settings.v })), 0, n));
  for (let i = 0; i < ids.length; i++) {
    const info = enc.encode(JSON.stringify(lib.index[ids[i]])), wav = await lib.s.getSample(ids[i]);
    parts.push(await seal(key, concat([u32(info.length), info, wav]), i + 1, n)); onProgress({ done: i + 1, total: ids.length, name: lib.index[ids[i]].name }); if (i % 3 === 0) await yieldUI();
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}
async function* records(blob, password) {
  const head = new Uint8Array(await blob.slice(0, MAGIC.length + 4).arrayBuffer());
  if (dec.decode(head.subarray(0, 5)) !== 'TMBK1') throw new Error('Not a ToneMaster backup file');
  const hl = new DataView(head.buffer).getUint32(MAGIC.length), hdr = JSON.parse(dec.decode(new Uint8Array(await blob.slice(MAGIC.length + 4, MAGIC.length + 4 + hl).arrayBuffer())));
  const key = await deriveKey(password, unb64(hdr.salt), hdr.iter); let pos = MAGIC.length + 4 + hl; yield { header: hdr };
  for (let i = 0; i < hdr.count; i++) {
    if (pos + 4 > blob.size) throw new Error('Backup is truncated (record ' + i + ' missing)');
    const len = new DataView(await blob.slice(pos, pos + 4).arrayBuffer()).getUint32(0), body = new Uint8Array(await blob.slice(pos + 4, pos + 4 + len).arrayBuffer()); pos += 4 + len;
    if (body.length !== len) throw new Error('Backup is truncated');
    let plain; try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: body.subarray(0, 12), additionalData: aad(i, hdr.count) }, key, body.subarray(12))); }
    catch { yield { index: i, error: i === 0 ? 'WRONG_PASSWORD' : 'CORRUPT' }; continue; }
    yield { index: i, plain };
  }
}
/** Check password + integrity of every record without touching the library. */
export async function verifyBackup(blob, password, onProgress = () => { }) {
  let manifest = null, header = null, total = 0; const bad = [], okIds = new Set();
  for await (const r of records(blob, password)) {
    if (r.header) { header = r.header; total = r.header.count - 1; continue; }
    if (r.index === 0) { if (r.error) return { ok: false, error: 'Wrong password, or the backup header is damaged.' }; manifest = JSON.parse(dec.decode(r.plain)); continue; }
    if (r.error) { bad.push({ index: r.index, reason: 'failed authentication (corrupted)' }); continue; }
    const il = new DataView(r.plain.buffer, r.plain.byteOffset).getUint32(0), info = JSON.parse(dec.decode(r.plain.subarray(4, 4 + il))), wav = r.plain.subarray(4 + il);
    if (await sha256(wav) !== info.hash) bad.push({ index: r.index, id: info.id, reason: 'hash mismatch' }); else okIds.add(info.id);
    onProgress({ done: r.index, total }); if (r.index % 3 === 0) await yieldUI();
  }
  const missing = manifest ? Object.keys(manifest.index).filter(id => !okIds.has(id)) : [];
  return { ok: !bad.length && !missing.length, header, manifest, total, bad, missing };
}
/** Restore. Caller must confirm replacement first (see conflicts in verifyBackup().manifest vs lib.inst). */
export async function restoreBackup(blob, password, lib, settings, { replaceExisting = false, restoreSettings = true, onProgress = () => { } } = {}) {
  const v = await verifyBackup(blob, password, p => onProgress({ phase: 'verify', ...p })); if (!v.manifest) throw new Error(v.error || 'Backup unreadable');
  if (!v.ok) throw new Error('Backup failed integrity check (' + (v.bad.length + v.missing.length) + ' damaged samples). Restore cancelled; nothing was changed.');
  const m = v.manifest, ids = Object.keys(m.instruments), conflicts = ids.filter(id => lib.inst[id]);
  if (conflicts.length && !replaceExisting) { throw Object.assign(new Error('Backup contains instruments that already exist'), { conflicts }); }
  for (const id of conflicts) await lib.deleteInstrument(id);
  let done = 0;
  for await (const r of records(blob, password)) {
    if (r.header || r.index === 0) continue;
    const il = new DataView(r.plain.buffer, r.plain.byteOffset).getUint32(0), info = JSON.parse(dec.decode(r.plain.subarray(4, 4 + il))), wav = r.plain.slice(4 + il), { id, ...rest } = info;
    await lib.s.putSample(id, wav, rest); lib.index[id] = { ...info }; onProgress({ phase: 'restore', done: ++done, total: v.total }); if (done % 3 === 0) await yieldUI();
  }
  for (const id of ids) { lib.inst[id] = m.instruments[id]; lib.status[id] = m.status[id] || { state: 'installed' }; }
  await lib.save(); if (restoreSettings && m.settings) { settings.v = sanitize(m.settings); await settings.save(); }
  return { instruments: ids.length, samples: done, replaced: conflicts };
}
