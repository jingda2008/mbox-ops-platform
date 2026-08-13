import { chromium } from '@playwright/test'

const baseUrl = process.env.MBOX_RELEASE_SMOKE_URL?.replace(/\/$/, '')
const expectedSha = process.env.MBOX_RELEASE_EXPECTED_SHA
const routes = [
  { path: '/', selector: '#root' },
  { path: '/guest?table=W01', selector: '#root' },
  { path: '/reserve', selector: '#root' },
  { path: '/staff/live', selector: '#root' },
]

if (!baseUrl || !expectedSha || !/^[0-9a-f]{40}$/.test(expectedSha)) {
  throw new Error('rendered browser smoke requires URL and full expected SHA')
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 430, height: 932 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
})
const failures = []
try {
  for (const route of routes) {
    const page = await context.newPage()
    const pageFailures = []
    page.on('pageerror', (error) => pageFailures.push(`page:${error.message}`))
    page.on('requestfailed', (request) => {
      if (['script', 'stylesheet'].includes(request.resourceType())) {
        pageFailures.push(`${request.resourceType()}:${new URL(request.url()).pathname}`)
      }
    })
    page.on('response', (response) => {
      const resourceType = response.request().resourceType()
      if (['script', 'stylesheet'].includes(resourceType) && response.status() >= 400) {
        pageFailures.push(`${resourceType}:${new URL(response.url()).pathname}=HTTP ${response.status()}`)
      }
    })
    try {
      const response = await page.goto(`${baseUrl}${route.path}`, { waitUntil: 'domcontentloaded', timeout: 10_000 })
      if (response?.status() !== 200) pageFailures.push(`HTTP ${response?.status() ?? 'missing'}`)
      const buildSha = await page.locator('meta[name="mbox-build-commit"]').getAttribute('content')
      if (buildSha !== expectedSha) pageFailures.push(`build=${buildSha ?? 'missing'}`)
      const root = page.locator(route.selector)
      await root.waitFor({ state: 'attached', timeout: 5_000 })
      await page.waitForFunction(() => {
        const node = document.querySelector('#root')
        return node !== null && node.children.length > 0 && (node.textContent?.trim().length ?? 0) > 0
      }, undefined, { timeout: 8_000 })
      await page.waitForTimeout(250)
    } catch (error) {
      pageFailures.push(error instanceof Error ? error.message : String(error))
    } finally {
      await page.close()
    }
    if (pageFailures.length > 0) failures.push(`${route.path}: ${pageFailures.join(', ')}`)
  }
} finally {
  await context.close()
  await browser.close()
}

if (failures.length > 0) throw new Error(`rendered browser smoke failed: ${failures.join(' | ')}`)
process.stdout.write(`${JSON.stringify({ verified: true, url: baseUrl, releaseSha: expectedSha, routes: routes.map((entry) => entry.path) })}\n`)
