ALTER TABLE public.ideas ADD COLUMN article_title text, ADD COLUMN article_body text, ADD COLUMN updated_at bigint NOT NULL DEFAULT 0;
CREATE TABLE public.ai_access_state (user_id uuid PRIMARY KEY, status integer NOT NULL, message text NOT NULL, blocked_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT ON public.ai_access_state TO authenticated;
GRANT ALL ON public.ai_access_state TO service_role;
ALTER TABLE public.ai_access_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read own AI access state" ON public.ai_access_state FOR SELECT TO authenticated USING (auth.uid() = user_id);