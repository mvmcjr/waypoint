import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // Fixture repos under scripts/fixtures/repos/ ship their own *.test.js files
    // that simulate real projects — they are not our tests.
    exclude: [...configDefaults.exclude, "scripts/fixtures/**", "e2e/**"],
  },
});
