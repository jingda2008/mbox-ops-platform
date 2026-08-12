import { describe, expect, it, vi } from 'vitest'
import { StaffActionsApi, StaffActionsApiError } from './staff-actions-api'

describe('StaffActionsApi', () => {
  it('uses the normalized table command contract and never reports success from a failed response', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'CAPACITY_OVERRIDE_REASON_REQUIRED', message: '请填写加座说明' },
    }), { status: 422, headers: { 'content-type': 'application/json' } }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'open-key-0001' })

    await expect(api.openTable({ tableId: 'table-1', guestCount: 6 })).rejects.toMatchObject({
      code: 'CAPACITY_OVERRIDE_REASON_REQUIRED', status: 422,
    })
    expect(send).toHaveBeenCalledWith('/api/table-management/sessions/open', expect.objectContaining({
      method: 'POST', credentials: 'include',
    }))
    const headers = send.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('x-idempotency-key')).toBe('staff-action-open-key-0001')
  })

  it('marks a close as partial when begin-closing succeeded but close did not', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'CONFLICT', message: '状态已变化' } }), {
        status: 409, headers: { 'content-type': 'application/json' },
      }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'close-key-0001' })

    await expect(api.closeTable('session-1')).rejects.toEqual(expect.objectContaining({
      code: 'TABLE_CLOSE_PARTIAL', partialMutation: true,
    } satisfies Partial<StaffActionsApiError>))
    expect(send).toHaveBeenNthCalledWith(1, '/api/table-sessions/session-1/begin-closing', expect.any(Object))
    expect(send).toHaveBeenNthCalledWith(2, '/api/table-sessions/session-1/close', expect.any(Object))
  })

  it('sends only supported KDS actions to the authoritative KDS endpoint', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const api = new StaffActionsApi({ fetch: send, createIdempotencyKey: () => 'kds-key-0001' })

    await api.runKdsAction('task-1', 'deliver')
    expect(send).toHaveBeenCalledWith('/api/commerce/kds/task-1/actions', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ action: 'deliver' }),
    }))
  })
})
