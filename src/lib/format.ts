// Shared display formatting for user-facing numbers.
//
// The app's display convention for counts in the Arabic UI is Arabic-Indic
// digits (٠١٢٣٤٥٦٧٨٩) — the stats section, the archive card and the settings
// gauges already render that way. Every user-facing count routes through
// the one formatter here so surfaces never mix numeral systems on the same
// screen (audit F-4.2). Functional numbers stay OUT: form inputs, codes,
// and anything parsed back or shown in a Latin-script/directional context
// (e.g. `dir="ltr"` durations) keep Western digits.

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** A number in Arabic-Indic digits — the app's display convention for counts. */
export const arabicNumber = (n: number): string =>
  String(n).replace(/\d/g, (d) => AR_DIGITS.charAt(Number(d)));
