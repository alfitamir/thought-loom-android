import { describe, expect, it } from "vitest";
import { arabicNumber } from "./format";
import { arabicNumber as arabicNumberViaArchivePick } from "./archive-pick";

describe("arabicNumber (shared display formatting)", () => {
  it("renders every Western digit as its Arabic-Indic counterpart", () => {
    expect(arabicNumber(0)).toBe("٠");
    expect(arabicNumber(7)).toBe("٧");
    expect(arabicNumber(42)).toBe("٤٢");
    expect(arabicNumber(1234567890)).toBe("١٢٣٤٥٦٧٨٩٠");
  });

  it("is the one formatter: the archive-pick re-export is the same function", () => {
    expect(arabicNumberViaArchivePick).toBe(arabicNumber);
    expect(arabicNumberViaArchivePick(2026)).toBe("٢٠٢٦");
  });
});
