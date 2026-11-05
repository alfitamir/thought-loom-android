import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/drive/song-audio")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { driveSongAudio } = await import("@/lib/drive-song.server");
        return driveSongAudio(request);
      },
    },
  },
});
