import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/articles/improve")({
  server: { handlers: { POST: async ({ request }) => {
    const { improveArticle } = await import("@/lib/article-ai.server");
    return improveArticle(request);
  } } },
});