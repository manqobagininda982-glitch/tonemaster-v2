import { createFileRoute } from "@tanstack/react-router";
import { json, requireAdmin } from "@/server/tm/admin-auth";
import { validatePackZip, LIMITS } from "@/server/tm/pack-validate";

// Admin-only: securely extracts an uploaded pack ZIP, validates every WAV, and stores a clean rebuilt ZIP. Does NOT publish.
export const Route = createFileRoute("/api/public/tm/admin/validate-pack")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const a = await requireAdmin(request);
        if ("error" in a) return a.error;
        const { id } = (await request.json().catch(() => ({}))) as { id?: string };
        if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Missing pack id" }, 400);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: pack, error } = await supabaseAdmin.from("packs").select("*").eq("id", id).single();
        if (error || !pack) return json({ error: "Pack not found" }, 404);
        if (!pack.upload_path) return json({ error: "No uploaded file to validate" }, 400);
        const dl = await supabaseAdmin.storage.from("incoming").download(pack.upload_path);
        if (dl.error || !dl.data) return json({ error: "Uploaded file not found" }, 404);
        if (dl.data.size > LIMITS.maxZipBytes) {
          await supabaseAdmin.from("packs").update({ status: "rejected", published: false, validation_report: { ok: false, issues: [{ file: "(archive)", problem: "ZIP too large" }] } }).eq("id", id);
          return json({ error: "ZIP too large" }, 413);
        }
        const bytes = new Uint8Array(await dl.data.arrayBuffer());
        const { report, clean } = validatePackZip(bytes, pack.kind as "beat" | "tone");
        if (!report.ok || !clean) {
          await supabaseAdmin.from("packs").update({ status: "rejected", published: false, validation_report: report }).eq("id", id);
          return json({ ok: false, report });
        }
        const path = `${pack.kind}/${id}/v${String(pack.version).replace(/[^\w.-]/g, "_")}-${Date.now()}.zip`;
        const up = await supabaseAdmin.storage.from("packs").upload(path, clean, { contentType: "application/zip", upsert: false });
        if (up.error) return json({ error: "Could not store validated pack: " + up.error.message }, 500);
        const old = pack.file_path;
        const manifest = pack.kind === "beat"
          ? { folders: report.folders.map((f) => ({ name: f.name, loops: f.loops.map((l) => ({ n: l.n, path: l.path, seconds: l.seconds, sampleRate: l.sampleRate, channels: l.channels })) })) }
          : { tones: report.tones.map((t) => ({ path: t.path, seconds: t.seconds })) };
        const { error: uErr } = await supabaseAdmin.from("packs").update({
          status: "validated", published: false, validation_report: report, manifest, file_path: path, file_size: clean.length,
        }).eq("id", id);
        if (uErr) { await supabaseAdmin.storage.from("packs").remove([path]); return json({ error: uErr.message }, 500); }
        await supabaseAdmin.storage.from("incoming").remove([pack.upload_path]);
        await supabaseAdmin.from("packs").update({ upload_path: null }).eq("id", id);
        if (old && old !== path) await supabaseAdmin.storage.from("packs").remove([old]);
        return json({ ok: true, report, manifest });
      },
    },
  },
});
