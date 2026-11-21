// Storage abstraction layer.
//  * NativeStorage  – Android private storage + Keystore via window.ToneMasterNative (see android-native/)
//  * BrowserStorage – IndexedDB + AES-256-GCM with a NON-EXTRACTABLE CryptoKey (browser fallback)
//  * MemoryRaw      – in-memory backend used only by tests
// Every sample is encrypted at rest. Raw WAV URLs never exist; plaintext only lives in memory during import/decoding.
import { enc, dec, b64, unb64, sha256, hex } from './util.js';

const DB_NAME = 'tonemaster-v1', STORES = ['samples', 'meta', 'keys'];

export class MemoryRaw {
  constructor() { this.s = { samples: new Map(), meta: new Map(), keys: new Map() }; }
  async get(st, k) { return this.s[st].get(k); } async put(st, k, v) { this.s[st].set(k, v); }
  async del(st, k) { this.s[st].delete(k); } async keys(st) { return [...this.s[st].keys()]; } async clear(st) { this.s[st].clear(); }
}
export class IdbRaw {
  constructor(name = DB_NAME) { this.name = name; this.db = null; }
  open() { return this.db ? Promise.resolve() : new Promise((res, rej) => { const r = indexedDB.open(this.name, 1);
    r.onupgradeneeded = () => STORES.forEach(s => r.result.createObjectStore(s)); r.onsuccess = () => { this.db = r.result; res(); }; r.onerror = () => rej(r.error); }); }
  tx(st, mode, fn) { return new Promise((res, rej) => { const t = this.db.transaction(st, mode), q = fn(t.objectStore(st)); t.oncomplete = () => res(q && q.result); t.onerror = t.onabort = () => rej(t.error); }); }
  get(st, k) { return this.tx(st, 'readonly', s => s.get(k)); } put(st, k, v) { return this.tx(st, 'readwrite', s => s.put(v, k)); }
  del(st, k) { return this.tx(st, 'readwrite', s => s.delete(k)); } keys(st) { return this.tx(st, 'readonly', s => s.getAllKeys()); } clear(st) { return this.tx(st, 'readwrite', s => s.clear()); }
}

const toId = (n) => { const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; let bits = '', out = ''; for (const b of n) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5), 2)]; return 'TM-' + out.match(/.{4}/g).join('-'); };

async function metaWrap(obj) { const body = JSON.stringify(obj); return { v: 1, body, sum: (await sha256(enc.encode(body))).slice(0, 16) }; }
async function metaUnwrap(w) { if (!w || typeof w.body !== 'string') throw new Error('meta missing'); if ((await sha256(enc.encode(w.body))).slice(0, 16) !== w.sum) throw new Error('meta checksum mismatch'); return JSON.parse(w.body); }

/** Browser backend: encryption lives here, raw store only ever sees ciphertext. */
export class BrowserStorage {
  constructor(raw, label = 'IndexedDB') { this.raw = raw; this.kind = raw instanceof MemoryRaw ? 'memory' : 'indexeddb'; this.label = label; this.key = null; this.deviceId = null; this.secure = false; }
  async init() {
    if (this.raw.open) await this.raw.open();
    let k = await this.raw.get('keys', 'aes');
    if (!k) { k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); await this.raw.put('keys', 'aes', k); }
    this.key = k;
    let id = await this.raw.get('keys', 'device'); if (!id) { id = toId(crypto.getRandomValues(new Uint8Array(10))); await this.raw.put('keys', 'device', id); }
    this.deviceId = id;
    try { if (navigator.storage?.persist) this.persisted = await navigator.storage.persist(); } catch { }
    return this;
  }
  async putSample(id, u8, info = {}) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('tm1:' + id) }, this.key, u8);
    await this.raw.put('samples', id, { v: 1, iv, ct, info });
  }
  async getSample(id) {
    const r = await this.raw.get('samples', id); if (!r) throw new Error('Sample not found: ' + id);
    try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: r.iv, additionalData: enc.encode('tm1:' + id) }, this.key, r.ct)); }
    catch { throw new Error('Sample failed integrity check (corrupted or wrong device key): ' + id); }
  }
  async hasSample(id) { return !!(await this.raw.get('samples', id)); }
  async deleteSample(id) { await this.raw.del('samples', id); }
  async listSamples() { const out = []; for (const id of await this.raw.keys('samples')) { const r = await this.raw.get('samples', id); out.push({ id, info: r?.info || {} }); } return out; }
  async wipeSamples() { await this.raw.clear('samples'); }
  async estimate() { try { const e = await navigator.storage.estimate(); return { used: e.usage, quota: e.quota }; } catch { return null; } }
  // metadata: checksummed, with automatic previous-version copy (".bak") for corruption recovery
  async putMeta(k, obj) { const old = await this.raw.get('meta', k); if (old) await this.raw.put('meta', k + '.bak', old); await this.raw.put('meta', k, await metaWrap(obj)); }
  async getMeta(k, fallback = null) {
    for (const key of [k, k + '.bak']) { const w = await this.raw.get('meta', key); if (!w) continue;
      try { const v = await metaUnwrap(w); if (key !== k) { this.recovered = (this.recovered || []).concat(k); await this.putMeta(k, v); } return v; } catch { this.corrupt = (this.corrupt || []).concat(key); } }
    return fallback;
  }
  async deleteMeta(k) { await this.raw.del('meta', k); await this.raw.del('meta', k + '.bak'); }
  async corruptMetaForTest(k) { await this.raw.put('meta', k, { v: 1, body: '{broken', sum: '0000' }); }
}

/** Android native backend. The native layer encrypts with an Android Keystore key and stores in filesDir/ToneMaster/... */
export class NativeStorage {
  constructor(n) { this.n = n; this.kind = 'native'; this.label = 'Android private storage + Keystore'; this.secure = true; }
  async init() { this.deviceId = this.n.deviceId(); return this; }
  async putSample(id, u8, info = {}) { if (this.n.putSample(id, JSON.stringify(info), b64(u8)) !== 'ok') throw new Error('Native write failed'); }
  async getSample(id) { const s = this.n.getSample(id); if (!s) throw new Error('Sample not found/failed integrity check: ' + id); return unb64(s); }
  async hasSample(id) { return this.n.hasSample(id) === 'true'; }
  async deleteSample(id) { this.n.deleteSample(id); }
  async listSamples() { return JSON.parse(this.n.listSamples() || '[]'); }
  async wipeSamples() { this.n.wipeSamples(); }
  async estimate() { try { return JSON.parse(this.n.storageInfo()); } catch { return null; } }
  async putMeta(k, obj) { const old = this.n.getMeta(k); if (old) this.n.putMeta(k + '.bak', old); this.n.putMeta(k, JSON.stringify(await metaWrap(obj))); }
  async getMeta(k, fallback = null) { for (const key of [k, k + '.bak']) { const s = this.n.getMeta(key); if (!s) continue; try { const v = await metaUnwrap(JSON.parse(s)); if (key !== k) await this.putMeta(k, v); return v; } catch { this.corrupt = (this.corrupt || []).concat(key); } } return fallback; }
  async deleteMeta(k) { this.n.deleteMeta(k); this.n.deleteMeta(k + '.bak'); }
}

export async function openStorage({ forceBrowser = false, raw = null } = {}) {
  if (!forceBrowser && !raw && typeof window !== 'undefined' && window.ToneMasterNative?.isNativeStorage?.()) return new NativeStorage(window.ToneMasterNative).init();
  return new BrowserStorage(raw || new IdbRaw()).init();
}
