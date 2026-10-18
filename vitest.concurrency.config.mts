import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// The PostgreSQL concurrency scenarios (src/security-concurrency). They need
// a real server, so only scripts/evaluate-postgres-concurrency.cjs runs them,
// after starting one in Docker.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/security-concurrency/**/*.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
