# خطة: ضبط كل المقالات بضغطة واحدة + حماية المحتوى من الضياع

## ما ستراه
1. **زر واحد "ضبط كل المقالات"** أعلى صفحة المقالات (يظهر فقط مع الإنترنت وتسجيل الدخول).
   - يمر على المقالات واحدًا تلو الآخر ويضبط الإملاء والنحو والترقيم والتنسيق بأسلوبك.
   - شريط تقدم بسيط: "تم ضبط 3 من 12" مع زر "إيقاف" في أي وقت.
   - كل مقال يُحفظ فور انتهائه؛ إذا انقطع الإنترنت يتوقف بهدوء ويبقى الباقي كما هو، وتكمل لاحقًا من حيث توقفت.
   - يتخطى المقالات المضبوطة مسبقًا ولم تتغير بعدها، حتى لا يُعاد العمل بلا داعٍ.
   - النص الأصلي لكل فكرة يبقى محفوظًا دائمًا.
2. **لا تطير أي سطور بعد اليوم** — في الضبط والدمج والمشاركة:
   - التطبيق يقارن النسخة المضبوطة بالأصل؛ إذا كانت أقصر بشكل ملحوظ أو ناقصة النهاية تُرفض تلقائيًا ويبقى مقالك كما هو مع رسالة "النسخة المقترحة ناقصة، لم نغير مقالك".
   - تعليمات الذكاء الاصطناعي تُشدد: كل جملة وفكرة يجب أن تبقى حتى آخر سطر، ممنوع الاختصار.
   - المقالات الطويلة تُقسم إلى أجزاء وتُضبط جزءًا جزءًا ثم تُجمع، فلا ينقطع آخرها.
   - المشاركة ترسل العنوان والنص كاملين دائمًا، ولو رفض تطبيق المشاركة النص الطويل يُنسخ كاملًا للحافظة.
   - التنسيق المحلي (بدون إنترنت) لا يحذف آخر جملة غير منتهية بعلامة ترقيم.
3. **الدمج (عند تنفيذه)** يستخدم نفس فحص الاكتمال: كل فكرة من المقالات المدمجة يجب أن تظهر في المقال الجديد، وإلا يُرفض الدمج وتبقى المقالات الأصلية.

## خارج هذه الخطوة
- ميزة اقتراح الدمج نفسها تبقى النقطة التالية؛ هنا نجهز لها حماية المحتوى فقط.

## Technical details
- Bulk: client loop in `library.tsx` calling existing `/api/articles/improve` sequentially (one at a time, shared rate budget), skipping ideas with an `aiPolishedAt >= updatedAt` marker stored on the idea; stop on 402/403/offline and on Stop (abort). Pause state persists via existing `ai_access_state`.
- Completeness guard in `src/lib/article-ai.ts`: `isComplete(source, output)` — reject when output word count < ~85% of source, or source's final sentence keywords missing; also treat `finishReason === "length"` as an error server-side. Unit tests added to `article-ai.test.ts`.
- Chunking: split bodies above ~1500 words on paragraph boundaries, improve per chunk, join.
- Share: fallback to clipboard on `navigator.share` failure other than AbortError; test that `toArticle` keeps a trailing sentence without punctuation (ideas.test.ts).
- Prompt: explicit "keep every sentence to the end; output length close to input".
