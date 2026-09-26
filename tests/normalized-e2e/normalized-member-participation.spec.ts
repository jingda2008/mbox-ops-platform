import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import type { MemberParticipation } from '../../src/shared/member-participation'

async function login(page: Page) {
  const fixture = JSON.parse(await readFile('artifacts/normalized-browser/fixture.json', 'utf8'))
  await page.goto(fixture.staffUrl)
  await page.getByLabel('门店口令').fill(fixture.dailyCredential)
  await page.getByRole('button', { name: /验证设备/ }).click()
  await page.getByLabel('员工账号').fill('liyan')
  await page.getByLabel('四位 PIN').fill(fixture.employeePin)
  await page.getByRole('button', { name: /进入工作台/ }).click()
  await expect(page.getByTestId('normalized-workspace')).toBeVisible()
  await page.goto('/staff/tasks')
}
function result(memberNo: string): MemberParticipation {
  return { memberNo, displayName: memberNo === 'MBX-AAAAAA' ? '会员甲' : '会员乙', checkedAt: new Date().toISOString(),
    activitiesVisible: true, activities: [], benefits: [], registrations: [{ publicId: 'scan-registration', activityPublicId: 'scan-activity', title: '超嗨测试活动', startsAt: new Date().toISOString(), partySize: 2, guidance: '已确认报名，现场核对本人及人数后可签到', readyForCheckIn: true }] }
}
async function lookup(page: Page, code: string) {
  await page.getByLabel('输入会员号或核销码').fill(code)
  await page.getByRole('button', { name: '查询活动与权益', exact: true }).click()
}

test('real member lookup is read-only, errors are visible, and claim scanning stays on the existing path', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  const commands: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && /\/(check-in|redeem|fulfill-package|registrations)$/.test(new URL(request.url()).pathname)) commands.push(request.url())
  })
  await lookup(page, 'MBOX_MEMBER_V1:MBX-CARD320')
  const card = page.getByRole('region', { name: '会员活动与权益查询' })
  await expect(card).toContainText('MBX-CARD320')
  await expect(card).toContainText('扫码只查询')
  await card.screenshot({ path: testInfo.outputPath('member-query-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  await lookup(page, 'MBX-NOTFOUND')
  await expect(card.getByRole('alert')).toBeVisible()
  await expect(card).not.toContainText('MBX-CARD320')
  await lookup(page, 'MBOX_CLAIM_V1:DSN-EXAMPLE')
  await expect(card).toHaveCount(0)
  expect(commands).toEqual([])
})

test('a late previous member response and a failed refresh cannot leave a different member visible', async ({ page }) => {
  await login(page)
  let releaseFirst!: () => void
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve })
  let firstStarted = false
  let fail = false
  await page.route('**/api/staff/member-participation/lookup', async route => {
    const code = route.request().postDataJSON().code
    if (code === 'MBX-AAAAAA') { firstStarted = true; await firstHeld }
    await route.fulfill(fail ? { status: 503, json: { error: { code: 'UNAVAILABLE', message: '查询暂时失败' } } }
      : { json: { data: result(code) } }).catch(() => {})
  })
  await lookup(page, 'MBX-AAAAAA')
  await expect.poll(() => firstStarted).toBe(true)
  await lookup(page, 'MBX-BBBBBB')
  const card = page.getByRole('region', { name: '会员活动与权益查询' })
  await expect(card).toContainText('会员乙')
  releaseFirst()
  await expect(card).not.toContainText('会员甲')
  fail = true
  await card.getByRole('button', { name: '重新查询' }).click()
  await expect(card.getByRole('alert')).toBeVisible()
  await expect(card.getByRole('alert')).not.toContainText('结果尚未确认')
  await expect(card).not.toContainText('会员乙')
  fail = false
  await card.getByRole('button', { name: '重新查询' }).click()
  await expect(card).toContainText('会员乙')
})

test('lookup opens the matching activity and filters the roster without submitting check-in', async ({ page }) => {
  await login(page)
  const at = new Date().toISOString()
  const activity = { publicId: 'scan-activity', title: '超嗨测试活动', status: 'published', startsAt: at, endsAt: at,
    assemblyLocation: '门店', capacity: 10, occupiedSeats: 2, waitlistedSeats: 0, registrationCount: 2,
    paymentMode: 'none', feeAmountMinor: 0, currency: 'CNY', kind: 'member_night', summary: '', coverUrl: null,
    depositAmountMinor: 0, feeBasis: 'per_registration', paymentDeadlineMinutes: 15, paymentRuleText: '免费',
    pointsReward: 0, visibility: 'public', audienceMemberLevels: [], audienceLifecycleStages: [],
    safetyRequirements: [], includedItems: [], participationRequirements: [], packages: [], updatedAt: at,
    safetyPolicyVersion: null, safetyAcknowledgementText: null, refundPolicyVersion: null, refundPolicySummary: null,
    activityDetails: null, contactInstructions: null, memberBenefitText: null }
  const registration = { publicId: 'scan-registration', customerLabel: '会员乙', partySize: 2, status: 'confirmed',
    paymentStatus: 'not_required', paymentChoice: 'none', contactVersionPublicId: 'contact', maskedContact: '无',
    totalFeeAmountMinor: 0, amountDueMinor: 0, paidAmountMinor: 0, currency: 'CNY', registeredAt: at,
    requestedPaymentChoice: 'none', requestedAmountDueMinor: 0, packageFulfillmentStatus: 'not_required', refund: null,
    memberLevel: null, requestedPaymentMethod: null, paymentDueAt: null, checkedInAt: null, paymentId: null,
    authoritativePaymentStatus: null, providerActionState: null }
  await page.route('**/api/staff/member-participation/lookup', route => route.fulfill({ json: { data: result('MBX-BBBBBB') } }))
  await page.route('**/api/staff/activity-operations', route => route.fulfill({ json: { data: [activity] } }))
  await page.route('**/api/staff/activity-operations/scan-activity', route => route.fulfill({ json: { data: { activity, registrations: [registration, { ...registration, publicId: 'another-registration', customerLabel: '其他会员' }] } } }))
  let writes = 0
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/activity-operations/')) writes++ })
  await lookup(page, 'MBX-BBBBBB')
  await page.getByRole('link', { name: '查看报名与签到' }).click()
  await expect(page.getByText('本次扫码会员的报名', { exact: true })).toBeVisible()
  await expect(page.getByLabel('仅显示本次扫码报名')).toBeChecked()
  await expect(page.locator('.activity-registration-list')).toContainText('会员乙')
  await expect(page.locator('.activity-registration-list')).not.toContainText('其他会员')
  await page.getByLabel('仅显示本次扫码报名').uncheck()
  await expect(page.locator('.activity-registration-list')).toContainText('其他会员')
  expect(writes).toBe(0)
})
