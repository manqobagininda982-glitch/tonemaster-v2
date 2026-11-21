import { createFileRoute } from "@tanstack/react-router";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "cache-control": "no-store", "content-type": "application/json" };

// Issues a short-lived (10 min) signed link for a PUBLISHED, VALIDATED pack or release and counts the download.
export const Route = createFileRoute("/api/public/tm/download")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { headers: cors }),
      POST: async ({ request }) => {
        const { id, type } = (await request.json().catch(() => ({}))) as { id?: string; type?: string };
        if (!id || !/^[0-9a-f-]{36}$/i.test(id) || (type !== "pack" && type !== "release")) return new Response(JSON.stringify({ error: "bad request" }), { status: 400, headers: cors });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const table = type === "pack" ? "packs" : "app_releases";
        const { data: row } = await supabaseAdmin.from(table).select("id,file_path,published,status").eq("id", id).maybeSingle();
        if (!row || !row.published || row.status !== "validated" || !row.file_path) return new Response(JSON.stringify({ error: "not available" }), { status: 404, headers: cors });
        const { data, error } = await supabaseAdmin.storage.from("packs").createSignedUrl(row.file_path, 600);
        if (error || !data) return new Response(JSON.stringify({ error: "link failed" }), { status: 500, headers: cors });
        await supabaseAdmin.rpc("bump_download", { _table: table, _id: id });
        return new Response(JSON.stringify({ url: data.signedUrl }), { headers: cors });
      },
    },
  },
});
