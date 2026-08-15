import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { StaffBootstrapView } from '../shared/normalized-contracts'
import { NormalizedStaffWorkspaceView } from './NormalizedStaffWorkspace'
import { initialWorkspaceState, workspaceReducer } from './workspace-model'

function view(): StaffBootstrapView {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-11T12:00:00.000Z',
    watermark: 'watermark-1',
    store: {
      id: 'store-1', code: 'lujiazui', name: 'M-BOX', timezone: 'Asia/Shanghai',
      businessDayCutoff: '06:00:00', currency: 'CNY',
    },
    businessDay: { date: '2026-08-11', status: 'open', openedAt: null, rolloverAt: null, closedAt: null },
    staff: { id: 'staff-1', code: 'LIYAN', displayName: '李艳', roleCodes: ['MANAGER'], roleNames: ['店长'] },
    access: {
      permissions: ['dashboard.view', 'service.view', 'kds.deliver'], deniedPermissions: [], dataScopes: [],
      approvalLimits: [], resolvedAt: '2026-08-11T12:00:00.000Z',
    },
    navigation: [
      { code: 'live', label: '现场', route: '/staff/live', icon: null, sortOrder: 1, displayConfig: { highFrequency: true } },
      { code: 'tasks', label: '任务', route: '/staff/tasks', icon: null, sortOrder: 2, displayConfig: {} },
    ],
    highFrequencyEntries: [
      { code: 'live', label: '现场调度', route: '/staff/live', icon: null },
    ],
    domainSummaries: [
      { key: 'live', label: '营业桌台', activeCount: 8, attentionCount: 1, readyCount: 0, endpointRef: '/api/operations' },
      { key: 'service', label: '服务任务', activeCount: 3, attentionCount: 2, readyCount: 0, endpointRef: '/api/operations' },
      { key: 'fulfillment', label: '出品配送', activeCount: 4, attentionCount: 0, readyCount: 2, endpointRef: '/api/commerce/fulfillment' },
    ],
    endpointRefs: {
      workspace: '/api/staff/workspace', sessions: '/api/operations', operations: '/api/operations',
      tableManagement: '/api/table-management/tables', fulfillment: '/api/commerce/fulfillment',
      reservations: '/api/staff/reservations', reservationIntake: '/api/staff/reservation-intake',
      reconciliation: '/api/reconciliation', inventory: '/api/inventory', notifications: '/api/notifications',
      aiCapabilities: '/api/ai/capabilities', hardwareWork: '/api/hardware/work',
    },
  }
}

const callbacks = {
  onRefresh: vi.fn(),
  onNavigate: vi.fn(),
}

function render(state: ReturnType<typeof initialWorkspaceState>): string {
  return renderToStaticMarkup(createElement(NormalizedStaffWorkspaceView, { state, ...callbacks }))
}

describe('NormalizedStaffWorkspaceView', () => {
  it('renders only server-filtered navigation and compact role information', () => {
    const state = workspaceReducer(initialWorkspaceState(), {
      type: 'bootstrap-ready', bootstrap: view(), etag: 'etag-1',
    })
    const html = render(state)

    expect(html).toContain('李艳')
    expect(html).toContain('店长')
    expect(html).toContain('现场调度')
    expect(html).toContain('服务任务')
    expect(html).not.toContain('库存/存酒')
  })

  it('keeps every authorized navigation entry reachable beyond the first five items', () => {
    const bootstrap = view()
    bootstrap.navigation = [
      ...bootstrap.navigation,
      { code: 'reservations', label: '预约', route: '/staff/reservations', icon: null, sortOrder: 3, displayConfig: {} },
      { code: 'performance', label: '演出与点歌', route: '/staff/performance', icon: null, sortOrder: 4, displayConfig: {} },
      { code: 'inventory', label: '库存', route: '/staff/inventory', icon: null, sortOrder: 5, displayConfig: {} },
      { code: 'settings', label: '系统配置', route: '/staff/settings', icon: null, sortOrder: 6, displayConfig: {} },
    ]
    const state = workspaceReducer(initialWorkspaceState(), {
      type: 'bootstrap-ready', bootstrap, etag: 'etag-navigation',
    })
    const html = render(state)

    expect(html).toContain('系统配置')
    expect(html).toContain('当前岗位全部入口')
  })

  it('does not expose a second raw-data sheet beside the executable role pages', () => {
    const state = workspaceReducer(initialWorkspaceState(), {
      type: 'bootstrap-ready', bootstrap: view(), etag: 'etag-1',
    })
    const html = render(state)

    expect(html).not.toContain('按需加载')
    expect(html).not.toContain('available')
    expect(html).toContain('项已就绪')
    expect(html).toContain('下一步先处理什么')
  })

  it('shows active work instead of a misleading zero ready count', () => {
    const bootstrap = view()
    bootstrap.domainSummaries = [
      { key: 'live', label: '营业桌台', activeCount: 1, attentionCount: 0, readyCount: 0, endpointRef: '/api/operations' },
    ]
    const state = workspaceReducer(initialWorkspaceState(), {
      type: 'bootstrap-ready', bootstrap, etag: 'etag-active',
    })
    const html = render(state)

    expect(html).toContain('营业桌台')
    expect(html).toContain('进行中')
    expect(html).not.toContain('0<small>已就绪</small>')
  })

  it('keeps the login-expired state explicit instead of presenting a false workspace', () => {
    const state = workspaceReducer(initialWorkspaceState(), {
      type: 'bootstrap-error', message: '登录信息已过期，请重新登录', loginRequired: true,
    })
    const html = render(state)

    expect(html).toContain('登录已过期')
    expect(html).toContain('重新登录')
    expect(html).not.toContain('现在要做什么')
  })
})
