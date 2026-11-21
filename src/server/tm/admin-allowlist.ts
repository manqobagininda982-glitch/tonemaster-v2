// Server-side allowlist; a confirmed identity is required before a role can be granted.
const DEFAULT_ADMIN_EMAILS = "manqobagininda982@gmail.com";
export function allowedAdministrator(user: { email?: string; email_confirmed_at?: string }, configuredEmails = DEFAULT_ADMIN_EMAILS): boolean {
  if (!user.email || !user.email_confirmed_at) return false;
  const allowed = configuredEmails.split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(user.email.toLowerCase());
}