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
- Idea backup uses `public.ideas` with immutable original text and optional article title/body plus a revision timestamp; RLS is scoped to `auth.uid()`. Why: originals survive editing and newest editions reconcile across devices.
- Article tools use an isolated editor and browser-safe article helpers. AI work goes through `resolveEngine` (`src/lib/ai-engine.ts`): the user's own Gemini key (stored only in device localStorage, called from the browser in `src/lib/gemini.ts`) is preferred; otherwise the authenticated server route with server-only gateway helpers. Why: the user's own key avoids platform credits, while the platform key never reaches the browser.
- Merge suggestions/merging (`src/lib/merge.ts`) and backup files (`src/lib/backup.ts`) are browser-safe; every AI output passes `isComplete`/`isMergeComplete` before it can replace content. Why: lines must never be silently dropped.
- Voice recording restarts short recognition sessions until the user presses stop. Why: Android ends recognition after brief silence.
- Terminal provider denials are stored in owner-readable `public.ai_access_state`, written only by verified server requests. Why: blocked AI work must not restart on reload or reconnect.
