import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { signStaticTableQrToken } from '../dist-server/server/table-access.js'

const baseUrls = (process.env.MBOX_LOAD_BASE_URLS ?? 'http://127.0.0.1:18791,http://127.0.0.1:18792')
  .split(',').map((value) => value.trim().replace(/\/$/, '')).filter(Boolean)
const mode = process.env.MBOX_BROWSER_STARTUP_MODE?.trim() || 'staff'
const samples = Number(process.env.MBOX_BROWSER_STARTUP_SAMPLES ?? 30)
const output = resolve(process.env.MBOX_BROWSER_STARTUP_REPORT_PATH ?? 'artifacts/browser-startup.json')
const targetP95Ms = Number(process.env.MBOX_BROWSER_STARTUP_P95_LIMIT_MS ?? 500)
const diagnosticSettleMs = Number(process.env.MBOX_BROWSER_DIAGNOSTIC_SETTLE_MS ?? 250)
const cpuProfileOutput = process.env.MBOX_BROWSER_CPU_PROFILE_PATH
  ? resolve(process.env.MBOX_BROWSER_CPU_PROFILE_PATH)
  : ''
const accessCode = process.env.MBOX_LOAD_ACCESS_CODE ?? process.env.MBOX_PILOT_ACCESS_CODE ?? 'MBOX521'
const defaultStaffPins = {
  'emp-operations-director': '7001', 'emp-admin': '7002', 'emp-host': '7003', 'emp-mia': '7004',
  'emp-chen': '7005', 'emp-qing': '7006', 'emp-cashier': '7007', 'emp-lin': '7008',
  'emp-wu': '7009', 'emp-jie': '7010', 'emp-han': '7011', 'emp-tao': '7012',
}
const staffPins = JSON.parse(process.env.MBOX_LOAD_STAFF_PINS_JSON ?? JSON.stringify(defaultStaffPins))

if (!['staff', 'guest'].includes(mode)) throw new Error('MBOX_BROWSER_STARTUP_MODE must be staff or guest')
if (!Number.isSafeInteger(samples) || samples < 30) throw new Error('browser startup requires at least 30 samples')
if (!Number.isSafeInteger(diagnosticSettleMs) || diagnosticSettleMs < 0 || diagnosticSettleMs > 2_000) {
  throw new Error('MBOX_BROWSER_DIAGNOSTIC_SETTLE_MS must be an integer from 0 to 2000')
}
if (baseUrls.length < 2) throw new Error('browser startup requires at least two API instances')
await mkdir(dirname(output), { recursive: true })
if (cpuProfileOutput) await mkdir(dirname(cpuProfileOutput), { recursive: true })

function percentile(values, ratio) {
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0
}

function round(value) { return Math.round(value * 10) / 10 }

async function staffSession(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/pilot-login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mbox-test-stage': 'setup',
      'x-mbox-test-phase': 'browser_setup',
    },
    body: JSON.stringify({ accessCode, actorId: 'emp-chen', employeePin: staffPins['emp-chen'] }),
  })
  if (!response.ok) throw new Error(`staff session ${response.status}: ${(await response.text()).slice(0, 200)}`)
  return response.json()
}

const browser = await chromium.launch({ headless: true })
const observations = []
const phaseObservations = []
const failures = []
try {
  for (let index = 0; index < samples; index += 1) {
    const baseUrl = baseUrls[index % baseUrls.length]
    const context = await browser.newContext({
      viewport: mode === 'guest' ? { width: 390, height: 844 } : { width: 430, height: 932 },
      locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce',
      extraHTTPHeaders: {
        'x-mbox-test-stage': 'measured',
        'x-mbox-test-phase': mode === 'staff' ? 'browser_staff' : 'browser_guest',
      },
    })
    try {
      await context.addInitScript((readyMode) => {
        const selector = readyMode === 'staff' ? '.role-home' : 'nav[aria-label="菜单分类"]'
        const markReady = () => {
          if (window.__mboxReadyAt || !document.querySelector(selector)) return
          window.__mboxReadyAt = performance.now()
          requestAnimationFrame(() => requestAnimationFrame(() => {
            window.__mboxPaintedAt = performance.now()
          }))
        }
        const observer = new MutationObserver(markReady)
        observer.observe(document, { childList: true, subtree: true })
        document.addEventListener('DOMContentLoaded', markReady, { once: true })
      }, mode)
      let path = '/'
      if (mode === 'staff') {
        const session = await staffSession(baseUrl)
        await context.addInitScript((value) => {
          localStorage.setItem('mbox.auth.token', value.token)
          localStorage.setItem('mbox.auth.expires-at', String(value.expiresAt))
          localStorage.setItem('mbox.actor.id', value.employee.id)
          localStorage.setItem('mbox.actor.name', value.employee.displayName)
        }, session)
      } else {
        const token = signStaticTableQrToken({
          storeId: 'mbox-lujiazui', tableCode: 'W01', tokenVersion: 1, issuedAt: Date.now(),
        }, process.env.MBOX_QR_SECRET ?? 'rc68-qr-secret-0123456789abcdef0123456789abcdef')
        // Tokens live in the URL fragment so browsers never send them in the
        // HTTP request line, reverse-proxy logs, referrers, or server access logs.
        path = `/guest?table=W01#token=${encodeURIComponent(token)}`
      }
      const page = await context.newPage()
      const profileSession = cpuProfileOutput && index === 0 ? await context.newCDPSession(page) : null
      if (profileSession) {
        await profileSession.send('Profiler.enable')
        await profileSession.send('Profiler.setSamplingInterval', { interval: 100 })
        await profileSession.send('Profiler.start')
      }
      const responseFailures = []
      const requestFailures = []
      const pageErrors = []
      page.on('response', (response) => {
        if (response.url().includes('/api/') && response.status() >= 400) {
          responseFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`)
        }
      })
      page.on('requestfailed', (request) => {
        requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'unknown'}`)
      })
      page.on('pageerror', (error) => pageErrors.push(error.message))
      const requiredApiPath = mode === 'staff' ? '/api/bootstrap' : '/api/guest/session'
      let apiReadyAt = 0
      const requiredApiResponse = page.waitForResponse((response) => {
        const url = new URL(response.url())
        return url.pathname === requiredApiPath && response.status() >= 200 && response.status() < 300
      }, { timeout: 10_000 }).then(() => {
        apiReadyAt = performance.now()
        return null
      }, (error) => error)
      const startedAt = performance.now()
      await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' })
      const domReadyAt = performance.now()
      const ready = mode === 'staff' ? page.locator('.role-home') : page.getByRole('navigation', { name: '菜单分类' })
      await ready.waitFor({ state: 'visible', timeout: 10_000 })
      const uiReadyAt = performance.now()
      const requiredApiError = await requiredApiResponse
      if (requiredApiError) throw requiredApiError
      await page.locator('button:enabled:visible, a[href]:visible').first().waitFor({ state: 'visible', timeout: 10_000 })
      await page.waitForFunction(() => Number(window.__mboxPaintedAt ?? 0) > 0, null, { timeout: 10_000 })
      // Keep the measured value at two-frame paint, then observe a short
      // diagnostic window so lazy chunks and immediate follow-up APIs cannot
      // fail just after the test has already declared success.
      if (diagnosticSettleMs > 0) await page.waitForTimeout(diagnosticSettleMs)
      if (responseFailures.length) throw new Error(`API failures: ${responseFailures.slice(0, 3).join(', ')}`)
      if (requestFailures.length) throw new Error(`request failures: ${requestFailures.slice(0, 3).join(', ')}`)
      if (pageErrors.length) throw new Error(`page errors: ${pageErrors.slice(0, 3).join(', ')}`)
      const playwrightObservedAt = performance.now()
      const browserTiming = await page.evaluate(() => {
        const navigation = performance.getEntriesByType('navigation')[0]
        const resources = performance.getEntriesByType('resource')
          .map((entry) => ({ name: entry.name, duration: entry.duration, transferSize: 'transferSize' in entry ? entry.transferSize : 0 }))
          .sort((left, right) => right.duration - left.duration)
          .slice(0, 5)
        return navigation ? {
          readyMs: Number(window.__mboxReadyAt ?? 0),
          paintedMs: Number(window.__mboxPaintedAt ?? 0),
          responseEndMs: navigation.responseEnd,
          domContentLoadedMs: navigation.domContentLoadedEventEnd,
          loadEventMs: navigation.loadEventEnd,
          resources,
        } : {
          readyMs: Number(window.__mboxReadyAt ?? 0),
          paintedMs: Number(window.__mboxPaintedAt ?? 0),
          responseEndMs: 0,
          domContentLoadedMs: 0,
          loadEventMs: 0,
          resources,
        }
      })
      observations.push(round(browserTiming.paintedMs))
      phaseObservations.push({
        domReadyMs: round(domReadyAt - startedAt),
        apiReadyMs: round(apiReadyAt - startedAt),
        browserReadyMs: round(browserTiming.readyMs),
        browserPaintedMs: round(browserTiming.paintedMs),
        playwrightUiReadyMs: round(uiReadyAt - startedAt),
        playwrightObservedMs: round(playwrightObservedAt - startedAt),
        browserTiming,
      })
      if (profileSession) {
        const { profile } = await profileSession.send('Profiler.stop')
        await writeFile(cpuProfileOutput, `${JSON.stringify(profile)}\n`, 'utf8')
      }
    } catch (error) {
      failures.push({ index, message: error instanceof Error ? error.message : String(error) })
    } finally {
      await context.close()
    }
  }
} finally {
  await browser.close()
}

const report = {
  schemaVersion: 1,
  mode,
  measurementClass: 'fresh_browser_context_page_readiness',
  diagnosticSettleMs,
  testStage: 'measured',
  testPhase: mode === 'staff' ? 'browser_staff' : 'browser_guest',
  measurement: mode === 'staff'
    ? 'navigation start to visible and painted role home in a fresh browser context with an existing store verification'
    : 'navigation start to visible and painted guest menu categories in a fresh browser context from a static table QR',
  samples,
  successful: observations.length,
  failures: failures.length,
  p50Ms: round(percentile(observations, 0.5)),
  p95Ms: round(percentile(observations, 0.95)),
  p99Ms: round(percentile(observations, 0.99)),
  maxMs: round(Math.max(0, ...observations)),
  phases: {
    domReadyP95Ms: round(percentile(phaseObservations.map((item) => item.domReadyMs), 0.95)),
    apiReadyP95Ms: round(percentile(phaseObservations.map((item) => item.apiReadyMs), 0.95)),
    browserReadyP95Ms: round(percentile(phaseObservations.map((item) => item.browserReadyMs), 0.95)),
    browserPaintedP95Ms: round(percentile(phaseObservations.map((item) => item.browserPaintedMs), 0.95)),
    playwrightUiReadyP95Ms: round(percentile(phaseObservations.map((item) => item.playwrightUiReadyMs), 0.95)),
    playwrightObservedP95Ms: round(percentile(phaseObservations.map((item) => item.playwrightObservedMs), 0.95)),
  },
  slowestSample: phaseObservations.toSorted((left, right) => right.browserPaintedMs - left.browserPaintedMs)[0] ?? null,
  target: { minimumSamples: 30, p95Ms: targetP95Ms },
  failureSamples: failures.slice(0, 10),
  passed: observations.length === samples && failures.length === 0
    && percentile(observations, 0.95) <= targetP95Ms,
}
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (!report.passed) process.exitCode = 1
