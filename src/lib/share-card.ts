import { articleTopic, getArticle, type Idea } from "./ideas";

/**
 * «مشاركة كصورة» — render an article/song/liked card as a branded PNG,
 * entirely in the browser: deep-navy card, gold accents, the article
 * title and a short excerpt, a topic chip, and the author's name with
 * the app name in the footer. Delivery mirrors the audio share: the
 * system share sheet when files are shareable, a PNG download
 * otherwise. No server, no external assets.
 *
 * The composition decisions (which lines, which attribution) are pure
 * and unit-tested here; the canvas pass stays a thin drawing layer.
 */

export const SHARE_CARD_WIDTH = 1080;
export const SHARE_CARD_HEIGHT = 1350;

export type ShareCardModel = {
  kind: "article" | "song" | "liked";
  /** Chip text: «مقال» / «أغنية» / «مقال أعجبني». */
  kindLabel: string;
  title: string;
  excerpt: string;
  topic: string;
  /** The source line. REQUIRED on liked cards (the feature's core
   *  rule); also present on his own articles that merged a liked one. */
  attribution?: string;
  authorLine: string;
  appLine: string;
};

export function shareCardModel(idea: Idea, topic: string = articleTopic(idea)): ShareCardModel {
  const article = getArticle(idea);
  const kind = idea.song ? "song" : idea.liked ? "liked" : "article";
  const kindLabel = kind === "song" ? "أغنية" : kind === "liked" ? "مقال أعجبني" : "مقال";
  const ownSource = (idea.source ?? "").trim();
  const merged = (idea.sources ?? []).map((s) => s.trim()).filter(Boolean);
  let attribution: string | undefined;
  if (idea.liked) {
    attribution = ownSource
      ? `المصدر: ${ownSource}`
      : merged.length
        ? `المصدر: ${merged.join("، ")}`
        : "مقال من مصدر خارجي";
  } else if (merged.length) {
    attribution = `يتضمن مقالًا من: ${merged.join("، ")}`;
  }
  return {
    kind,
    kindLabel,
    title: article.title.trim() || "بدون عنوان",
    excerpt: cardExcerpt(article.body),
    topic,
    ...(attribution ? { attribution } : {}),
    authorLine: "د. تامر رشدي الألفي",
    appLine: "أفكاري",
  };
}

/** Flatten a body into a card excerpt: single-spaced, capped at a word
 *  boundary with an ellipsis when it had to be cut. */
export function cardExcerpt(body: string, maxChars = 230): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const at = cut.lastIndexOf(" ");
  return (at > maxChars * 0.6 ? cut.slice(0, at) : cut).trimEnd() + "…";
}

export type Measurer = (text: string) => number;

/** Greedy word wrap against an injected measurer (the canvas passes
 *  ctx.measureText; tests pass a fixed-width one). A single word wider
 *  than the line is hard-split by characters. */
export function wrapLines(text: string, maxWidth: number, measure: Measurer): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const fits = (s: string) => measure(s) <= maxWidth;
  const placeWord = (word: string) => {
    let rest = word;
    while (!fits(rest)) {
      let n = rest.length;
      while (n > 1 && !fits(rest.slice(0, n))) n--;
      lines.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    line = rest;
  };
  for (const word of words) {
    if (!line) {
      placeWord(word);
      continue;
    }
    const joined = `${line} ${word}`;
    if (fits(joined)) line = joined;
    else {
      lines.push(line);
      line = "";
      placeWord(word);
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Keep at most `max` lines; the last kept line is shortened (with an
 *  ellipsis) until it fits the line width. */
export function clampLines(
  lines: string[],
  max: number,
  maxWidth: number,
  measure: Measurer,
): string[] {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  let last = kept[max - 1] ?? "";
  while (last.length && measure(`${last}…`) > maxWidth) last = last.slice(0, -1).trimEnd();
  kept[max - 1] = `${last}…`;
  return kept;
}

/** A share/download-safe PNG file name from the title (mirrors
 *  audioFileName's cleaning). */
export function shareCardFileName(title: string): string {
  const clean = title
    // eslint-disable-next-line no-control-regex -- intentional: strips C0 control characters so the title is safe as a file name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return `${clean || "مقال"}.png`;
}

/** Share the PNG through the system sheet when files are shareable;
 *  download it otherwise. Mirrors the song/audio share exactly. */
export async function deliverCardImage(
  blob: Blob,
  title: string,
): Promise<"shared" | "downloaded" | "aborted"> {
  const file = new File([blob], shareCardFileName(title), { type: "image/png" });
  let canFiles = false;
  try {
    canFiles = !!navigator.canShare?.({ files: [file] });
  } catch {
    canFiles = false;
  }
  if (canFiles) {
    try {
      await navigator.share({ files: [file], title });
      return "shared";
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return "aborted";
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "downloaded";
}

const NAVY = "#1F243D";
const GOLD = "#C9A227";
const GOLD_LIGHT = "#F7DC9A";
const PAPER = "#FFF5EC";
const BODY = "#E9E2D0";
const MARGIN = 84;

/** Draw the card on a 1080×1350 canvas and return the PNG blob. Uses
 *  the page's own bundled Arabic webfont (Almarai, via Fontsource) so
 *  the text is shaped and RTL-correct. */
export async function renderShareCardPng(model: ShareCardModel): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = SHARE_CARD_WIDTH;
  canvas.height = SHARE_CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  try {
    await Promise.allSettled([
      document.fonts.load('700 68px "Almarai"'),
      document.fonts.load('400 42px "Almarai"'),
      document.fonts.load('500 34px "Almarai"'),
    ]);
  } catch {
    /* fall back to whatever is loaded */
  }

  const W = SHARE_CARD_WIDTH,
    H = SHARE_CARD_HEIGHT;
  const contentW = W - MARGIN * 2;
  const right = W - MARGIN;

  ctx.fillStyle = NAVY;
  ctx.fillRect(0, 0, W, H);
  // Double gold frame.
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 3;
  ctx.strokeRect(28, 28, W - 56, H - 56);
  ctx.strokeStyle = "rgba(201,162,39,0.45)";
  ctx.lineWidth = 1;
  ctx.strokeRect(42, 42, W - 84, H - 84);

  ctx.direction = "rtl";

  // Chips row (kind + topic), laid out from the right edge.
  const chip = (text: string, xRight: number, y: number): number => {
    ctx.font = '500 34px "Almarai", sans-serif';
    const w = ctx.measureText(text).width + 44;
    const x = xRight - w;
    ctx.beginPath();
    ctx.roundRect(x, y, w, 56, 28);
    ctx.fillStyle = "rgba(247,220,154,0.10)";
    ctx.fill();
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = GOLD_LIGHT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + w / 2, y + 30);
    return x;
  };
  let chipRight = right;
  chipRight = chip(model.kindLabel, chipRight, 96) - 16;
  if (model.topic) chip(model.topic, chipRight, 96);

  // Title — shrink-to-fit across candidate sizes, at most 3 lines.
  const measure = (s: string) => ctx.measureText(s).width;
  let titleLines: string[] = [];
  let titleSize = 46;
  for (const size of [68, 60, 52, 46]) {
    ctx.font = `700 ${size}px "Almarai", sans-serif`;
    const wrapped = wrapLines(model.title, contentW, measure);
    titleSize = size;
    titleLines = wrapped;
    if (wrapped.length <= 3) break;
  }
  ctx.font = `700 ${titleSize}px "Almarai", sans-serif`;
  titleLines = clampLines(titleLines, 3, contentW, measure);
  ctx.fillStyle = PAPER;
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  let y = 96 + 56 + 44 + titleSize;
  const titleLH = Math.round(titleSize * 1.35);
  for (const line of titleLines) {
    ctx.fillText(line, right, y);
    y += titleLH;
  }

  // Gold divider under the title.
  const grad = ctx.createLinearGradient(right - 180, 0, right, 0);
  grad.addColorStop(0, "#A38954");
  grad.addColorStop(1, GOLD_LIGHT);
  ctx.fillStyle = grad;
  ctx.fillRect(right - 180, y - titleLH + 26, 180, 5);
  y += 30;

  // Excerpt in the article font.
  if (model.excerpt) {
    ctx.font = '400 42px "Almarai", sans-serif';
    const lines = clampLines(wrapLines(model.excerpt, contentW, measure), 6, contentW, measure);
    ctx.fillStyle = BODY;
    y += 42;
    for (const line of lines) {
      ctx.fillText(line, right, y);
      y += 66;
    }
  }

  // Attribution (required on liked cards).
  if (model.attribution) {
    ctx.font = '500 36px "Almarai", sans-serif';
    const lines = clampLines(wrapLines(model.attribution, contentW, measure), 2, contentW, measure);
    ctx.fillStyle = GOLD_LIGHT;
    y += 48;
    for (const line of lines) {
      ctx.fillText(line, right, y);
      y += 54;
    }
  }

  // Footer: author + app name, centered.
  ctx.textAlign = "center";
  ctx.fillStyle = PAPER;
  ctx.font = '700 46px "Almarai", sans-serif';
  ctx.fillText(model.authorLine, W / 2, H - 148);
  ctx.fillStyle = GOLD_LIGHT;
  ctx.font = '700 40px "Almarai", sans-serif';
  ctx.fillText(model.appLine, W / 2, H - 88);

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png encode failed"))), "image/png"),
  );
}
