import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ActionList, StaffActionsPanel } from './StaffActionsPanel'
import type { StaffActionsApiPort } from './staff-actions-api'
import type { StaffFulfillmentData, StaffOperationsData, StaffReservation } from './types'

describe('StaffActionsPanel', () => {
  it('renders a compact honest loading state before authoritative data arrives', () => {
    const api: StaffActionsApiPort = {
      loadOperations: vi.fn(() => new Promise<StaffOperationsData>(() => undefined)),
      loadFulfillment: vi.fn(() => new Promise<StaffFulfillmentData>(() => undefined)),
      loadReservations: vi.fn(() => new Promise<StaffReservation[]>(() => undefined)),
      loadTableAssignments: vi.fn(), loadTableAssignmentOptions: vi.fn(),
      assignTables: vi.fn(), endTableAssignment: vi.fn(),
      openTable: vi.fn(), closeTable: vi.fn(), transferTable: vi.fn(),
      completeServiceTask: vi.fn(), runKdsAction: vi.fn(), actOnReservation: vi.fn(),
      loadAssistedOrderAccess: vi.fn(), loadAssistedOrderCatalog: vi.fn(),
      issueAssistedOrderContext: vi.fn(), submitAssistedOrder: vi.fn(), createOnlinePayment: vi.fn(), queryOnlinePayment: vi.fn(),
    }
    const html = renderToStaticMarkup(createElement(StaffActionsPanel, { api }))

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
})
