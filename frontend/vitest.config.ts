import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Extends the app's Vite config with test-only settings. Kept separate from
// vite.config.ts so the production `tsc -b` typecheck stays clean.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
      css: false,
    },
  }),
);
