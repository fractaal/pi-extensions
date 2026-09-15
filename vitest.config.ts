import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/tests/**/*.test.ts", "scripts/tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "packages/goal-x/tests/**"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
  },
});
