// Verifies the caller of an admin route: valid session token AND the admin role (checked as the user, through RLS).
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function userClient(token: string) {
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  return createClient<Database>(process.env["SUPABASE_URL"]!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}`, apikey: key } },
  });
}

export async function authenticate(request: Request) {
  const h = request.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return { error: json({ error: "Sign in required" }, 401) } as const;
  const sb = userClient(token);
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) return { error: json({ error: "Session expired. Sign in again." }, 401) } as const;
  return { sb, user: data.user } as const;
}

export async function requireAdmin(request: Request) {
  const a = await authenticate(request);
  if ("error" in a) return a;
  const { data: isAdmin, error } = await a.sb.rpc("has_role", { _user_id: a.user.id, _role: "admin" });
  if (error || !isAdmin) return { error: json({ error: "Administrator access required" }, 403) } as const;
  return a;
}
