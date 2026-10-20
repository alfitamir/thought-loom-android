import { supabase } from "@/integrations/supabase/client";
import { getGeminiKey } from "./gemini";
import type { Engine } from "./article-ai";

/** Prefer the user's own Gemini key (no credits); otherwise the signed-in cloud service. */
export async function resolveEngine(): Promise<Engine | string> {
  const key = getGeminiKey();
  if (key) return { kind: "gemini", key };
  const { data } = await supabase.auth.getSession();
  if (!data.session) return "أضف مفتاح Gemini من الإعدادات ⚙️ أو سجّل الدخول لتفعيل الضبط.";
  return { kind: "cloud", token: data.session.access_token };
}
