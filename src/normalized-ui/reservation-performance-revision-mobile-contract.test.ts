import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('reservation performance revision mobile contract', () => {
  it('keeps the customer reservation valid and exposes keep/reselect/clear with retry-safe keys', async () => {
    const [page, view, api] = await Promise.all([
      readFile(new URL('../../miniprogram/pages/reservations/index.js', import.meta.url), 'utf8'),
      readFile(new URL('../../miniprogram/pages/reservations/index.wxml', import.meta.url), 'utf8'),
      readFile(new URL('../../miniprogram/utils/api.js', import.meta.url), 'utf8'),
    ])
    expect(page).toContain('getReservationPerformanceImpacts')
    expect(page).toContain('impactAttempts')
    expect(page).toContain('previous && previous.signature === signature')
    expect(page).toContain('resultingScheduleEligible')
    expect(page).toContain('保留预约，不选演出')
    expect(page).toContain('选择已保留，可直接重试')
    expect(view).toContain('预约仍有效')
    expect(view).toContain('系统都不会自动取消到店预约')
    expect(view).toContain('data-decision="keep"')
    expect(view).toContain('data-decision="reselect"')
    expect(view).toContain('data-decision="clear"')
    expect(api).toContain('/api/public/reservation/performance-impacts/')
    expect(page).not.toContain('cancelCustomerReservation')
  })

  it('keeps WeChat authorization inside the exact reservation context and optional to booking', async () => {
    const [page, view, api] = await Promise.all([
      readFile(new URL('../../miniprogram/pages/reservations/index.js', import.meta.url), 'utf8'),
      readFile(new URL('../../miniprogram/pages/reservations/index.wxml', import.meta.url), 'utf8'),
      readFile(new URL('../../miniprogram/utils/api.js', import.meta.url), 'utf8'),
    ])
    expect(page).toContain('wx.requestSubscribeMessage')
    expect(page).toContain('reservationPublicId')
    expect(page).toContain("platformResult === 'accept'")
    expect(view).toContain('只为这次预约申请一次演出变更提醒')
    expect(page).toContain('未开启提醒，不影响预约和到店')
    expect(api).toContain('/api/public/reservation/performance-notification-authorizations')
    expect(api).toContain('mbox.reservation.performance.notification.')
    expect(page).not.toContain('getWechatNotificationAuthorizations')
  })

  it('keeps touch controls at least 44px and stacks decisions at 390px', async () => {
    const [miniCss, staffCss, staffPanel] = await Promise.all([
      readFile(new URL('../../miniprogram/pages/reservations/index.wxss', import.meta.url), 'utf8'),
      readFile(new URL('./performance-revision-panel.css', import.meta.url), 'utf8'),
      readFile(new URL('./PerformanceRevisionPanel.tsx', import.meta.url), 'utf8'),
    ])
    expect(miniCss).toMatch(/performance-impact-actions button[^}]*min-height:88rpx/)
    expect(miniCss).toContain('@media(max-width:390px)')
    expect(miniCss).toMatch(/performance-impact-actions\{grid-template-columns:1fr\}/)
    expect(staffCss).toMatch(/button[^}]*min-height:44px/)
    expect(staffCss).toContain('@media(max-width:390px)')
    expect(staffPanel).toContain('内容已保留，可核对后重试')
    expect(staffPanel).toContain('pendingAttempt.current?.fingerprint !== fingerprint')
    expect(staffPanel).toContain('idempotencyKey: pendingAttempt.current.key')
    expect(staffPanel).toContain('演出偏好不是座位或场次保证')
  })

  it('retires the direct cancel action from the old performance row', async () => {
    const module = await readFile(new URL('./StaffModulePanel.tsx', import.meta.url), 'utf8')
    expect(module).toContain('<PerformanceRevisionPanel')
    expect(module).not.toContain("transitionSchedule(schedule, 'cancelled')")
  })
})
