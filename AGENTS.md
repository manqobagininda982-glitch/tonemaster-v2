<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

- Keep the supplied vanilla Main App in public/tonemaster and host it in the index iframe; this preserves its native-wrapper and offline asset paths without rewriting its sound engine.
- Keep catalogue/download calls in the Main App's api.js and admin-only mutations in the separate HTML panel plus authorized server routes; this prevents administrator surfaces entering the Main App.
- Rebuild the committed classic ToneMaster script with tonemaster-tools/build-bundle.js after changing its source modules; native wrappers load the same artifact as the website.
- Store editable performances and installed audio locally through the existing encrypted storage abstraction; offline playback does not depend on account or network availability.
- Native updates download to private cache, verify SHA-256 and APK signatures against the installed certificate, then use Android's official installer; no silent installation or downgrade override exists.
