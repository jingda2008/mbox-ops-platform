import { defineConfig, devices } from '@playwright/test'

const apiPort = Number(process.env.MBOX_E2E_API_PORT ?? 18_787)
const webPort = Number(process.env.MBOX_E2E_WEB_PORT ?? 15_173)

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './artifacts/playwright/results',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: './artifacts/playwright/report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: './artifacts/playwright/report', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${webPort}`,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node --import tsx server/index.ts',
      env: {
        ...process.env,
        API_PORT: String(apiPort),
        MBOX_RUNTIME_MODE: 'test',
        MBOX_REPOSITORY: 'json',
        MBOX_JSON_STATE_PATH: '.runtime/e2e-state.json',
        MBOX_LOG_LEVEL: 'warn',
        MBOX_ASSISTANT_PROVIDER: 'gemini_interactions',
        MBOX_GEMINI_API_KEY: 'e2e-only-key-never-sent-to-a-provider',
        MBOX_GEMINI_ENDPOINT: 'http://127.0.0.1:9/e2e-assistant-must-not-be-called',
      },
      url: `http://127.0.0.1:${apiPort}/api/health`,
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${webPort}`,
      env: {
        ...process.env,
        API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
        VITE_MBOX_LOCAL_ACTOR_ID: 'emp-chen',
      },
      url: `http://127.0.0.1:${webPort}`,
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
})
