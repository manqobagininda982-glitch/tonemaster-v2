// Pure, dependency-light validation for uploaded ToneMaster packs (beat / tone ZIPs) and APKs.
// Runs inside the server worker; never trusts file names or extensions for audio content.
import { unzipSync, zipSync, type Unzipped } from "fflate";

export const LIMITS = {
  maxZipBytes: 80 * 1024 * 1024,
  maxTotalUncompressed: 160 * 1024 * 1024,
  maxEntryBytes: 40 * 1024 * 1024,
  maxEntries: 600,
  maxApkBytes: 100 * 1024 * 1024,
  maxLoopsPerFolder: 15,
};

export type WavInfo = { sampleRate: number; channels: number; bits: number; frames: number; seconds: number };

/** Validates RIFF/WAVE structure (PCM 8/16/24/32 or float 32/64, mono/stereo, 8–192 kHz). Throws on anything else. */
export function inspectWav(u8: Uint8Array): WavInfo {
  if (u8.length < 44) throw new Error("too small to be WAV");
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o: number) => String.fromCharCode(...u8.subarray(o, o + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not RIFF/WAVE data");
  if (d.getUint32(4, true) + 8 !== u8.length) throw new Error("RIFF size does not match WAV data");
  let fmt: { tag: number; ch: number; sr: number; bits: number; sub: number } | null = null;
  let dataLen = -1;
  let o = 12;
  while (o + 8 <= u8.length) {
    const id = tag(o);
    let sz = d.getUint32(o + 4, true);
    if (o + 8 + sz > u8.length) throw new Error("truncated WAV chunk");
    if (id === "fmt ") {
      if (sz < 16 || o + 24 > u8.length) throw new Error("truncated fmt chunk");
      fmt = { tag: d.getUint16(o + 8, true), ch: d.getUint16(o + 10, true), sr: d.getUint32(o + 12, true), bits: d.getUint16(o + 22, true), sub: sz >= 26 && o + 34 <= u8.length ? d.getUint16(o + 32, true) : 0 };
    } else if (id === "data") {
      dataLen = sz;
      break;
    }
    o += 8 + sz + (sz & 1);
  }
  if (!fmt) throw new Error("no fmt chunk");
  if (dataLen < 0) throw new Error("no data chunk");
  const type = fmt.tag === 0xfffe ? fmt.sub : fmt.tag;
  const float = type === 3;
  if (type !== 1 && type !== 3) throw new Error("unsupported encoding " + fmt.tag);
  if ((!float && ![8, 16, 24, 32].includes(fmt.bits)) || ![8, 16, 24, 32, 64].includes(fmt.bits) || (float && fmt.bits !== 32 && fmt.bits !== 64)) throw new Error("unsupported bit depth " + fmt.bits);
  if (fmt.ch < 1 || fmt.ch > 2) throw new Error("only mono/stereo supported");
  if (fmt.sr < 8000 || fmt.sr > 192000) throw new Error("unsupported sample rate " + fmt.sr);
  if (dataLen % ((fmt.bits / 8) * fmt.ch)) throw new Error("incomplete audio frame");
  const frames = Math.floor(dataLen / ((fmt.bits / 8) * fmt.ch));
  if (frames < 16) throw new Error("contains no audio");
  return { sampleRate: fmt.sr, channels: fmt.ch, bits: fmt.bits, frames, seconds: +(frames / fmt.sr).toFixed(3) };
}

/** Rejects absolute paths, drive letters, backslashes, NUL, and any ".." segment. */
export function isUnsafePath(name: string): boolean {
  if (!name || name.includes("\0") || name.includes("\\")) return true;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return true;
  return name.split("/").some((seg) => seg === "..");
}
const isJunk = (name: string) => name.startsWith("__MACOSX/") || name.split("/").some((s) => s.startsWith(".")) || name.endsWith("/");

/** Loop number 1–15 from the file's base name: "3.wav", "Loop 03.wav", "Kick Marker #12.wav". Uses the LAST number. */
export function loopNumber(base: string): number | null {
  const stem = base.replace(/\.[^.]*$/, "");
  const nums = stem.match(/\d+/g);
  if (!nums) return null;
  const n = parseInt((nums.at(-1) ?? ""), 10);
  return n >= 1 && n <= LIMITS.maxLoopsPerFolder ? n : null;
}

export type Issue = { file: string; problem: string };
export type BeatFolder = { name: string; loops: Array<{ n: number; source: string; path: string } & WavInfo> };
export type PackReport = {
  ok: boolean;
  kind: "beat" | "tone";
  issues: Issue[];
  ignored: string[];
  folders: BeatFolder[];
  tones: Array<{ source: string; path: string } & WavInfo>;
  totalBytes: number;
};

function safeUnzip(zip: Uint8Array): { files: Unzipped; issues: Issue[]; fatal: string | null } {
  const issues: Issue[] = [];
  if (zip.length > LIMITS.maxZipBytes) return { files: {}, issues, fatal: "ZIP is larger than " + LIMITS.maxZipBytes / 1048576 + " MB" };
  if (zip.length < 22 || zip[0] !== 0x50 || zip[1] !== 0x4b) return { files: {}, issues, fatal: "File is not a ZIP archive" };
  let total = 0, count = 0;
  let fatal: string | null = null;
  let files: Unzipped = {};
  try {
    files = unzipSync(zip, {
      filter: (f) => {
        count++;
        if (count > LIMITS.maxEntries) { fatal = "ZIP has more than " + LIMITS.maxEntries + " entries"; return false; }
        if (isUnsafePath(f.name)) { fatal = "Unsafe path in ZIP (path traversal/absolute): " + f.name; return false; }
        if (isJunk(f.name)) return false;
        if (f.originalSize > LIMITS.maxEntryBytes) { issues.push({ file: f.name, problem: "file larger than " + LIMITS.maxEntryBytes / 1048576 + " MB" }); return false; }
        total += f.originalSize;
        if (total > LIMITS.maxTotalUncompressed) { fatal = "Uncompressed content exceeds " + LIMITS.maxTotalUncompressed / 1048576 + " MB"; return false; }
        return !fatal;
      },
    });
  } catch (e) {
    return { files: {}, issues, fatal: "ZIP could not be read: " + (e instanceof Error ? e.message : String(e)) };
  }
  // Declared sizes can lie; check the real decompressed sizes too.
  let real = 0;
  for (const [n, data] of Object.entries(files)) {
    if (data.length > LIMITS.maxEntryBytes) { issues.push({ file: n, problem: "file too large after decompression" }); delete files[n]; continue; }
    real += data.length;
  }
  if (real > LIMITS.maxTotalUncompressed) fatal = "Uncompressed content exceeds limit";
  return { files, issues, fatal };
}

function stripCommonRoot(names: string[]): (n: string) => string {
  const firsts = new Set(names.map((n) => (n.includes("/") ? n.split("/")[0] : "")));
  if (firsts.size === 1 && !firsts.has("") && names.every((n) => n.split("/").length >= 3)) {
    const root = ([...firsts][0] ?? "") + "/";
    return (n) => n.slice(root.length);
  }
  return (n) => n;
}
const cleanName = (s: string) => s.replace(/[^\w .()&+#-]+/g, "_").trim().slice(0, 60) || "Loops";

/** Validates a beat or tone pack ZIP. Returns a report and (when ok) a clean ZIP containing only validated WAV data. */
export function validatePackZip(zip: Uint8Array, kind: "beat" | "tone"): { report: PackReport; clean: Uint8Array | null } {
  const report: PackReport = { ok: false, kind, issues: [], ignored: [], folders: [], tones: [], totalBytes: 0 };
  const { files, issues, fatal } = safeUnzip(zip);
  report.issues.push(...issues);
  if (fatal) { report.issues.unshift({ file: "(archive)", problem: fatal }); return { report, clean: null }; }
  const names = Object.keys(files).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const rel = stripCommonRoot(names);
  const out: Record<string, Uint8Array> = {};
  const folders = new Map<string, BeatFolder>();
  for (const name of names) {
    const data = files[name]; if (!data) continue;
    let info: WavInfo;
    try { info = inspectWav(data); } catch (e) {
      const looksWav = /\.wav$/i.test(name);
      if (looksWav) report.issues.push({ file: name, problem: "invalid WAV: " + (e instanceof Error ? e.message : String(e)) });
      else report.ignored.push(name);
      continue;
    }
    const r = rel(name), parts = r.split("/"), base = parts.pop() ?? "";
    if (kind === "tone") {
      const path = (parts.length ? parts.map(cleanName).join("/") : "tone") + "/" + cleanName(base.replace(/\.[^.]*$/, "")) + ".wav";
      if (out[path]) { report.issues.push({ file: name, problem: "duplicate tone name" }); continue; }
      out[path] = data; report.tones.push({ source: name, path, ...info }); report.totalBytes += data.length;
      continue;
    }
    const n = loopNumber(base);
    if (n == null) { report.issues.push({ file: name, problem: "no loop number 1–15 in file name" }); continue; }
    const folderName = cleanName(parts.join(" / ") || "Loops");
    const f = folders.get(folderName) ?? { name: folderName, loops: [] };
    if (f.loops.some((l) => l.n === n)) { report.issues.push({ file: name, problem: "duplicate loop " + n + " in folder " + folderName }); continue; }
    const path = folderName + "/" + n + ".wav";
    f.loops.push({ n, source: name, path, ...info });
    folders.set(folderName, f); out[path] = data; report.totalBytes += data.length;
  }
  report.folders = [...folders.values()].map((f) => ({ ...f, loops: f.loops.sort((a, b) => a.n - b.n) }));
  const good = kind === "beat" ? report.folders.reduce((a, f) => a + f.loops.length, 0) : report.tones.length;
  if (!good) { report.issues.unshift({ file: "(archive)", problem: "no valid WAV " + (kind === "beat" ? "loops" : "tones") + " found" }); return { report, clean: null }; }
  report.ok = report.issues.length === 0;
  return { report, clean: report.ok ? zipSync(out, { level: 0 }) : null };
}

export type ApkReport = { ok: boolean; issues: string[]; sha256: string; size: number; hasV1Signature: boolean; hasV2Block: boolean };

/** Structural APK checks only. Package name, signing certificate and versionCode are verified on the device before install. */
export async function validateApk(apk: Uint8Array): Promise<ApkReport> {
  const issues: string[] = [];
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", apk as Uint8Array<ArrayBuffer>));
  const sha256 = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  const rep: ApkReport = { ok: false, issues, sha256, size: apk.length, hasV1Signature: false, hasV2Block: false };
  if (apk.length > LIMITS.maxApkBytes) { issues.push("APK larger than " + LIMITS.maxApkBytes / 1048576 + " MB"); return rep; }
  if (apk[0] !== 0x50 || apk[1] !== 0x4b) { issues.push("not a ZIP/APK file"); return rep; }
  const names: string[] = [];
  try {
    unzipSync(apk, { filter: (f) => { names.push(f.name); return false; } });
  } catch (e) { issues.push("APK archive is corrupt: " + (e instanceof Error ? e.message : String(e))); return rep; }
  if (names.some(isUnsafePath)) issues.push("unsafe entry path inside APK");
  if (!names.includes("AndroidManifest.xml")) issues.push("AndroidManifest.xml missing");
  if (!names.some((n) => /^classes\d*\.dex$/.test(n))) issues.push("no classes.dex");
  rep.hasV1Signature = names.some((n) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(n));
  const magic = new TextEncoder().encode("APK Sig Block 42");
  const tail = apk.subarray(Math.max(0, apk.length - 4 * 1024 * 1024));
  outer: for (let i = tail.length - magic.length; i >= 0; i--) {
    for (let j = 0; j < magic.length; j++) if (tail[i + j] !== magic[j]) continue outer;
    rep.hasV2Block = true; break;
  }
  if (!rep.hasV1Signature && !rep.hasV2Block) issues.push("APK is not signed (no v1 or v2+ signature found)");
  rep.ok = issues.length === 0;
  return rep;
}
