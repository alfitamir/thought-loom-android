<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

# AGENTS.md

## Architecture decisions
- Cloud backup lives in `src/lib/sync.ts`; `src/lib/ideas.ts` stays pure localStorage storage (no supabase imports, no cycles). Why: sync needs local storage access, and the reverse import would create a module cycle.
- Idea backup table is `public.ideas` (id, user_id uuid, text, created_at bigint, synced_at) with RLS scoped to `auth.uid()`; ids match local crypto.randomUUID ids. Why: sync is id-based upsert, so restore/push dedupe naturally.
