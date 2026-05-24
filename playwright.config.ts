import { defineConfig, devices } from "@playwright/test";

const PROD_URL = "https://yardward-pro.vercel.app";
const LOCAL_URL = "http://localhost:5173";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // mutate shared mock data; keep tests sequential
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    permissions: [], // default: geolocation denied so we test the fallback
  },

  projects: [
    {
      name: "local",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: LOCAL_URL,
      },
    },
    {
      name: "production",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: PROD_URL,
      },
    },
  ],

  webServer: process.env.PW_NO_SERVER
    ? undefined
    : {
        command: "npm run dev",
        url: LOCAL_URL,
        reuseExistingServer: true,
        timeout: 120_000,
        stdout: "ignore",
        stderr: "pipe",
      },
});
