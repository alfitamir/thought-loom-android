import { Link } from "@tanstack/react-router";
import { Mic } from "lucide-react";

/**
 * The home recorder's deep-link contract, in one place: a fresh `record`
 * nonce (the home route opens the recorder form for any positive number it
 * has not seen) plus the optional section context that makes everything
 * saved from that session be born inside the section. Pure and explicit
 * about the clock so tests can pin freshness down.
 */
export function buildRecordSearch(section?: "medical", now: number = Date.now()) {
  return section === "medical" ? { record: now, section: "medical" as const } : { record: now };
}

/**
 * Floating «سجّل فكرة» for routes the bottom navigation does not reach.
 * The bar already carries this exact action on "/" and "/library", so the
 * FAB exists ONLY where the bar is hidden but capturing still makes sense
 * (today: the medical section) — never alongside the bar. It deep-links to
 * the home recorder with the CURRENT section's context, in the primary
 * record styling (the bar's raised filled circle), parked at the bottom
 * end corner above where a nav would sit, safe-area aware.
 */
export function RecordFab({ section }: { section?: "medical" }) {
  const label = section === "medical" ? "سجّل فكرة طبية" : "سجّل فكرة";
  return (
    <Link
      to="/"
      search={buildRecordSearch(section)}
      aria-label={label}
      title={label}
      className="fixed end-5 bottom-[calc(1.25rem+env(safe-area-inset-bottom))] z-40 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
    >
      <Mic className="size-7" />
    </Link>
  );
}
