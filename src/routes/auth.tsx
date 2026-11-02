import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { syncNow } from "@/lib/sync";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 shrink-0" aria-hidden="true">
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M6.73 14.29a7.2 7.2 0 0 1 0-4.58V6.62H1.29a12 12 0 0 0 0 10.76l5.44-3.09z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42A11.98 11.98 0 0 0 12 0 11.99 11.99 0 0 0 1.29 6.62l5.44 3.09C7.22 6.86 9.87 4.75 12 4.75z" />
    </svg>
  );
}

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
  // Guards so post-login sync + navigation happen exactly once, whichever
  // path established the session (Google OAuth return, existing session,
  // or the password form below — the form sets both before it syncs).
  const redirected = useRef(false);
  const passwordFlow = useRef(false);

  useEffect(() => {
    const finishSignIn = async () => {
      if (redirected.current) return;
      redirected.current = true;
      await syncNow();
      navigate({ to: "/" });
    };
    // The Supabase client (supabase-js v2 defaults: PKCE flow +
    // detectSessionInUrl) exchanges the OAuth ?code= on load, so a user
    // returning from Google already has a session by the time this runs.
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) void finishSignIn();
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      // The password form handles its own sync + navigation.
      if (event === "SIGNED_IN" && !passwordFlow.current) void finishSignIn();
    });
    return () => sub.subscription.unsubscribe();
  }, [navigate]);

  const signInWithGoogle = async () => {
    setBusy(true);
    setMsg("");
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth` },
    });
    // On success the browser leaves for Google, so only errors land here.
    if (error) {
      setBusy(false);
      setMsg("تعذّر بدء تسجيل الدخول بـ Google. حاول مرة أخرى.");
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) { setMsg("أدخل البريد وكلمة السر."); return; }
    passwordFlow.current = true;
    setBusy(true);
    setMsg("");
    if (mode === "signup") {
      const { error } = await supabase.auth.signUp({ email: email.trim(), password });
      setBusy(false);
      passwordFlow.current = false;
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
        passwordFlow.current = false;
        setMsg("تعذّر تسجيل الدخول. تأكد من البريد وكلمة السر.");
        return;
      }
      redirected.current = true;
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
      <div className="w-full max-w-sm space-y-3">
        <button type="button" onClick={signInWithGoogle} disabled={busy}
          className="flex w-full items-center justify-center gap-3 rounded-full border border-border bg-card py-3 font-semibold text-card-foreground disabled:opacity-60">
          <GoogleIcon />
          {busy ? "لحظة..." : "المتابعة مع Google"}
        </button>
        <div className="flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-border" />
          <span className="text-sm text-muted-foreground">أو</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      </div>
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
