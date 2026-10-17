import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { syncNow } from "@/lib/sync";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "تسجيل الدخول — أفكاري" },
      { name: "description", content: "سجّل الدخول مرة واحدة ليُحفظ أرشيف أفكارك في السحابة." },
      { property: "og:title", content: "تسجيل الدخول — أفكاري" },
      { property: "og:description", content: "سجّل الدخول مرة واحدة ليُحفظ أرشيف أفكارك في السحابة." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Auth,
});

function Auth() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) { setMsg("أدخل البريد وكلمة السر."); return; }
    setBusy(true);
    setMsg("");
    if (mode === "signup") {
      const { error } = await supabase.auth.signUp({ email: email.trim(), password });
      setBusy(false);
      setMsg(
        error
          ? "تعذّر إنشاء الحساب. تأكد من البريد وأن كلمة السر 6 أحرف على الأقل."
          : "تم إنشاء الحساب. راجع بريدك واضغط رابط التأكيد، ثم سجّل الدخول هنا.",
      );
      if (!error) setMode("signin");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      setBusy(false);
      if (error) {
        setMsg("تعذّر تسجيل الدخول. تأكد من البريد وكلمة السر.");
        return;
      }
      await syncNow();
      navigate({ to: "/" });
    }
  };

  return (
    <main dir="rtl" className="paper flex min-h-screen flex-col items-center justify-center gap-6 px-6">
      <h1 className="font-display text-3xl text-foreground">حفظ أفكارك في السحابة</h1>
      <p className="max-w-sm text-center text-sm text-muted-foreground">
        سجّل الدخول مرة واحدة، وستُحفظ أفكارك تلقائياً كلما توفر الإنترنت، وتستعيدها حتى لو مسحت بيانات المتصفح أو غيرت هاتفك. التطبيق يبقى يعمل بدون إنترنت كالمعتاد.
      </p>
      <form onSubmit={submit} className="w-full max-w-sm space-y-3">
        <input
          type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="البريد الإلكتروني" autoComplete="email"
          className="w-full rounded-2xl border border-border bg-card px-4 py-3 text-lg text-card-foreground outline-none focus:ring-2 focus:ring-ring"
        />
        <input
          type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder="كلمة السر" autoComplete={mode === "signup" ? "new-password" : "current-password"}
          className="w-full rounded-2xl border border-border bg-card px-4 py-3 text-lg text-card-foreground outline-none focus:ring-2 focus:ring-ring"
        />
        <button type="submit" disabled={busy}
          className="w-full rounded-full bg-primary py-3 font-semibold text-primary-foreground disabled:opacity-60">
          {busy ? "لحظة..." : mode === "signup" ? "إنشاء حساب" : "تسجيل الدخول"}
        </button>
      </form>
      {msg && <p className="max-w-sm text-center text-sm text-muted-foreground">{msg}</p>}
      <button
        onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setMsg(""); }}
        className="text-sm text-primary underline"
      >
        {mode === "signup" ? "لدي حساب بالفعل — تسجيل الدخول" : "ليس لدي حساب — إنشاء حساب جديد"}
      </button>
      <button onClick={() => navigate({ to: "/" })} className="text-sm text-muted-foreground">رجوع</button>
    </main>
  );
}
