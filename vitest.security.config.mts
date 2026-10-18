import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// The local end-to-end security scenarios (src/security-e2e), run by
// `npm run evaluate:security:e2e`, which turns their results into evidence.
// Kept out of the default suite: SEC-E2E-04 starts hundreds of bash
// processes, which takes minutes on Windows.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/security-e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
