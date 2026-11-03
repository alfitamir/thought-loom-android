import { useState } from "react";
import { Check, Heart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { saveLikedArticle } from "@/lib/ideas";
import { pushIdea } from "@/lib/sync";

/**
 * The «مقال أعجبني» intake: an article the user liked elsewhere, pasted in by
 * hand — title, where it came from, and the text itself. No recorder, no
 * transcription, no polish: the pasted text is stored verbatim and marked
 * liked, so no AI feature ever modifies it and its source always shows.
 */
export function LikedDialog({ open, onOpenChange, onSaved }: {
  open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [body, setBody] = useState("");

  const save = () => {
    const idea = saveLikedArticle(title, source, body);
    if (!idea) return;
    void pushIdea(idea).catch(() => {});
    setTitle(""); setSource(""); setBody("");
    onOpenChange(false);
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="max-h-[88dvh] overflow-y-auto">
        <DialogTitle className="text-start font-display flex items-center gap-2">
          <Heart className="size-5 text-rose-500" />
          <span>مقال أعجبني</span>
        </DialogTitle>
        <p className="text-xs text-muted-foreground">
          مقال قرأته وأعجبك من مصدر آخر. الصق نصه كما هو — سيُحفظ بنصّه ومصدره، والذكاء الاصطناعي لن يعدّله أبدًا.
        </p>
        <div className="space-y-3">
          <input aria-label="عنوان المقال" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="عنوان المقال"
            className="w-full rounded-md border border-input bg-card px-3 py-2 font-display text-lg outline-none focus:ring-2 focus:ring-ring" />
          <input aria-label="المصدر" value={source} onChange={(e) => setSource(e.target.value)} placeholder="المصدر — اسم الكاتب أو الموقع أو الرابط"
            className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
          <textarea aria-label="نص المقال" value={body} onChange={(e) => setBody(e.target.value)} rows={12} placeholder="الصق نص المقال هنا…"
            className="w-full rounded-md border border-input bg-card p-3 font-article text-xl leading-loose outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <div className="flex gap-2 pt-1">
          <Button onClick={save} disabled={!title.trim() || !body.trim()}><Check />حفظ المقال</Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>إلغاء</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
