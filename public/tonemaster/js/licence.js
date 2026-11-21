// Offline, device-bound licensing with Ed25519 signatures.
// Licence code = "TM1." + base64url(payloadJSON) + "." + base64url(signature)
// payload = { v, product, lid, customer, device, role: "customer"|"owner", issued }
import { enc, dec, unb64u } from './util.js';
import { verifyFallback } from './ed25519.js';

export async function ed25519Verify(pub, msg, sig) {
  try { const k = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']); return await crypto.subtle.verify({ name: 'Ed25519' }, k, sig, msg); }
  catch (e) { if (e?.name === 'NotSupportedError' || e?.name === 'SyntaxError' || e instanceof TypeError) return verifyFallback(pub, msg, sig); throw e; }
}
const BATCH_MSG = 'ToneMaster|batch|';
export function parseLicence(text) {
  const t = String(text || '').replace(/\s+/g, '');
  const bm = t.match(/^TM2\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);        // batch key: pre-made, binds to the first phone that activates it
  if (bm) { try { const lid = dec.decode(unb64u(bm[1])); return { batch: true, bytes: enc.encode(BATCH_MSG + lid), sig: unb64u(bm[2]), payload: { v: 1, product: 'ToneMaster', lid, role: 'customer', type: 'batch', customer: 'Licence holder' }, text: t }; } catch { return null; } }
  const m = t.match(/^TM1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!m) return null; try { const bytes = unb64u(m[1]); return { bytes, payload: JSON.parse(dec.decode(bytes)), sig: unb64u(m[2]), text: t }; } catch { return null; }
}
const fail = (code, message) => ({ ok: false, code, message });
export async function verifyLicence(text, deviceId, publicKeyB64u, revoked = [], boundDevice = null) {
  const L = parseLicence(text); if (!L) return fail('FORMAT', 'That is not a valid ToneMaster licence code. Paste the whole code, starting with TM1.');
  let ok; try { ok = await ed25519Verify(unb64u(publicKeyB64u), L.bytes, L.sig); } catch (e) { return { ok: false, code: 'ERROR', transient: true, message: 'Could not verify right now (' + e.message + '). Try again.' }; }
  if (!ok) return fail('SIGNATURE', 'This licence was not issued by MG:SOUNDS (signature does not match).');
  const p = L.payload; if (p.product !== 'ToneMaster') return fail('PRODUCT', 'This licence is for a different product.');
  if (revoked.includes(p.lid)) return fail('REVOKED', 'This licence has been revoked. Please contact MG:SOUNDS.');
  if (L.batch) { if (boundDevice && boundDevice !== deviceId) return fail('DEVICE', 'This licence key is already activated on a different phone. Each key works on one phone. Contact MG:SOUNDS if you changed phones.'); return { ok: true, payload: { ...p, device: boundDevice || deviceId }, text: L.text }; }
  if (p.device !== deviceId) return fail('DEVICE', 'This licence belongs to a different device (' + p.device + '). Licences are tied to one phone. Request a replacement licence for this device ID: ' + deviceId);
  return { ok: true, payload: p, text: L.text };
}

export class LicenceManager {
  constructor(storage, config) { this.s = storage; this.cfg = config; this.state = { status: 'none', payload: null, message: '' }; }
  get deviceId() { return this.s.deviceId; }
  get active() { return this.state.status === 'active' || this.state.status === 'grace'; }
  get isOwner() { return this.active && this.state.payload?.role === 'owner'; }
  async load() {
    const rec = await this.s.getMeta('licence'); if (!rec?.text) return this.state = { status: 'none', payload: null, message: 'Not activated' };
    const r = await verifyLicence(rec.text, this.deviceId, this.cfg.PUBLIC_KEY, this.cfg.REVOKED_LICENCE_IDS, rec.bound);
    if (r.ok) return this.state = { status: 'active', payload: r.payload, message: 'Activated' };
    // A temporary verification error must never lock out a paying customer that was valid before.
    if (r.transient && rec.verifiedOnce) return this.state = { status: 'grace', payload: rec.payload, message: r.message };
    return this.state = { status: 'invalid', payload: null, message: r.message };
  }
  async activate(text) {
    const r = await verifyLicence(text, this.deviceId, this.cfg.PUBLIC_KEY, this.cfg.REVOKED_LICENCE_IDS);
    if (!r.ok) return r;
    await this.s.putMeta('licence', { text: r.text, payload: r.payload, bound: this.deviceId, verifiedOnce: true, activated: new Date().toISOString() });
    this.state = { status: 'active', payload: r.payload, message: 'Activated' }; return r;
  }
  async deactivate() { await this.s.deleteMeta('licence'); this.state = { status: 'none', payload: null, message: 'Not activated' }; }
  requestText() { return 'ToneMaster licence request\nProduct: ToneMaster by MG:SOUNDS (' + this.cfg.PRICE + ')\nDevice ID: ' + this.deviceId; }
}
