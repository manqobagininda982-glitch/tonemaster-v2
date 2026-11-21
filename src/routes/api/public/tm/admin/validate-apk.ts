import { createFileRoute } from "@tanstack/react-router";
import { json, requireAdmin } from "@/server/tm/admin-auth";
import { validateApk, LIMITS } from "@/server/tm/pack-validate";

// Admin-only: checks an uploaded APK's structure/signature presence, records SHA-256, moves it to protected storage.
export const Route = createFileRoute("/api/public/tm/admin/validate-apk")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const a = await requireAdmin(request);
        if ("error" in a) return a.error;
        const { id } = (await request.json().catch(() => ({}))) as { id?: string };
        if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Missing release id" }, 400);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: rel } = await supabaseAdmin.from("app_releases").select("*").eq("id", id).single();
        if (!rel?.upload_path) return json({ error: "Release or uploaded file not found" }, 404);
        const { data: newer } = await supabaseAdmin.from("app_releases").select("version_code").eq("package_name", rel.package_name).eq("status", "validated").gte("version_code", rel.version_code).neq("id", id).limit(1);
        if (newer?.length) return json({ error: "A validated release with the same or higher version code already exists (downgrade blocked)." }, 409);
        const dl = await supabaseAdmin.storage.from("incoming").download(rel.upload_path);
        if (dl.error || !dl.data) return json({ error: "Uploaded file not found" }, 404);
        if (dl.data.size > LIMITS.maxApkBytes) return json({ error: "APK too large" }, 413);
        const bytes = new Uint8Array(await dl.data.arrayBuffer());
        const report = await validateApk(bytes);
        if (!report.ok) {
          await supabaseAdmin.from("app_releases").update({ status: "rejected", published: false, validation_report: report }).eq("id", id);
          return json({ ok: false, report });
        }
        const path = `apk/${rel.package_name}-${rel.version_code}-${report.sha256.slice(0, 12)}.apk`;
        const up = await supabaseAdmin.storage.from("packs").upload(path, bytes, { contentType: "application/vnd.android.package-archive", upsert: true });
        if (up.error) return json({ error: up.error.message }, 500);
        await supabaseAdmin.from("app_releases").update({ status: "validated", sha256: report.sha256, file_size: report.size, file_path: path, upload_path: null, validation_report: report }).eq("id", id);
        await supabaseAdmin.storage.from("incoming").remove([rel.upload_path]);
        return json({ ok: true, report });
      },
    },
  },
});
