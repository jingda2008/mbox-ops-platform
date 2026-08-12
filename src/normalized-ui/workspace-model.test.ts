import { describe, expect, it } from 'vitest'
import type { StaffBootstrapView } from '../shared/normalized-contracts'
import {
  initialWorkspaceState,
  workspaceReducer,
} from './workspace-model'

const bootstrap = {
  domainSummaries: [
    { key: 'live', label: '现场', activeCount: 2, attentionCount: 0, readyCount: 0, endpointRef: '/api/operations' },
    { key: 'fulfillment', label: '出品', activeCount: 3, attentionCount: 1, readyCount: 2, endpointRef: '/api/commerce/fulfillment' },
  ],
} as StaffBootstrapView

describe('normalized workspace state', () => {
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
})
