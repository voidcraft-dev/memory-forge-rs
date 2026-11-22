import { defineConfig } from "@playwright/test";

const PORT = 1431;
const channel = process.env.E2E_BROWSER_CHANNEL || "msedge";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: channel === "chromium" ? undefined : channel,
    viewport: { width: 1280, height: 820 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
