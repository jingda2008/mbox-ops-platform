import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test'

interface Fixture {
  guestUrl: string
  staffUrl: string
  dailyCredential: string
  employeeCode: string
  employeePin: string
}

interface StartupSample {
  readyMs: number
  responseEndMs: number
  domContentLoadedMs: number
  criticalApiPathMs: number
}

interface StartupMetric {
  samples: number
  successful: number
  failures: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  responseEndP95Ms: number
  domContentLoadedP95Ms: number
  criticalApiPathP50Ms: number
  criticalApiPathP95Ms: number
  criticalApiPathP99Ms: number
  criticalApiPathMaxMs: number
  failureSamples: Array<{ sample: number; message: string }>
}

const sampleCount = Number(process.env.NORMALIZED_BROWSER_STARTUP_SAMPLES ?? 30)
const p95LimitMs = Number(process.env.NORMALIZED_BROWSER_STARTUP_P95_LIMIT_MS ?? 500)
const p99LimitMs = Number(process.env.NORMALIZED_BROWSER_STARTUP_P99_LIMIT_MS ?? 1_000)
const reportPath = resolve(process.env.NORMALIZED_BROWSER_STARTUP_REPORT ?? 'artifacts/normalized-browser/startup.json')

test('normalized employee and guest pages satisfy the real-browser startup gate', async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  if (!baseURL) throw new Error('normalized browser startup requires a baseURL')
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 30) throw new Error('startup gate requires at least 30 samples per mode')

  const fixture = await loadFixture()
  const staffStorageState = await authenticatedStaffState(browser, baseURL, fixture)
  const guestState = await authenticatedGuestState(browser, baseURL, fixture)
  const shared: BrowserContextOptions = {
    baseURL,
    viewport: { width: 430, height: 932 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
  }
  const employee = await measure(browser, {
    ...shared,
    storageState: staffStorageState,
  }, fixture.staffUrl, 'employee', sampleCount)
  const guest = await measure(browser, {
    ...shared,
    storageState: guestState.storageState,
  }, guestState.path, 'guest', sampleCount, guestState.deviceKey)
  const report = {
    schemaVersion: 'normalized-browser-startup-v1',
    run: {
      mode: 'real_browser_isolated_postgres',
      evidenceEligible: true,
      sourceCommitSha: process.env.APP_COMMIT_SHA ?? 'local-uncommitted',
      generatedAt: new Date().toISOString(),
    },
    workload: {
      freshBrowserContextPerSample: true,
      samplesPerMode: sampleCount,
      employeeSessionPreparedOutsideMeasurement: true,
      guestSessionPreparedOutsideMeasurement: true,
      staticTableQrScanCoveredByCommercialFlow: true,
    },
    metrics: {
      employeeStartup: summarize(employee),
      guestSessionStartup: summarize(guest),
    },
    gate: {
      thresholds: { minimumSamples: 30, p95Ms: p95LimitMs, p99Ms: p99LimitMs },
      checks: [] as Array<{ id: string; actual: number; limit: number; passed: boolean }>,
      passed: false,
    },
  }
  for (const [name, metric] of Object.entries(report.metrics)) {
    report.gate.checks.push(
      { id: `${name}.samples`, actual: metric.samples, limit: 30, passed: metric.samples >= 30 },
      { id: `${name}.failures`, actual: metric.failures, limit: 0, passed: metric.failures === 0 },
      { id: `${name}.p95`, actual: metric.p95Ms, limit: p95LimitMs, passed: metric.p95Ms <= p95LimitMs },
      { id: `${name}.p99`, actual: metric.p99Ms, limit: p99LimitMs, passed: metric.p99Ms <= p99LimitMs },
      { id: `${name}.criticalApiP95`, actual: metric.criticalApiPathP95Ms, limit: p95LimitMs, passed: metric.criticalApiPathP95Ms <= p95LimitMs },
      { id: `${name}.criticalApiP99`, actual: metric.criticalApiPathP99Ms, limit: p99LimitMs, passed: metric.criticalApiPathP99Ms <= p99LimitMs },
    )
  }
  report.gate.passed = report.gate.checks.every((check) => check.passed)
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  expect(report.gate.passed, JSON.stringify(report, null, 2)).toBe(true)
})

async function loadFixture(): Promise<Fixture> {
  const path = resolve(process.env.NORMALIZED_E2E_FIXTURE_FILE ?? 'artifacts/normalized-browser/fixture.json')
  return JSON.parse(await readFile(path, 'utf8')) as Fixture
}

async function authenticatedGuestState(browser: Browser, baseURL: string, fixture: Fixture) {
  const deviceKey = 'normalized-startup-guest-device-0001'
  const context = await browser.newContext({ baseURL })
  try {
    await context.addInitScript((key) => {
      sessionStorage.setItem('mbox-normalized-guest-device-v1', key)
    }, deviceKey)
    const page = await context.newPage()
    await page.goto(fixture.guestUrl)
    await expect(page.getByTestId('normalized-guest-app')).toBeVisible()
    await expect(page.locator('button[aria-label^="加入"]').first()).toBeVisible()
    const url = new URL(fixture.guestUrl, baseURL)
    url.hash = ''
    return { storageState: await context.storageState(), deviceKey, path: `${url.pathname}${url.search}` }
  } finally {
    await context.close()
  }
}

async function authenticatedStaffState(browser: Browser, baseURL: string, fixture: Fixture) {
  const context = await browser.newContext({ baseURL })
  try {
    const page = await context.newPage()
    await page.goto(fixture.staffUrl)
    await page.getByLabel('门店口令').fill(fixture.dailyCredential)
    await page.getByRole('button', { name: /验证设备/ }).click()
    await page.getByLabel('员工账号').fill(fixture.employeeCode)
    await page.getByLabel('四位 PIN').fill(fixture.employeePin)
    await page.getByRole('button', { name: /进入工作台/ }).click()
    await expect(page.getByTestId('normalized-workspace')).toBeVisible()
    return context.storageState()
  } finally {
    await context.close()
  }
}

async function measure(
  browser: Browser,
  contextOptions: BrowserContextOptions,
  path: string,
  mode: 'employee' | 'guest',
  samples: number,
  guestDeviceKey?: string,
): Promise<{ successful: StartupSample[]; failures: Array<{ sample: number; message: string }> }> {
  const successful: StartupSample[] = []
  const failures: Array<{ sample: number; message: string }> = []
  for (let sample = 1; sample <= samples; sample += 1) {
    const context = await browser.newContext(contextOptions)
    try {
      if (mode === 'guest' && guestDeviceKey) {
        await context.addInitScript((key) => {
          sessionStorage.setItem('mbox-normalized-guest-device-v1', key)
        }, guestDeviceKey)
      }
      const page = await context.newPage()
      await installReadinessProbe(page, mode)
      const problems: string[] = []
      page.on('pageerror', (error) => problems.push(`page:${error.message}`))
      page.on('requestfailed', (request) => {
        const failure = request.failure()?.errorText ?? 'failed'
        if (failure !== 'net::ERR_ABORTED') problems.push(`request:${safePath(request.url())}:${failure}`)
      })
      page.on('response', (response) => {
        if (response.url().includes('/api/') && response.status() >= 400) {
          problems.push(`api:${response.status()}:${safePath(response.url())}`)
        }
      })
      await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 10_000 })
      await page.waitForFunction(() => Number((window as StartupWindow).__normalizedStartupPaintedAt ?? 0) > 0, null, { timeout: 10_000 })
      await page.waitForTimeout(50)
      if (problems.length > 0) throw new Error(problems.slice(0, 5).join(', '))
      const observation = await page.evaluate((startupMode) => {
        const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
        const rounded = (value: number) => Math.round(value * 100) / 100
        const criticalPaths = startupMode === 'employee'
          ? new Set(['/api/auth/session', '/api/staff/workspace'])
          : new Set(['/api/guest/session', '/api/guest/menu/products'])
        const criticalResources = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
          .filter((entry) => {
            try { return criticalPaths.has(new URL(entry.name).pathname) } catch { return false }
          })
        const criticalStart = Math.min(...criticalResources.map((entry) => entry.startTime))
        const criticalEnd = Math.max(...criticalResources.map((entry) => entry.responseEnd))
        return {
          readyMs: rounded(Number((window as StartupWindow).__normalizedStartupPaintedAt ?? 0)),
          responseEndMs: rounded(navigation?.responseEnd ?? 0),
          domContentLoadedMs: rounded(navigation?.domContentLoadedEventEnd ?? 0),
          criticalApiPathMs: rounded(Number.isFinite(criticalStart) && Number.isFinite(criticalEnd) ? criticalEnd - criticalStart : 0),
        }
      }, mode)
      if (observation.criticalApiPathMs <= 0) throw new Error(`${mode} critical startup API timing is missing`)
      successful.push(observation)
    } catch (error) {
      failures.push({ sample, message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) })
    } finally {
      await context.close()
    }
  }
  return { successful, failures }
}

async function installReadinessProbe(page: Page, mode: 'employee' | 'guest') {
  await page.addInitScript((startupMode) => {
    const windowState = window as StartupWindow
    const ready = () => {
      if (windowState.__normalizedStartupPaintedAt) return
      const target = startupMode === 'employee'
        ? document.querySelector('[data-testid="normalized-workspace"] button:not(:disabled)')
        : document.querySelector('[data-testid="normalized-guest-app"] button[aria-label^="加入"]:not(:disabled)')
      if (!target || target.getBoundingClientRect().width <= 0 || target.getBoundingClientRect().height <= 0) return
      windowState.__normalizedStartupReadyAt = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => {
        windowState.__normalizedStartupPaintedAt = performance.now()
      }))
    }
    new MutationObserver(ready).observe(document, { childList: true, subtree: true, attributes: true })
    document.addEventListener('DOMContentLoaded', ready, { once: true })
  }, mode)
}

function summarize(result: Awaited<ReturnType<typeof measure>>): StartupMetric {
  const ready = result.successful.map((sample) => sample.readyMs)
  return {
    samples: ready.length + result.failures.length,
    successful: ready.length,
    failures: result.failures.length,
    p50Ms: percentile(ready, 0.5),
    p95Ms: percentile(ready, 0.95),
    p99Ms: percentile(ready, 0.99),
    maxMs: round(Math.max(0, ...ready)),
    responseEndP95Ms: percentile(result.successful.map((sample) => sample.responseEndMs), 0.95),
    domContentLoadedP95Ms: percentile(result.successful.map((sample) => sample.domContentLoadedMs), 0.95),
    criticalApiPathP50Ms: percentile(result.successful.map((sample) => sample.criticalApiPathMs), 0.5),
    criticalApiPathP95Ms: percentile(result.successful.map((sample) => sample.criticalApiPathMs), 0.95),
    criticalApiPathP99Ms: percentile(result.successful.map((sample) => sample.criticalApiPathMs), 0.99),
    criticalApiPathMaxMs: round(Math.max(0, ...result.successful.map((sample) => sample.criticalApiPathMs))),
    failureSamples: result.failures.slice(0, 10),
  }
}

function percentile(values: number[], ratio: number) {
  const sorted = values.toSorted((left, right) => left - right)
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0)
}

function round(value: number) { return Math.round(value * 100) / 100 }
function safePath(value: string) { try { return new URL(value).pathname } catch { return 'invalid-url' } }

interface StartupWindow extends Window {
  __normalizedStartupReadyAt?: number
  __normalizedStartupPaintedAt?: number
}
