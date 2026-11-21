// Shared public catalogue and protected downloads. No administrator capabilities live here.
import { CONFIG } from './config.js';

export function apiOrigin() {
  return location.protocol.startsWith('http') && location.hostname !== 'appassets.androidplatform.net' ? location.origin : CONFIG.API_ORIGIN;
}
async function json(path, init) {
  const r = await fetch(apiOrigin() + '/api/public/tm/' + path, { cache: 'no-store', ...init });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Request failed (' + r.status + ')'); return j;
}
export const api = {
  catalog: kind => json('catalog' + (kind ? '?kind=' + encodeURIComponent(kind) : '')),
  link: (id, type) => json('download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, type }) }),
  async download(id, type, progress = () => { }) {
    const { url } = await api.link(id, type); const r = await fetch(url);
    if (!r.ok) throw new Error('Download failed (' + r.status + ')');
    const total = Number(r.headers.get('content-length')) || 0;
    if (!r.body) { const b = await r.blob(); progress(b.size, b.size); return b; }
    const reader = r.body.getReader(), parts = []; let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; progress(got, total); }
    return new Blob(parts, { type: type === 'release' ? 'application/vnd.android.package-archive' : 'application/zip' });
  },
};