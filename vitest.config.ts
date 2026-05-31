import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      thresholds: {
        statements: 85,
        functions: 80,
        branches: 75,
        lines: 85,
      },
      exclude: [
        "test/**",
        "dist/**",
        "**/*.d.ts",
        "src/index.ts",
        "src/types.ts",
      ],
    },
  },
});
