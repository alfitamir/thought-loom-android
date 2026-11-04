import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The web app manifest is a static repo file (public/manifest.json, copied to
// the build output verbatim and linked from the root route's head). These
// tests pin its app-icon shortcuts: long-pressing the installed PWA icon must
// offer «سجّل فكرة» / «فكرة طبية» / «مقالاتي», in this order.
//
// The two record shortcuts carry a STATIC `record` value on purpose: a
// manifest URL cannot mint a fresh nonce per tap. That is safe because the
// home route consumes `record` in an effect that runs on mount (and on param
// change) for ANY positive finite number, then clears the param with
// `replace` — so the fixed value 1 opens the recorder on a fresh launch and
// the param never lingers to block or repeat the open. The assertions below
// re-check the value against the route's validation contract (positive
// finite number; `section` only ever "medical").

interface ManifestIcon {
  src: string;
  sizes?: string;
  type?: string;
  purpose?: string;
}

interface ManifestShortcut {
  name: string;
  url: string;
  icons?: ManifestIcon[];
}

interface WebManifest {
  name: string;
  icons: ManifestIcon[];
  shortcuts?: ManifestShortcut[];
}

const manifestPath = path.resolve(process.cwd(), "public/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WebManifest;

describe("public/manifest.json app-icon shortcuts", () => {
  it("is valid JSON with exactly the three shortcuts, in order", () => {
    expect(manifest.shortcuts).toHaveLength(3);
    expect(manifest.shortcuts?.map((s) => s.name)).toEqual(["سجّل فكرة", "فكرة طبية", "مقالاتي"]);
    expect(manifest.shortcuts?.map((s) => s.url)).toEqual([
      "/?record=1",
      "/?record=1&section=medical",
      "/library",
    ]);
  });

  it("record shortcuts satisfy the home route's search contract", () => {
    const [idea, medical] = manifest.shortcuts ?? [];
    if (!idea || !medical) throw new Error("record shortcuts missing");
    for (const shortcut of [idea, medical]) {
      const url = new URL(shortcut.url, "https://example.invalid");
      expect(url.pathname).toBe("/");
      // The route validator keeps `record` only when Number(raw) is a
      // positive finite number — the static manifest value must pass it.
      const record = Number(url.searchParams.get("record"));
      expect(Number.isFinite(record)).toBe(true);
      expect(record).toBeGreaterThan(0);
    }
    // Only the medical shortcut raises the born-medical context.
    const ideaUrl = new URL(idea.url, "https://example.invalid");
    expect(ideaUrl.searchParams.get("section")).toBeNull();
    const medicalUrl = new URL(medical.url, "https://example.invalid");
    expect(medicalUrl.searchParams.get("section")).toBe("medical");
  });

  it("library shortcut points at the library route", () => {
    const library = manifest.shortcuts?.[2];
    expect(library?.url).toBe("/library");
  });

  it("every shortcut reuses one of the manifest's own icon assets", () => {
    const ownIcons = new Set(manifest.icons.map((i) => i.src));
    for (const shortcut of manifest.shortcuts ?? []) {
      expect(shortcut.icons?.length).toBeGreaterThan(0);
      for (const icon of shortcut.icons ?? []) {
        expect(ownIcons.has(icon.src)).toBe(true);
      }
    }
  });
});
