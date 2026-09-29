import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Figmenta embed harness (see model-switch.spec.ts for how to rerun). Deliberately NOT the app's
// playwright.config.ts: that one's globalSetup starts Metro and a per-worker daemon; this one
// serves the static export and starts its own isolated daemon in the spec.
export default defineConfig({
  testDir: __dirname,
  testMatch: ["**/*.spec.ts"],
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: path.resolve(__dirname, "../test-results/e2e-figmenta-output"),
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
