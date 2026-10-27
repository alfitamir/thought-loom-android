import { useEffect, useRef, useState } from "react";
import { CloudUpload, Download, KeyRound, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getGeminiKey, setGeminiKey, testGeminiKey } from "@/lib/gemini";
import { buildBackup, parseBackup, restoreBackup } from "@/lib/backup";
import { lastDriveSync, syncDrive } from "@/lib/drive-sync";
import { loadIdeas } from "@/lib/ideas";
import { syncNow } from "@/lib/sync";

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState("");
  const [keyMsg, setKeyMsg] = useState("");
  const [testing, setTesting] = useState(false);
  const [backupMsg, setBackupMsg] = useState("");
  const [driveAt, setDriveAt] = useState(0);
  const [driveMsg, setDriveMsg] = useState("");
  const [driveBusy, setDriveBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setSaved(!!getGeminiKey()); setDraft(""); setKeyMsg(""); setBackupMsg(""); setDriveMsg(""); setDriveAt(lastDriveSync()); } }, [open]);
  useEffect(() => {
    const update = () => setDriveAt(lastDriveSync());
    window.addEventListener("afkari:drive-synced", update);
    return () => window.removeEventListener("afkari:drive-synced", update);
  }, []);

  const syncDriveNow = async () => {
    setDriveBusy(true); setDriveMsg("جارٍ المزامنة مع Google Drive…");
    const result = await syncDrive().catch(() => ({ ok: false as const, message: "تعذّرت المزامنة مع Google Drive الآن." }));
    setDriveBusy(false);
    setDriveMsg(result.ok ? (result.restored ? `تمت المزامنة ✓ واستُعيدت ${result.restored} فكرة من Drive.` : "تمت المزامنة ✓ كل أفكارك محفوظة في Google Drive.") : result.message);
  };

  const saveKey = async () => {
    const key = draft.trim();
    if (!key) return;
    setGeminiKey(key); setSaved(true); setDraft("");
    if (!navigator.onLine) { setKeyMsg("حُفظ المفتاح ✓ سنستخدمه عند الاتصال بالإنترنت."); return; }
    setTesting(true); setKeyMsg("جارٍ التأكد من المفتاح…");
    const error = await testGeminiKey(key);
    setTesting(false);
    setKeyMsg(error ? `حُفظ المفتاح، لكن: ${error}` : "المفتاح يعمل ✓ الضبط والدمج سيستخدمان Gemini الخاص بك.");
  };
  const removeKey = () => { setGeminiKey(""); setSaved(false); setKeyMsg("حُذف المفتاح من هذا الهاتف."); };

  const exportBackup = async () => {
    setBackupMsg("");
    const ideas = loadIdeas();
    const date = new Date().toISOString().slice(0, 10);
    const name = `afkari-backup-${date}.json`;
    const file = new File([buildBackup(ideas)], name, { type: "application/json" });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "نسخة أفكاري الاحتياطية" });
        setBackupMsg(`جُهزت النسخة (${ideas.length} فكرة) ✓ اختر Google Drive لحفظها.`);
        return;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setBackupMsg(`نُزّلت النسخة (${ideas.length} فكرة) ✓ ارفعها إلى Google Drive من مجلد التنزيلات.`);
  };
  const importBackup = async (file: File | undefined) => {
    if (!file) return;
    try {
      const added = restoreBackup(parseBackup(await file.text()));
      setBackupMsg(added ? `استُعيدت ${added} فكرة ✓` : "النسخة مستعادة ✓ كل أفكارها موجودة بالفعل.");
      void syncNow().catch(() => {});
    } catch (error) {
      setBackupMsg(error instanceof Error ? error.message : "تعذّرت قراءة الملف.");
    } finally { if (fileRef.current) fileRef.current.value = ""; }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent dir="rtl" className="max-h-[85dvh] overflow-y-auto">
      <DialogTitle className="text-start font-display">الإعدادات</DialogTitle>
      <section className="space-y-3">
        <h3 className="font-display text-lg">مفتاح Gemini الخاص بك</h3>
        <p className="text-sm text-muted-foreground">مع المفتاح يعمل الضبط والدمج عبر حسابك في Gemini دون استهلاك رصيد التطبيق. يُحفظ على هذا الهاتف فقط.</p>
        {saved && <p className="text-sm text-primary">✓ يوجد مفتاح محفوظ على هذا الهاتف</p>}
        <input type="password" aria-label="مفتاح Gemini" placeholder={saved ? "ضع مفتاحًا جديدًا لاستبداله" : "الصق المفتاح هنا"} value={draft} onChange={(e) => setDraft(e.target.value)}
          dir="ltr" autoComplete="off" className="w-full rounded-md border border-input bg-card px-3 py-2 outline-none focus:ring-2 focus:ring-ring" />
        <div className="flex flex-wrap gap-2">
          <Button onClick={saveKey} disabled={!draft.trim() || testing}><KeyRound />حفظ المفتاح</Button>
          {saved && <Button variant="ghost" className="text-destructive" onClick={removeKey}><Trash2 />حذف المفتاح</Button>}
        </div>
        <p className="text-xs text-muted-foreground">تحصل على المفتاح من aistudio.google.com/apikey</p>
        {keyMsg && <p role="status" className="break-words text-sm text-muted-foreground">{keyMsg}</p>}
      </section>
      <section className="space-y-3 border-t border-border pt-4">
        <h3 className="font-display text-lg">Google Drive</h3>
        <p className="text-sm text-muted-foreground">تُحفظ أفكارك ومقالاتك تلقائيًا في ملف «afkari-sync.json» على Google Drive كلما اتصلت بالإنترنت وأنت مسجّل الدخول، وتُستعاد منه على أي هاتف.</p>
        <p className="text-sm text-muted-foreground">{driveAt ? `آخر مزامنة: ${new Date(driveAt).toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" })}` : "لم تتم المزامنة بعد على هذا الهاتف."}</p>
        <Button variant="outline" onClick={syncDriveNow} disabled={driveBusy}><CloudUpload />مزامنة الآن</Button>
        {driveMsg && <p role="status" className="break-words text-sm text-muted-foreground">{driveMsg}</p>}
      </section>
      <section className="space-y-3 border-t border-border pt-4">
        <h3 className="font-display text-lg">النسخة الاحتياطية</h3>
        <p className="text-sm text-muted-foreground">ملف واحد فيه كل أفكارك ومقالاتك. احفظه في Google Drive واستعده على أي هاتف.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={exportBackup}><Download />تصدير نسخة</Button>
          <Button variant="outline" onClick={() => fileRef.current?.click()}><Upload />استعادة نسخة</Button>
          <input ref={fileRef} type="file" accept=".json,application/json,text/plain" hidden aria-label="ملف النسخة الاحتياطية" onChange={(e) => importBackup(e.target.files?.[0])} />
        </div>
        {backupMsg && <p role="status" className="break-words text-sm text-muted-foreground">{backupMsg}</p>}
      </section>
    </DialogContent>
  </Dialog>;
}
