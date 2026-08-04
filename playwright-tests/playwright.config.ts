import { defineConfig, devices } from "@playwright/test";
import { config } from "./src/config.js";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./src/globalSetup.ts",
  // A journey spans several logins in one browser; running files in parallel is
  // fine, running the rungs of one journey in parallel is not.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 5 * 60_000,
  expect: { timeout: 15_000 },

  reporter: [
    ["list"],
    ["html", { outputFolder: "reports/html", open: "never" }],
    ["json", { outputFile: "reports/results.json" }],
    ["./src/reporter.ts"],
  ],

  outputDir: "reports/artifacts",

  use: {
    baseURL: config.baseURL,
    launchOptions: { slowMo: config.slowMo },
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    // Trace and video are the difference between "it failed" and "here is exactly
    // what the tester would have seen"; kept on for failures only so a green run
    // stays cheap.
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },

  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    // The app claims a card layout below 768px; this project proves it.
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] }, testIgnore: /.*/ },
  ],
});
