CREATE TABLE public.ideas (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  text text NOT NULL,
  created_at bigint NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ideas TO authenticated;
GRANT ALL ON public.ideas TO service_role;

ALTER TABLE public.ideas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own ideas"
  ON public.ideas FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert own ideas"
  ON public.ideas FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own ideas"
  ON public.ideas FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete own ideas"
  ON public.ideas FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE INDEX ideas_user_id_idx ON public.ideas (user_id);