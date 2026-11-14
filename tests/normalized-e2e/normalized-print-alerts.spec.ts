import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import type { PrintAlertSnapshot } from '../../src/shared/print-alerts'

for (const width of [320, 1280]) test(`active print alarms, sound and recovery at ${width}px`, async ({page}) => {
  const fixture = JSON.parse(await readFile('artifacts/normalized-browser/fixture.json', 'utf8'))
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({width, height: 900})
  await page.addInitScript(() => {
    // The browser verifies the user-gesture and announcement flow, not speakers.
    Object.assign(window, {printTestTones: 0, AudioContext: class {
      state = 'running'; currentTime = 0; destination = {}
      async resume() {} async close() {}
      createOscillator() {return {connect() {}, frequency: {value: 0}, start() {Object.assign(window, {printTestTones: (window as unknown as {printTestTones: number}).printTestTones + 1})}, stop() {}}}
      createGain() {return {connect() {}, gain: {setValueAtTime() {}, linearRampToValueAtTime() {}}}}
    }})
  })
  let status = 200
  let data: PrintAlertSnapshot = {alerts: [], manager: true, asOf: new Date().toISOString()}
  await page.route('**/api/hardware/print-alerts', route => route.fulfill({status,
    contentType: 'application/json', body: JSON.stringify(status === 200 ? {data} : {error: {message: 'isolated fault', code: 'TEST_FAILURE'}})}))
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button', {name: /验证设备/}).click()
  const cashier = fixture.employees.find((employee: {roleNames: string[]}) => employee.roleNames.includes('收银员'))
  await page.getByLabel('员工账号').fill(cashier.code)
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button', {name: /进入工作台/}).click()
  const notice = page.getByRole('complementary', {name: '打印故障主动提醒'})
  await expect(notice.getByText('打印监测中', {exact: true})).toBeVisible()
  await notice.getByRole('button', {name: '开启打印提醒声音'}).click()
  const tones = () => page.evaluate(() => (window as unknown as {printTestTones: number}).printTestTones)
  expect(await tones()).toBe(2)
  const refresh = () => page.evaluate(() => window.dispatchEvent(new Event('online')))
  data = {...data, alerts: [{station: 'bar', failed: 1, stalled: 0, oldestAt: new Date().toISOString(), newestKey: '12345678-1234-4234-8234-123456789012', escalated: false}]}
  await refresh()
  await expect(notice.getByText('打印异常，请核对出纸', {exact: true})).toBeVisible()
  await expect.poll(tones).toBe(4)
  await refresh()
  await expect(notice.getByText('1 张失败或结果不确定', {exact: false})).toBeVisible()
  expect(await tones()).toBe(4)
  await notice.getByText('查看处理方法', {exact: true}).click()
  await expect(notice.getByText(/结果不确定时，核实原票/)).toBeVisible()
  await notice.getByRole('button', {name: '暂缓声音 5 分钟'}).click()
  await expect(notice.getByText('声音已暂缓，新故障仍会提醒。')).toBeVisible()
  await notice.getByRole('button', {name: '重新检查打印状态'}).click()
  await expect(notice.getByText('声音已暂缓，新故障仍会提醒。')).toBeVisible()
  expect(await tones()).toBe(4)
  data = {...data, alerts: [{...data.alerts[0]!, failed: 2, escalated: true, newestKey: '22345678-1234-4234-8234-123456789012'}]}
  await refresh()
  await expect(notice.getByText('管理员请处理：打印异常持续未恢复', {exact: true})).toBeVisible()
  await expect.poll(tones).toBe(6)
  const sizes = await notice.locator('button').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height))
  expect(sizes.every(height => height >= 44)).toBe(true)
  expect(await notice.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  status = 503
  await refresh()
  await expect(notice.getByText('打印监测连接中断', {exact: true})).toBeVisible()
  await expect(notice.getByText(/上次读取/)).toBeVisible()
  status = 200; data = {...data, alerts: []}
  await refresh()
  await expect(notice.getByText('打印监测中', {exact: true})).toBeVisible()
  await expect(notice.getByText('打印异常，请核对出纸', {exact: true})).toHaveCount(0)
  expect(await tones()).toBe(6)
  status = 403; await refresh()
  await expect(notice).toHaveCount(0)
  expect(errors).toEqual([])
})
