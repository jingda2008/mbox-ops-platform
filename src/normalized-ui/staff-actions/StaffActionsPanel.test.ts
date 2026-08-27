import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ActionList, filterMemberBenefitTasks, memberBenefitTaskCount, normalizeMemberBenefitScanCode, prioritizeActionFact, splitReservationLoadResults, StaffActionsPanel } from './StaffActionsPanel'
import { ConfirmationDialogProvider } from '../ConfirmationDialog'
import type { StaffActionsApiPort } from './staff-actions-api'
import type { StaffFulfillmentData, StaffOperationsData, StaffReservation } from './types'

describe('StaffActionsPanel', () => {
  it('keeps the final paid-order confirmation as a flat WeChat-green action', () => {
    const css = readFileSync(new URL('./staff-actions-panel.css', import.meta.url), 'utf8')
    const rule = css.match(/\.staff-order-sheet \.menu-cart-drawer-footer > \.menu-submit-button:not\(:disabled\) \{([^}]+)\}/)?.[1]

    expect(rule).toContain('background: #07c160')
    expect(rule).toContain('border-color: #07c160')
    expect(rule).toContain('color: #fff')
    expect(rule).toContain('box-shadow: none')
  })

  it('keeps the member-code input itself touch-sized on phone task pages', () => {
    const css = readFileSync(new URL('./staff-actions-panel.css', import.meta.url), 'utf8')

    expect(css).toMatch(/\.staff-member-benefit-tools input \{[^}]*min-height:\s*44px;/)
  })

  it('keeps the optional open-table scene scoped to table.open and touch-sized', () => {
    const source = readFileSync(new URL('./StaffActionsPanel.tsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('./staff-actions-panel.css', import.meta.url), 'utf8')

    expect(source).toContain("hasPermission(props.permissions, 'table.open')")
    expect(source).toContain('客群场景（可选）')
    expect(source).toContain('guestProfileSnapshot: recommendationSceneSnapshot(openTableRecommendationScene)')
    expect(css).toMatch(/\.staff-open-table-scene select \{[^}]*min-height:\s*42px;/)
  })

  it('keeps a one-tap table collection entry while preserving the full table action sheet', () => {
    const source = readFileSync(new URL('./StaffActionsPanel.tsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('./staff-actions-panel.css', import.meta.url), 'utf8')

    expect(source).toContain('staff-table-quick-payment')
    expect(source).toContain('setTablePaymentOpen(true)')
    expect(source).toContain("'payment.manual.cash.record'")
    expect(css).toMatch(/\.staff-table-quick-payment \{[^}]*min-height:\s*44px/)
    expect(css).toMatch(/\.staff-session-actions \.is-payment \{[^}]*grid-column:\s*1 \/ -1/)
  })

  it('shows read-only served and unserved item detail directly after selecting an active table', () => {
    const source = readFileSync(new URL('./StaffActionsPanel.tsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('./staff-actions-panel.css', import.meta.url), 'utf8')

    expect(source).toContain("hasPermission(permissions, 'service.execute')")
    expect(source).toContain('<TableOrderStatusPanel')
    expect(source).toContain('{props.orderStatusPanel}')
    expect(css).toMatch(/\.staff-table-order-status-item \{[^}]*grid-template-columns:\s*minmax\(0,1fr\) auto auto/)
  })

  it('keeps physical turnover separate from financial follow-up', () => {
    const source = readFileSync(new URL('./StaffActionsPanel.tsx', import.meta.url), 'utf8')

    expect(source).toContain('顾客离店，立即翻台')
    expect(source).toContain('确认立即翻台')
    expect(source).toContain('财务后续处理不阻断物理翻台')
    expect(source).toContain('付款、退款和对账后续会原样保留给收银处理')
  })

  it('renders a compact honest loading state before authoritative data arrives', () => {
    const api: StaffActionsApiPort = {
      loadOperations: vi.fn(() => new Promise<StaffOperationsData>(() => undefined)),
      loadFulfillment: vi.fn(() => new Promise<StaffFulfillmentData>(() => undefined)),
      loadReservations: vi.fn(() => new Promise<StaffReservation[]>(() => undefined)),
      loadTableAssignments: vi.fn(), loadTableAssignmentOptions: vi.fn(),
      assignTables: vi.fn(), endTableAssignment: vi.fn(),
      openTable: vi.fn(), closeTable: vi.fn(), transferTable: vi.fn(),
      completeServiceTask: vi.fn(), runKdsAction: vi.fn(), cancelKdsTask: vi.fn(), actOnReservation: vi.fn(),
      loadAssistedOrderAccess: vi.fn(), loadAssistedOrderCatalog: vi.fn(),
      issueAssistedOrderContext: vi.fn(), submitAssistedOrder: vi.fn(), createOnlinePayment: vi.fn(),
      loadOnlinePaymentStatus: vi.fn(), queryOnlinePayment: vi.fn(),
    }
    const html = renderToStaticMarkup(createElement(
      ConfirmationDialogProvider,
      null,
      createElement(StaffActionsPanel, { api }),
    ))

    expect(html).toContain('正在读取现场')
    expect(html).not.toContain('操作成功')
    expect(html).not.toContain('Runtime' + 'State')
    expect(html).not.toContain('/api/' + 'bootstrap')
  })

  it('renders the empty state when every conditional action is false', () => {
    const html = renderToStaticMarkup(createElement(
      ActionList,
      { empty: '当前没有需要制作或配送的出品' },
      false,
      false,
    ))

    expect(html).toContain('当前没有需要制作或配送的出品')
    expect(html).toContain('staff-actions-empty')
  })

  it('keeps service and fulfillment cards focusable and targets an exact blocker fact', () => {
    const source = readFileSync(new URL('./StaffActionsPanel.tsx', import.meta.url), 'utf8')

    expect(source).toContain('data-action-fact-id={task.id}')
    expect(source).toContain('data-action-fact-id={item.taskId}')
    expect(source).toContain('initialFactId===null')
    expect(source).toContain('scrollIntoView')
    expect(source).toContain("closest('button,input,select,textarea,a')")
    expect(source).toContain("['Enter',' '].includes(event.key)")
  })

  it('keeps a routed blocker fact visible even when it ranks below the first eight actions', () => {
    const actions = Array.from({ length: 12 }, (_, index) => ({ id: `task-${index + 1}` }))

    expect(prioritizeActionFact(actions, 'task-10', (item) => item.id).map((item) => item.id)).toEqual([
      'task-10', 'task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-6', 'task-7',
    ])
  })

  it('keeps the reservation list when the secondary priority queue read fails', () => {
    const reservations = [{ id: 'reservation-1' } as StaffReservation]
    const priorityFailure = new Error('priority queue unavailable')

    const result = splitReservationLoadResults(
      { status: 'fulfilled', value: reservations },
      { status: 'rejected', reason: priorityFailure },
    )

    expect(result.reservations).toEqual(reservations)
    expect(result.reservationError).toBeNull()
    expect(result.priorityQueue).toBeNull()
    expect(result.priorityError).toBe(priorityFailure)
  })

  it('keeps member benefit holds visible on tasks and table scope and supports member-code lookup', () => {
    const tasks = {
      annualGifts: [{
        reservationId:'gift-1',benefitId:'benefit-1',customerId:'customer-1',tableSessionId:'session-1',
        tableCode:'A01',memberNo:'MBX-1001',customerName:'王女士',ruleKind:'birthday' as const,title:'生日礼遇',
        quantity:1,reservedAt:'2026-08-25T01:00:00Z',expiresAt:'2026-08-25T01:15:00Z',
        originalProductId:'product-1',originalProductName:'无酒精特调',allowedProducts:[],
      }],
      dailySnacks: [{
        id:'snack-1',claimCode:'DSN-ABCDEFGHIJ',benefitId:'benefit-2',benefitReservationId:'reservation-2',
        quantity:1,status:'reserved' as const,expiresAt:'2026-08-25T01:15:00Z',redeemedByEmployeeName:null,
        redeemedAt:null,fulfilledAt:null,title:'每日点心',tableCode:'B02',tableSessionId:'session-2',memberNo:'MBX-2002',
      }],
    }

    expect(memberBenefitTaskCount(filterMemberBenefitTasks(tasks,'MBX-1001'))).toBe(1)
    expect(normalizeMemberBenefitScanCode('MBOX_MEMBER_V1:MBX-1001')).toBe('MBX-1001')
    expect(filterMemberBenefitTasks(tasks,'MBOX_CLAIM_V1:DSN-ABCDEFGHIJ').dailySnacks).toHaveLength(1)
    expect(filterMemberBenefitTasks(tasks,'', 'session-2').dailySnacks[0]?.claimCode).toBe('DSN-ABCDEFGHIJ')
    const source = readFileSync(new URL('./StaffActionsPanel.tsx', import.meta.url), 'utf8')
    expect(source).toContain('扫描会员码或点心核销码')
    expect(source).toContain('会员权益待办')
    expect(source).toContain('selectedTable.activeSession.id')
  })
})
