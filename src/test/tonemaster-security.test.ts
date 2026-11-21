// @vitest-environment node
import { describe, it, expect } from "vitest";
import { zipSync } from "fflate";
import { inspectWav, isUnsafePath, validatePackZip, loopNumber, validateApk } from "@/server/tm/pack-validate";
import { allowedAdministrator } from "@/server/tm/admin-allowlist";

function wav() {
  const bytes = new Uint8Array(44 + 8000 * 2), d = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => [...text].forEach((c, i) => d.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF"); d.setUint32(4, bytes.length - 8, true); tag(8, "WAVE"); tag(12, "fmt ");
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, 8000, true);
  d.setUint32(28, 16000, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); tag(36, "data"); d.setUint32(40, 16000, true);
  for (let i = 0; i < 8000; i++) d.setInt16(44 + i * 2, Math.round(Math.sin(i * Math.PI * 2 * 220 / 8000) * 5000), true);
  return bytes;
}
describe("ToneMaster server validation", () => {
  it("detects only existing loops numbered 1–15 in each folder", () => {
    const { report, clean } = validatePackZip(zipSync({ "Groove/1.wav": wav(), "Groove/15.wav": wav(), "Other/3.wav": wav() }), "beat");
    expect(report.ok).toBe(true); expect(clean).not.toBeNull();
    expect(report.folders.find(f => f.name === "Groove")?.loops.map(l => l.n)).toEqual([1, 15]);
    expect(report.folders.find(f => f.name === "Other")?.loops.map(l => l.n)).toEqual([3]);
    expect(loopNumber("Loop 16.wav")).toBeNull();
  });
  it("rejects a pack containing fake WAV data even alongside real audio", () => {
    const { report, clean } = validatePackZip(zipSync({ "Groove/1.wav": wav(), "Groove/2.wav": new TextEncoder().encode("not audio") }), "beat");
    expect(report.ok).toBe(false); expect(clean).toBeNull();
  });
  it("rejects traversal and absolute archive paths", () => {
    for (const path of ["../1.wav", "/1.wav", "C:/1.wav", "Folder\\1.wav"]) {
      expect(isUnsafePath(path)).toBe(true);
      expect(validatePackZip(zipSync({ [path]: wav() }), "beat").report.ok).toBe(false);
    }
  });
  it("rejects oversized decompressed entries", () => {
    const file = new Uint8Array(40 * 1024 * 1024 + 1);
    expect(validatePackZip(zipSync({ "Groove/1.wav": file }), "beat").report.ok).toBe(false);
  });
  it("rejects truncated WAV content rather than accepting the filename", () => {
    expect(() => inspectWav(wav().slice(0, -2))).toThrow();
  });
  it("keeps separate instrument folders in a tone pack", () => {
    const { report } = validatePackZip(zipSync({ "Strings/1.wav": wav(), "Fretless Bass/1.wav": wav() }), "tone");
    expect(report.ok).toBe(true); expect(report.tones.map(t => t.path)).toEqual(["Fretless Bass/1.wav", "Strings/1.wav"]);
  });
  it("rejects an unsigned APK", async () => {
    const report = await validateApk(zipSync({ "AndroidManifest.xml": new Uint8Array([1]), "classes.dex": new Uint8Array([2]) }));
    expect(report.ok).toBe(false); expect(report.issues).toContain("APK is not signed (no v1 or v2+ signature found)");
  });
});
describe("Designated administrator", () => {
  it("allows the specified confirmed account", () => {
    expect(allowedAdministrator({ email: "manqobagininda982@gmail.com", email_confirmed_at: "2026-11-21T00:00:00Z" })).toBe(true);
  });
  it("never grants access before email confirmation", () => {
    expect(allowedAdministrator({ email: "manqobagininda982@gmail.com" })).toBe(false);
  });
  it("does not make another signup an administrator", () => {
    expect(allowedAdministrator({ email: "someone@example.test", email_confirmed_at: "2026-11-21T00:00:00Z" })).toBe(false);
  });
});