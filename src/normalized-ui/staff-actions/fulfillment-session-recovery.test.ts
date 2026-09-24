import { describe, expect, it, vi } from 'vitest'
import { StaffActionsApi } from './staff-actions-api'

const queue = (valid: boolean) => ({ actor: { employeeId: 'bar-1', actionSessionValid: valid }, workItems: [] })
const response = (data: unknown) => new Response(JSON.stringify({ data }))

describe('fulfillment session recovery', () => {
  it.each(['bar','kitchen'] as const)('renews an idle %s screen once and rereads authoritative permissions',async station=>{
    const send=vi.fn<typeof fetch>().mockResolvedValueOnce(response({actionSessionValid:false})).mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({actionSessionValid:true}))
    expect((await new StaffActionsApi({fetch:send}).loadKitchenBoard(undefined,station)).actionSessionValid).toBe(true)
    expect(send.mock.calls.map(([url])=>url)).toEqual([`/api/commerce/kitchen-board?station=${station}`,'/api/auth/heartbeat',`/api/commerce/kitchen-board?station=${station}`])
  })
  it('does not renew a station permission denial',async()=>{
    const send=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'KDS_STATION_FORBIDDEN',message:'岗位不符'}}),{status:403}))
    await expect(new StaffActionsApi({fetch:send}).loadKitchenBoard()).rejects.toMatchObject({status:403})
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('renews a suspended phone session before returning the queue as unavailable', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(queue(false)))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response(queue(true)))
    const result = await new StaffActionsApi({ fetch: send }).loadFulfillment()
    expect(result.actor.actionSessionValid).toBe(true)
    expect(send.mock.calls.map(([url]) => url)).toEqual([
      '/api/commerce/fulfillment', '/api/auth/heartbeat', '/api/commerce/fulfillment',
    ])
    expect(send.mock.calls[1][1]).toMatchObject({ method: 'POST', credentials: 'include' })
  })

  it('requires login when the server rejects an expired or revoked session', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(queue(false)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'AUTHENTICATION_REQUIRED', message: '请重新登录' } }), { status: 401 }))
    await expect(new StaffActionsApi({ fetch: send }).loadFulfillment()).rejects.toMatchObject({ status: 401 })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not renew an already valid session', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response(queue(true)))
    await new StaffActionsApi({ fetch: send }).loadFulfillment()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('preserves server denial after one renewal attempt without looping', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(queue(false)))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response(queue(false)))
    expect((await new StaffActionsApi({ fetch: send }).loadFulfillment()).actor.actionSessionValid).toBe(false)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('surfaces a network failure without pretending that operation permission recovered', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(queue(false)))
      .mockRejectedValueOnce(new TypeError('offline'))
    await expect(new StaffActionsApi({ fetch: send }).loadFulfillment()).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(send).toHaveBeenCalledTimes(2)
  })
})
