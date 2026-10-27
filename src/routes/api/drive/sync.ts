import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/drive/sync")({
  server: { handlers: { POST: async ({ request }) => {
    const { driveSync } = await import("@/lib/drive-sync.server");
    return driveSync(request);
  } } },
});
