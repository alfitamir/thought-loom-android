import { useMemo } from "react";
import { ChartColumn } from "lucide-react";
import { arabicNumber } from "@/lib/archive-pick";
import { loadVisibleIdeas } from "@/lib/pending-deletes";
import { computeStats } from "@/lib/stats";

/**
 * «إحصائياتي» — calm personal numbers in Settings, derived on the spot
 * from the visible library (lib/stats.ts) every time the dialog opens.
 * Nothing is stored or synced for this: it is this device's presentation
 * of the library it already holds.
 */
export function StatsSection() {
  const stats = useMemo(() => computeStats(loadVisibleIdeas()), []);
  const totals: Array<[string, number]> = [
    ["مقالات", stats.articles],
    ["أغاني", stats.songs],
    ["مقالات أعجبتني", stats.liked],
    ["القسم الطبي", stats.medical],
  ];
  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div className="flex items-center gap-2">
        <ChartColumn className="size-5 text-primary" />
        <h3 className="font-display text-lg">إحصائياتي</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        هذا الشهر: {arabicNumber(stats.monthArticles)} مقالة · {arabicNumber(stats.monthWords)} كلمة
      </p>
      <dl className="grid grid-cols-2 gap-2">
        {totals.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-2 rounded-md bg-card px-3 py-2">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="font-display text-base">{arabicNumber(value)}</dd>
          </div>
        ))}
      </dl>
      {stats.topTopics.length > 0 && (
        <div className="space-y-1">
          <p className="text-sm font-medium">أكثر المواضيع</p>
          {stats.topTopics.map(({ topic, count }) => (
            <p key={topic} className="flex items-baseline justify-between gap-2 text-sm text-muted-foreground">
              <span>{topic}</span>
              <span>{arabicNumber(count)}</span>
            </p>
          ))}
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        سلسلة الكتابة: الحالي {arabicNumber(stats.currentStreak)} يوم · الأطول {arabicNumber(stats.longestStreak)} يوم
      </p>
    </section>
  );
}
