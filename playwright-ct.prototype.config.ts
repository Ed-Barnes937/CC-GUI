// PROTOTYPE — throwaway copy of playwright-ct.config.ts on port 1425, because
// another worktree's vite dev server holds 1420 and `reuseExistingServer`
// would silently test the wrong checkout. Delete with the markdown-viewer
// prototype.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./src/playwright/iwft/scenarios",
  testMatch: "**/*.iwft.ts",
  globalSetup: "./src/playwright/iwft/support/globalSetup.testHelper.ts",
  timeout: 15_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  use: {
    baseURL: "http://localhost:1425",
    testIdAttribute: "data-test",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev -- --port 1425 --strictPort",
    url: "http://localhost:1425",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
