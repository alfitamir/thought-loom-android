import "@testing-library/jest-dom/vitest";
import { randomUUID as nodeRandomUUID } from "node:crypto";

// jsdom can expose a crypto object without randomUUID (seen as a flaky
// "crypto.randomUUID is not a function" in idea-saving tests); the app uses
// it for new idea ids, so guarantee it in the test environment.
if (typeof globalThis.crypto?.randomUUID !== "function") {
  if (globalThis.crypto) Object.assign(globalThis.crypto, { randomUUID: nodeRandomUUID });
  else Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID: nodeRandomUUID } });
}

Object.defineProperty(window, "scrollTo", {
  writable: true,
  value: () => {},
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
