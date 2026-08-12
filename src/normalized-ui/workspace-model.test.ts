import { describe, expect, it } from 'vitest'
import type { StaffBootstrapView } from '../shared/normalized-contracts'
import {
  availableResources,
  initialWorkspaceState,
  resourceItems,
  workspaceReducer,
} from './workspace-model'

const bootstrap = {
  domainSummaries: [
    { key: 'live', label: '现场', activeCount: 2, attentionCount: 0, readyCount: 0, endpointRef: '/api/operations' },
    { key: 'fulfillment', label: '出品', activeCount: 3, attentionCount: 1, readyCount: 2, endpointRef: '/api/commerce/fulfillment' },
  ],
} as StaffBootstrapView

describe('normalized workspace state', () => {
  it('provides immediate loading feedback before a resource request resolves', () => {
    const next = workspaceReducer(initialWorkspaceState(), {
      type: 'resource-loading', resource: 'fulfillment', requestId: 4,
    })

    expect(next.selectedResource).toBe('fulfillment')
    expect(next.resources.fulfillment).toMatchObject({ phase: 'loading', requestId: 4 })
  })

  it('ignores a stale response after a newer request has started', () => {
    const loading = workspaceReducer(initialWorkspaceState(), {
      type: 'resource-loading', resource: 'operations', requestId: 8,
    })
    const stale = workspaceReducer(loading, {
      type: 'resource-ready', resource: 'operations', requestId: 7, data: { tasks: [{ id: 'old' }] },
    })

    expect(stale).toBe(loading)
    expect(stale.resources.operations.phase).toBe('loading')
  })

  it('keeps cached workspace data visible when a refresh fails', () => {
    const ready = workspaceReducer(initialWorkspaceState(), {
      type: 'bootstrap-ready', bootstrap, etag: 'etag-1',
    })
    const refreshing = workspaceReducer(ready, { type: 'bootstrap-loading' })
    const failed = workspaceReducer(refreshing, {
      type: 'bootstrap-error', message: '网络连接失败', loginRequired: false,
    })

    expect(failed.phase).toBe('error')
    expect(failed.bootstrap).toBe(bootstrap)
    expect(failed.message).toBe('网络连接失败')
  })

  it('only exposes resources represented in the permission-filtered bootstrap view', () => {
    expect(availableResources(bootstrap).map((item) => item.resource)).toEqual(['sessions', 'fulfillment'])
  })
})

describe('normalized resource presentation', () => {
  it('reads the correct collection for each normalized endpoint', () => {
    expect(resourceItems('sessions', { tables: [{ id: 'table-1', tableCode: 'VIP1', status: 'open' }] })).toEqual([
      { id: 'table-1', title: 'VIP1', status: 'open', detail: null },
    ])
    expect(resourceItems('operations', { tasks: [{ id: 'task-1', title: '送冰水', status: 'pending' }] })[0]).toMatchObject({
      title: '送冰水', status: 'pending',
    })
    expect(resourceItems('fulfillment', { workItems: [{ id: 'kds-1', productName: '鸡尾酒', normalizedStatus: 'ready' }] })[0]).toMatchObject({
      title: '鸡尾酒', status: 'ready',
    })
  })

  it('limits untrusted endpoint collections to 50 visible rows', () => {
    const items = Array.from({ length: 70 }, (_, index) => ({ id: `task-${index}`, title: `任务${index}` }))
    expect(resourceItems('operations', { tasks: items })).toHaveLength(50)
  })
})
