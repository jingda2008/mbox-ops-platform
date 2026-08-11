import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.NORMALIZED_E2E_PORT ?? 18_789)

export default defineConfig({
  testDir: './tests/normalized-e2e',
  outputDir: './artifacts/normalized-browser/results',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: './artifacts/normalized-browser/report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: './artifacts/normalized-browser/report', open: 'never' }]],
  use: {
    ...devices['iPhone 14 Pro Max'],
    browserName: 'chromium',
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build:normalized && tsx scripts/start-normalized-browser-e2e.ts',
    env: {
      ...process.env,
      TEST_NORMALIZED_ADMIN_URL: process.env.TEST_NORMALIZED_ADMIN_URL
        ?? 'postgresql://postgres:mbox_test_only@127.0.0.1:55441/postgres',
      NORMALIZED_E2E_PORT: String(port),
      NORMALIZED_E2E_FIXTURE_FILE: 'artifacts/normalized-browser/fixture.json',
      MBOX_STATIC_DIR: 'dist',
    },
    url: `http://127.0.0.1:${port}/api/live`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
})
