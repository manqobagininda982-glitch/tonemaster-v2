import { createFileRoute } from "@tanstack/react-router";
import { authenticate, json } from "@/server/tm/admin-auth";
import { allowedAdministrator } from "@/server/tm/admin-allowlist";

// Grants the admin role ONLY to confirmed accounts whose email is on the server-side ADMIN_EMAILS allow-list.
export const Route = createFileRoute("/api/public/tm/admin/claim")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const a = await authenticate(request);
        if ("error" in a) return a.error;
        const { data: already } = await a.sb.rpc("has_role", { _user_id: a.user.id, _role: "admin" });
        if (already) return json({ admin: true });
        if (!allowedAdministrator(a.user, process.env["ADMIN_EMAILS"])) return json({ admin: false, error: "This account is not an administrator." }, 403);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { error } = await supabaseAdmin.from("user_roles").insert({ user_id: a.user.id, role: "admin" });
        if (error && !/duplicate/i.test(error.message)) return json({ error: error.message }, 500);
        return json({ admin: true });
      },
    },
  },
});
