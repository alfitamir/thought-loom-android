import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { toast } from "sonner";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { BottomNav } from "../components/bottom-nav";
import { Toaster } from "../components/ui/sonner";
import { initPendingDeletes } from "../lib/delete-flow";
import { initTheme } from "../lib/theme";
import { onStorageWriteError } from "../lib/ideas";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "أفكاري" },
      { name: "theme-color", content: "#1F243D" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.json" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Reem+Kufi:wght@500;700&family=Tajawal:wght@400;500;700&display=swap",
      },
      { rel: "icon", href: "/icons/icon.svg", type: "image/svg+xml" },
    ],
    scripts: [
      {
        children:
          "if('serviceWorker' in navigator && location.hostname!=='localhost' && !location.hostname.includes('id-preview')){navigator.serviceWorker.register('/sw.js').catch(()=>{})}",
      },
      // Appearance: set the `dark` class before first paint so a dark
      // preference never flashes light, and point the `theme-color` meta
      // (statically the dark navy above) at the resolved theme's chrome
      // color (mirrors src/lib/theme.ts; the root effect then keeps both
      // in sync). Defensive: any failure leaves the default untouched.
      {
        children:
          "try{var m=JSON.parse(localStorage.getItem('afkari.theme')||'\"system\"');var d=m==='dark'||(m!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark');var tc=document.querySelector('meta[name=theme-color]');if(tc)tc.setAttribute('content',d?'#1F243D':'#F9F1E3')}catch(e){}",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  // Undoable deletions left pending by an app close settle on startup:
  // anything past its grace deadline finalizes, the rest re-arms its timer.
  useEffect(() => {
    initPendingDeletes();
  }, []);

  // Appearance: apply the stored theme (the head script already set the
  // class pre-paint; this keeps it live — preference changes anywhere in
  // the tab and device changes while in «حسب الجهاز» mode).
  useEffect(() => initTheme(), []);

  // A library write localStorage refused (device storage full) must be
  // SEEN, not silently lost with the on-screen state looking saved:
  // ideas.ts reports the first failure of a streak, the toast carries
  // its Arabic explanation (audit F-3.3).
  useEffect(
    () =>
      onStorageWriteError((error) => {
        toast.error(error.message);
      }),
    [],
  );

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
      {/* Fixed bottom navigation; renders only on "/" and "/library". */}
      <BottomNav />
      <Toaster />
    </QueryClientProvider>
  );
}
