// Instrument detection. Pure functions: path in -> classification out. No audio, no storage.
import { norm, slug } from './util.js';

// No built-in tone names: every instrument is named by the pack it was downloaded from (or its folder/ZIP name).
export const KNOWN = [];
export const OTHER_FOLDER = 'Other_Tones';
const KEYS = KNOWN.flatMap(k => [k, ...(k.alias || []).map(a => ({ ...k, nn: norm(a) }))].map(x => ({ k: k, n: x.nn || norm(k.name) })))
  .sort((a, b) => b.n.length - a.n.length);

/** Exact-or-whole-word match of free text against the known banks (longest bank name wins). */
export function matchKnown(text, exactOnly = false) {
  const n = norm(text); if (!n) return null;
  for (const { k, n: kn } of KEYS) if (n === kn) return k;
  if (exactOnly) return null;
  const padded = ' ' + n + ' ';
  for (const { k, n: kn } of KEYS) if (kn.length > 1 && padded.includes(' ' + kn + ' ')) return k;   // single-letter "E" never matches inside text
  return null;
}
export function dynamicInstrument(name) { const clean = String(name).replace(/[_]+/g, ' ').trim() || 'Imported Tones'; return { id: 'X_' + slug(clean), name: clean.toUpperCase(), folder: OTHER_FOLDER, known: false }; }
export function instrumentFromName(name) { const k = matchKnown(name, true); return k ? { ...k, known: true } : dynamicInstrument(name); }

const IGNORE = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)|(^|\/)\._/i;

/** Classify one ZIP entry path. zipName is the lowest-priority hint. */
export function classify(path, zipName = '') {
  path = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (IGNORE.test(path)) return { skip: 'ignored', reason: 'system file' };
  const parts = path.split('/'), base = parts.pop(), ext = (base.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || '';
  if (ext !== 'wav') return { skip: 'unsupported', reason: ext ? '.' + ext + ' is not a WAV file' : 'no file extension' };
  const folders = parts.reverse();                        // deepest folder first
  const stem = base.replace(/\.wav$/i, '');
  // marker number
  let marker = null, mm;
  if ((mm = stem.match(/__MARKER_(\d+)$/i)) || (mm = stem.match(/marker\s*#?\s*(\d+)/i)) || (mm = stem.match(/^(\d+)$/)) || (mm = stem.match(/(\d+)$/))) marker = +mm[1];
  // Rule 2: a known bank named by a folder (deepest first), then the filename prefix, then the ZIP name
  for (const f of folders) { const k = matchKnown(f); if (k) return { inst: { ...k, known: true }, marker, rule: 'folder name' }; }
  const prefix = (stem.match(/^(.*?)(?:__MARKER_|\s*-\s*marker)/i) || [])[1];
  if (prefix) { const k = matchKnown(prefix); if (k) return { inst: { ...k, known: true }, marker, rule: 'filename prefix' }; }
  const kz = zipName && matchKnown(zipName.replace(/\.zip$/i, '')); if (kz) return { inst: { ...kz, known: true }, marker, rule: 'ZIP name' };
  // Unknown bank: use filename prefix, folder, or ZIP name as a new instrument
  const label = (prefix && prefix.trim()) || folders.find(f => f && !/^(samples?|wav|audio|tonemaster_samples)$/i.test(f)) || zipName.replace(/\.zip$/i, '') || 'Imported Tones';
  return { inst: dynamicInstrument(label), marker, rule: 'new instrument (unrecognised name)' };
}
