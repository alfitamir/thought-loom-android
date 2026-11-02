CREATE TABLE public.idea_deletions (
  user_id uuid NOT NULL,
  idea_id text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idea_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.idea_deletions TO authenticated;
GRANT ALL ON public.idea_deletions TO service_role;
ALTER TABLE public.idea_deletions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Own deletions select" ON public.idea_deletions FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Own deletions insert" ON public.idea_deletions FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Own deletions update" ON public.idea_deletions FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Own deletions delete" ON public.idea_deletions FOR DELETE TO authenticated USING (auth.uid() = user_id);

ALTER TABLE public.ideas ADD COLUMN merged_from text[];