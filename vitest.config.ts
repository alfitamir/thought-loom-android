import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/lib/**/*.{test,spec}.{ts,tsx}"],
          // Fast unit tests keep vitest's tight default budget.
          testTimeout: 5000,
          hookTimeout: 10000,
        },
      },
      {
        extends: true,
        test: {
          name: "components",
          include: ["src/test/**/*.{test,spec}.{ts,tsx}"],
          // Heavy jsdom component renders: individual tests legitimately take 1–7s and the
          // biggest sat exactly at the 5s default boundary, flaking under full-suite load
          // (audit F-1.1). This project gets a realistic budget instead.
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
    ],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
