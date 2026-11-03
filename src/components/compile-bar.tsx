import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { downloadDocument, printDocument } from "@/lib/document";
import type { Idea } from "@/lib/ideas";
import { FileDown, FileText, Printer, X } from "lucide-react";
import { toast } from "sonner";

/**
 * The sticky bar shown while a list view is in selection mode: how many
 * articles are picked, the «تجميع في مستند» action and the exit. The
 * compile dialog offers the document's two deliveries — a Markdown
 * download, or the print-styled page (browser print → PDF). Shared by
 * the main library and the medical section so both behave identically.
 * The bar floats above the bottom navigation.
 */
export function CompileBar({ ideas, onCancel }: { ideas: Idea[]; onCancel: () => void }) {
  const [open, setOpen] = useState(false);
  const count = ideas.length;
  const print = () => {
    if (!printDocument(ideas)) {
      toast("المتصفح منع فتح نافذة الطباعة — اسمح بالنوافذ المنبثقة وحاول مجددًا.");
      return;
    }
    setOpen(false);
  };
  const download = () => {
    downloadDocument(ideas);
    setOpen(false);
  };
  return (
    <>
      <div dir="rtl" className="fixed inset-x-0 bottom-20 z-40 px-5">
        <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-2xl border border-border bg-card px-4 py-3 shadow-lg">
          <span className="min-w-0 flex-1 text-sm font-medium text-foreground" role="status">
            {count > 0 ? `تم اختيار ${count}` : "لم تُختر مقالات بعد"}
          </span>
          <Button className="rounded-full px-4" disabled={count === 0} onClick={() => setOpen(true)}>
            <FileText />تجميع في مستند
          </Button>
          <Button variant="ghost" className="rounded-full px-3" onClick={onCancel}>
            <X />إلغاء
          </Button>
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent dir="rtl" className="max-h-[88dvh] overflow-y-auto">
          <DialogTitle className="flex items-center gap-2 text-start font-display">
            <FileText className="size-5 text-primary" />
            <span>تجميع {count} {count === 1 ? "مقالة" : "مقالات"} في مستند واحد</span>
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            المستند مرتّب حسب الموضوع، والمقالات الأقدم أولًا داخل كل موضوع — والنصوص كما هي تمامًا، دون أي تعديل.
          </p>
          <div className="flex flex-col gap-2 pt-1">
            <Button className="w-full rounded-full" onClick={download}>
              <FileDown />تنزيل Markdown
            </Button>
            <Button variant="outline" className="w-full rounded-full" onClick={print}>
              <Printer />طباعة / PDF
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
