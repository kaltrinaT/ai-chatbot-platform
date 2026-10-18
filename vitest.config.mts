import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Run by `npm run test:security` and `npm run evaluate:security:concurrency`
    // instead (see vitest.security.config.mts and vitest.concurrency.config.mts).
    exclude: ["src/security-e2e/**", "src/security-concurrency/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/lib/**", "src/app/**/actions.ts", "src/app/api/**/route.ts"],
    },
  },
});
