import fs from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'

// Local synthetic fixture only. After login all writes are blocked: this records
// rendered controls and read-only disclosure states, not mutation acceptance.
const out = path.resolve(process.env.STAFF_AUDIT_OUT ?? 'artifacts/staff-every-control-20260920')
const baseURL = process.env.STAFF_AUDIT_URL ?? 'http://127.0.0.1:18897'
if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname)) throw new Error('This audit requires a local fixture')
const fixture = JSON.parse(fs.readFileSync(process.env.NORMALIZED_E2E_FIXTURE_FILE ?? path.join(out, 'default-fixture.json'), 'utf8'))
const browser = await chromium.launch({ headless: true })
const results = []
const only = process.env.STAFF_AUDIT_EMPLOYEES?.split(',')
const width = Number(process.env.STAFF_AUDIT_WIDTH ?? 390)
const run = process.env.STAFF_AUDIT_RUN ?? 'default-390'
const folder = path.join(out, run)
fs.mkdirSync(folder, { recursive: true })
try {
  for (const employee of fixture.employees.filter(item => !only || only.includes(item.code))) {
    const context = await browser.newContext({ baseURL, viewport: { width, height: 844 }, isMobile: width < 600, hasTouch: width < 600, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    const errors = [], badResponses = [], blockedWrites = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) badResponses.push({ path: new URL(response.url()).pathname, status: response.status() }) })
    await page.goto(fixture.staffUrl)
    await page.getByLabel('门店口令').fill(fixture.dailyCredential)
    await page.getByRole('button', { name: /验证设备/ }).click()
    await page.getByLabel('员工账号').fill(employee.code)
    await page.getByLabel('四位 PIN').fill(fixture.employeePin)
    await page.getByRole('button', { name: /进入工作台/ }).click()
    await page.getByTestId('normalized-workspace').waitFor()
    await page.route('**/api/**', route => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.continue()
      blockedWrites.push({ path: new URL(route.request().url()).pathname, method: route.request().method() })
      return route.abort('blockedbyclient')
    })
    const routes = [...new Set(['/', ...employee.navigationRoutes])]
    for (const route of routes) {
      const record = { employee: employee.code, roles: employee.roleNames, route, width, states: [], errors: [], badResponses: [], blockedWrites: [] }
      errors.length = 0; badResponses.length = 0; blockedWrites.length = 0
      try {
        await page.goto(route)
        if (route === '/') await page.getByTestId('normalized-workspace').waitFor()
        else await page.locator('.normalized-staff-action-shell h1,.normalized-staff-action-shell h2,.normalized-route-notice[role="alert"]').first().waitFor()
        await settle(page)
        record.states.push(await snapshot(page, 'initial'))
        await disclosures(page)
        record.states.push(await snapshot(page, 'disclosures'))
        // Section nav is an explicit read-only local UI control.
        const sections = await page.locator('.staff-task-section-nav > button').allTextContents()
        for (const section of sections) {
          await page.locator('.staff-task-section-nav > button').filter({ hasText: section }).first().click()
          await settle(page)
          await disclosures(page)
          record.states.push(await snapshot(page, `section:${section}`))
        }
        if (record.states.some(state => state.overflow > 1 || state.controls.some(control => control.missingName))) {
          await page.screenshot({ path: path.join(folder, `${employee.code}-${route.replaceAll('/', '_') || 'home'}.png`), fullPage: true })
        }
      } catch (error) { record.failure = error.message }
      record.errors = [...new Set(errors)]
      record.badResponses = [...new Map(badResponses.map(item => [`${item.status}:${item.path}`, item])).values()]
      record.blockedWrites = [...blockedWrites]
      results.push(record)
      fs.writeFileSync(path.join(folder, 'pages.json'), JSON.stringify(results, null, 2) + '\n')
      console.log(JSON.stringify({ employee: employee.code, route, states: record.states.length, errors: record.errors.length, http: record.badResponses, failure: record.failure, overflow: Math.max(...record.states.map(state => state.overflow)) }))
    }
    await context.close()
  }
} finally { await browser.close() }
const summary = { run, width, employeeCount: new Set(results.map(item => item.employee)).size, routes: [...new Set(results.map(item => item.route))], visits: results.length, states: results.reduce((n, item) => n + item.states.length, 0), failures: results.filter(item => item.failure).map(item => ({ employee: item.employee, route: item.route, failure: item.failure })), pageErrors: results.filter(item => item.errors.length).map(item => ({ employee: item.employee, route: item.route, errors: item.errors })), httpErrors: results.filter(item => item.badResponses.length).map(item => ({ employee: item.employee, route: item.route, errors: item.badResponses })), overflow: results.flatMap(item => item.states.filter(state => state.overflow > 1).map(state => ({ employee: item.employee, route: item.route, state: state.name, pixels: state.overflow }))) }
fs.writeFileSync(path.join(folder, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))

async function settle(page) {
  await page.waitForTimeout(450)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function disclosures(page) {
  for (let pass = 0; pass < 3; pass++) {
    const details = page.locator('details:not([open]) > summary:visible')
    for (const element of await details.elementHandles()) {
      try { await element.click({ timeout: 1500 }); await settle(page) } catch { /* The next state records unavailable controls. */ }
    }
    const buttons = page.locator('button[aria-expanded="false"]:not(.normalized-session-trigger):not(nav button):visible')
    for (const button of await buttons.elementHandles()) {
      try { if (await button.isEnabled()) { await button.click({ timeout: 1500 }); await settle(page) } } catch { /* No blind retries. */ }
    }
    if (!(await page.locator('details:not([open]) > summary:visible,button[aria-expanded="false"]:not(.normalized-session-trigger):not(nav button):visible').count())) break
  }
}
async function snapshot(page, name) {
  return page.evaluate(name => {
    const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
    const clean = text => (text ?? '').replace(/\s+/g, ' ').trim()
    const controls = Array.from(document.querySelectorAll('button,a,summary,input,select,textarea,[role="button"],[role="tab"]')).filter(visible).map(element => {
      const rect = element.getBoundingClientRect()
      const labelledBy = element.getAttribute('aria-labelledby')?.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ')
      const label = clean(element.getAttribute('aria-label') || labelledBy || (element.labels && Array.from(element.labels).map(label => label.textContent).join(' ')) || (['BUTTON', 'A', 'SUMMARY'].includes(element.tagName) ? element.textContent : '') || element.getAttribute('title'))
      return { tag: element.tagName.toLowerCase(), type: element.getAttribute('type'), name: label, placeholder: element.getAttribute('placeholder'), disabled: Boolean(element.disabled), expanded: element.getAttribute('aria-expanded'), width: Math.round(rect.width), height: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y), missingName: !label, class: element.className, options: element.tagName === 'SELECT' ? Array.from(element.options).map(option => ({ text: option.text, value: option.value })) : undefined }
    })
    const main = document.querySelector('[data-testid="normalized-workspace"]') ?? document.body
    return { name, url: location.pathname + location.search + location.hash, title: document.title, headings: Array.from(main.querySelectorAll('h1,h2,h3,h4')).filter(visible).map(element => clean(element.textContent)), text: main.innerText, controls, overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth }
  }, name)
}
