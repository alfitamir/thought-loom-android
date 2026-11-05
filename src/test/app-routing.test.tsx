import { QueryClient } from "@tanstack/react-query";
import { createRouter, rootRouteId } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { routeTree } from "@/routeTree.gen";

// Match routes without running loaders or rendering: loaders may need a server or
// network the test run lacks, and jsdom never loads the stylesheets React waits on.
describe("App routing", () => {
  it("matches a page for / instead of falling back to not found", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    const matches = router.matchRoutes("/");

    expect(matches.at(-1)?.routeId).not.toBe(rootRouteId);
  });

  it("matches a page for /medical instead of falling back to not found", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    const matches = router.matchRoutes("/medical");

    expect(matches.at(-1)?.routeId).not.toBe(rootRouteId);
    expect(matches.at(-1)?.routeId).toBe("/medical");
  });

  it("matches a page for /songs instead of falling back to not found", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    const matches = router.matchRoutes("/songs");

    expect(matches.at(-1)?.routeId).not.toBe(rootRouteId);
    expect(matches.at(-1)?.routeId).toBe("/songs");
  });

  it("parses the medical-section context on / and ignores junk values", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    // The «القسم الطبي» capture buttons deep-link with both params.
    const linked = router.matchRoutes("/", { record: "1234567890", section: "medical" });
    expect(linked.at(-1)?.search).toMatchObject({ record: 1234567890, section: "medical" });

    // A junk value stays a raw string in the merged match search (same as
    // the record nonce); the home page's strict `section === "medical"`
    // check is what keeps it from ever raising the medical context.
    const junk = router.matchRoutes("/", { record: "1234567890", section: "other" });
    expect((junk.at(-1)?.search as { section?: unknown } | undefined)?.section).not.toBe("medical");
  });

  it("parses the bottom-nav record nonce on / and ignores junk values", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    // matchRoutes takes the raw (string-valued) search separately from the path.
    const linked = router.matchRoutes("/", { record: "1234567890" });
    expect(linked.at(-1)?.routeId).not.toBe(rootRouteId);
    expect(linked.at(-1)?.search).toMatchObject({ record: 1234567890 });

    // A junk value is not coerced to a number; it stays a raw string in the
    // merged match search, which is why the home page's effect only opens the
    // recorder for a positive number. The route itself still matches.
    const junk = router.matchRoutes("/", { record: "abc" });
    expect(junk.at(-1)?.routeId).not.toBe(rootRouteId);
    expect(typeof (junk.at(-1)?.search as { record?: unknown } | undefined)?.record).not.toBe(
      "number",
    );
  });
});
