import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/voice/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { transcribeVoice } = await import("@/lib/voice-transcribe.server");
        return transcribeVoice(request);
      },
    },
  },
});
