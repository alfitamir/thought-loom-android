export function parseImprovedArticle(text: string): { title: string; body: string } {
  const lines = text.trim().split("\n");
  const title = (lines.shift() ?? "").replace(/^#+\s*/, "").trim();
  const body = lines.join("\n").trim();
  if (!title || !body) throw new Error("لم تصل نسخة مكتملة من المقال. لم يتغير مقالك الأصلي.");
  return { title, body };
}

export async function readArticleStream(response: Response, onText: (text: string) => void): Promise<string> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message ?? "تعذّر تحسين المقال الآن.");
  }
  if (!response.body) throw new Error("لم تصل نسخة من المقال.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", output = "", completed = false;
  const processLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "text") { output += event.text; onText(output); }
    if (event.type === "done") completed = true;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(processLine);
    }
    buffer += decoder.decode();
    processLine(buffer);
    if (!completed) throw new Error("انقطع الاتصال قبل اكتمال التحسين. مقالك محفوظ كما هو.");
    return output;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}