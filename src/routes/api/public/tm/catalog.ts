import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "cache-control": "no-store" };

// Public read-only catalogue of PUBLISHED, VALIDATED packs and the latest published app release.
export const Route = createFileRoute("/api/public/tm/catalog")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { headers: cors }),
      GET: async ({ request }) => {
        const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
        const sb = createClient<Database>(process.env["SUPABASE_URL"]!, key, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { fetch: (input, init) => { const h = new Headers(init?.headers); if (h.get("Authorization") === `Bearer ${key}`) h.delete("Authorization"); h.set("apikey", key); return fetch(input, { ...init, headers: h }); } },
        });
        const kind = new URL(request.url).searchParams.get("kind");
        let q = sb.from("packs").select("id,kind,name,version,description,bpm,file_name,file_size,manifest,updated_at").order("created_at", { ascending: false });
        if (kind === "tone" || kind === "beat") q = q.eq("kind", kind);
        const [{ data: packs, error }, { data: rel }] = await Promise.all([
          q,
          sb.from("app_releases").select("id,version_code,version_name,notes,package_name,min_sdk,file_size,sha256,updated_at").order("version_code", { ascending: false }).limit(1),
        ]);
        if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...cors, "content-type": "application/json" } });
        return new Response(JSON.stringify({ packs: packs ?? [], latestRelease: rel?.[0] ?? null }), { headers: { ...cors, "content-type": "application/json" } });
      },
    },
  },
});
