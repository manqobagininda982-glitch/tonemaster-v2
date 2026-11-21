// Pure-JS Ed25519 VERIFY ONLY (RFC 8032), used when the WebView's WebCrypto lacks Ed25519.
// Verification needs no secrets, so a small BigInt implementation is acceptable here.
const p = 2n ** 255n - 19n, L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (a, m = p) => { const r = a % m; return r >= 0n ? r : r + m; };
const pow = (b, e, m = p) => { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; };
const inv = a => pow(a, p - 2n);
const D = mod(-121665n * inv(121666n)), I = pow(2n, (p - 1n) / 4n), D2 = 2n * D % p;
const add = (P, Q) => {
  const A = mod((P[1] - P[0]) * (Q[1] - Q[0])), B = mod((P[1] + P[0]) * (Q[1] + Q[0])), C = mod(P[3] * D2 * Q[3]), Dd = mod(2n * P[2] * Q[2]);
  const E = B - A, F = Dd - C, G = Dd + C, H = B + A; return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
};
const mul = (P, s) => { let R = [0n, 1n, 1n, 0n]; while (s > 0n) { if (s & 1n) R = add(R, P); P = add(P, P); s >>= 1n; } return R; };
const le = u8 => { let n = 0n; for (let i = u8.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(u8[i]); return n; };
function decode(u8) {
  const b = Uint8Array.from(u8), sign = b[31] >> 7; b[31] &= 0x7f; const y = le(b); if (y >= p) return null;
  const y2 = y * y % p, u = mod(y2 - 1n), v = mod(D * y2 + 1n);
  let x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (p - 5n) / 8n)); const vx2 = mod(v * x * x);
  if (vx2 !== u) { if (vx2 === mod(-u)) x = mod(x * I); else return null; }
  if (x === 0n && sign) return null; if (Number(x & 1n) !== sign) x = mod(-x);
  return [x, y, 1n, mod(x * y)];
}
const BASE = decode(Uint8Array.from([0x58, ...new Array(31).fill(0x66)]));
const eq = (P, Q) => mod(P[0] * Q[2]) === mod(Q[0] * P[2]) && mod(P[1] * Q[2]) === mod(Q[1] * P[2]);
export async function verifyFallback(pub, msg, sig) {
  if (pub.length !== 32 || sig.length !== 64) return false;
  const A = decode(pub), R = decode(sig.subarray(0, 32)), S = le(sig.subarray(32)); if (!A || !R || S >= L) return false;
  const buf = new Uint8Array(64 + msg.length); buf.set(sig.subarray(0, 32)); buf.set(pub, 32); buf.set(msg, 64);
  const h = mod(le(new Uint8Array(await crypto.subtle.digest('SHA-512', buf))), L);
  return eq(mul(BASE, S), add(R, mul(A, h)));
}
