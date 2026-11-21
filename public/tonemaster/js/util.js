// Shared helpers (ES module; runs in browser and Node 20+)
export const enc = new TextEncoder();
export const dec = new TextDecoder();
export const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
export const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const b64u = u8 => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = s => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
export const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join('');
export async function sha256(data) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data))); }
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const yieldUI = () => new Promise(r => setTimeout(r, 0));
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let T = null;
export function crc32(u8) {
  if (!T) { T = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } }
  let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0;
}
// Normalise a name for matching: upper-case, "+"→PLUS, "&"→AND, punctuation→space
export const norm = s => String(s).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\+/g, ' PLUS ').replace(/&/g, ' AND ')
  .replace(/[^A-Za-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ').toUpperCase();
export const slug = s => norm(s).replace(/ /g, '_') || 'UNNAMED';
export function concat(parts) { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; }
export const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
export const noteName = n => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][n % 12] + (Math.floor(n / 12) - 1);
export const fmtBytes = n => n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(0) + ' KB';
