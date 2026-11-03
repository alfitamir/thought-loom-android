ALTER TABLE public.ideas ADD COLUMN liked boolean NOT NULL DEFAULT false, ADD COLUMN source text, ADD COLUMN sources text[];
