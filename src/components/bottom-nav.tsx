import { Link, useLocation } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Library, Mic, Settings } from "lucide-react";
import { SettingsDialog } from "@/components/settings-dialog";

function NavLink({ to, active, icon, label }: {
  to: "/" | "/library"; active: boolean; icon: ReactNode; label: string;
}) {
  return (
    <Link to={to} aria-current={active ? "page" : undefined} className="flex flex-col items-center gap-1 px-4 py-2">
      <span className={`flex size-9 items-center justify-center rounded-full ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>{icon}</span>
      <span className={`text-xs ${active ? "font-medium text-primary" : "text-muted-foreground"}`}>{label}</span>
    </Link>
  );
}

/**
 * Fixed bottom navigation for the main app routes ("/" and "/library").
 * Rendered once from the app shell; hidden everywhere else (e.g. /auth).
 * The settings item opens the same SettingsDialog the library header used.
 */
export function BottomNav() {
  const pathname = useLocation({ select: (l) => l.pathname });
  const [settingsOpen, setSettingsOpen] = useState(false);
  if (pathname !== "/" && pathname !== "/library") return null;
  return (
    <>
      <nav dir="rtl" aria-label="التنقل الرئيسي" className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-stretch justify-around px-2 pt-1">
          <NavLink to="/" active={pathname === "/"} icon={<Mic className="size-5" />} label="سجّل فكرة" />
          <NavLink to="/library" active={pathname === "/library"} icon={<Library className="size-5" />} label="مقالاتي" />
          <button type="button" onClick={() => setSettingsOpen(true)} aria-label="الإعدادات" title="الإعدادات" className="flex flex-col items-center gap-1 px-4 py-2">
            <span className="flex size-9 items-center justify-center rounded-full text-muted-foreground"><Settings className="size-5" /></span>
            <span className="text-xs text-muted-foreground">الإعدادات</span>
          </button>
        </div>
      </nav>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}
