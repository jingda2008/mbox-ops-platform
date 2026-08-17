import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { reservationPerformanceRevisionApiPlugin } from './reservation-performance-revision-api.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'

const scope = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  storeId: '10000000-0000-4000-8000-000000000002',
}
const employeeId = '10000000-0000-4000-8000-000000000003'
const customerId = '10000000-0000-4000-8000-000000000004'
const staffContext = { scope, employeeId, businessDate: '2026-08-17' }
const customerContext = { scope, customerId, actorRef: 'reservation-session:test', businessDate: '2026-08-17' }

describe('reservation performance revision API', () => {
  it('requires the dedicated configurable permission and a reason for a schedule revision', async () => {
    const permissions: string[] = []
    const service = serviceMock()
    const app = await application(service, {
      assertPermission: async (_employeeId: string, permission: string) => { permissions.push(permission) },
    })
    const response = await app.inject({
      method: 'POST', url: '/staff/performance-revisions',
      headers: { 'idempotency-key': 'performance-revision-reschedule-001' },
      payload: {
        scheduleId: '20000000-0000-4000-8000-000000000001', kind: 'rescheduled',
        startsAt: '2026-08-20T12:00:00.000Z', endsAt: '2026-08-20T14:00:00.000Z',
        reason: '歌手交通延误，确认整体顺延一小时',
      },
    })
    expect(response.statusCode).toBe(201)
    expect(permissions).toEqual(['performance.schedule.revise'])
    expect(service.revise).toHaveBeenCalledWith(staffContext, {
      scheduleId: '20000000-0000-4000-8000-000000000001', kind: 'rescheduled',
      startsAt: '2026-08-20T12:00:00.000Z', endsAt: '2026-08-20T14:00:00.000Z',
      replacementScheduleId: null, reason: '歌手交通延误，确认整体顺延一小时',
      idempotencyKey: 'performance-revision-reschedule-001',
    })
    await app.close()
  })

  it('rejects a revision when the employee lacks the dedicated permission', async () => {
    const service = serviceMock()
    const app = await application(service, {
      assertPermission: async () => { throw new StaffAccessDeniedError('performance.schedule.revise') },
    })
    const response = await app.inject({
      method: 'POST', url: '/staff/performance-revisions',
      headers: { 'idempotency-key': 'performance-revision-cancel-001' },
      payload: {
        scheduleId: '20000000-0000-4000-8000-000000000001', kind: 'cancelled',
        reason: '演员临时身体不适，确认本场取消',
      },
    })
    expect(response.statusCode).toBe(403)
    expect(service.revise).not.toHaveBeenCalled()
    await app.close()
  })

  it('keeps staff impact visibility separate from mutation authority', async () => {
    const permissions: string[] = []
    const service = serviceMock()
    const app = await application(service, {
      assertPermission: async (_employeeId: string, permission: string) => { permissions.push(permission) },
    })
    const response = await app.inject({
      method: 'GET',
      url: '/staff/performance-revisions/performance-revision-001/impacts',
    })
    expect(response.statusCode).toBe(200)
    expect(permissions).toEqual(['reservation.view'])
    expect(service.listRevisionImpacts).toHaveBeenCalledWith(staffContext, 'performance-revision-001')
    await app.close()
  })

  it('lists only the authenticated customer family impacts through the resolved context', async () => {
    const service = serviceMock()
    const app = await application(service)
    const response = await app.inject({
      method: 'GET', url: '/public/reservation/performance-impacts',
    })
    expect(response.statusCode).toBe(200)
    expect(service.listCustomerImpacts).toHaveBeenCalledWith(customerContext)
    await app.close()
  })

  it('accepts keep/reselect/clear from the authenticated customer context', async () => {
    const service = serviceMock()
    const app = await application(service)
    const response = await app.inject({
      method: 'POST',
      url: '/public/reservation/performance-impacts/reservation-impact-001/acknowledgements',
      headers: { 'idempotency-key': 'reservation-performance-reselect-001' },
      payload: {
        decision: 'reselect',
        selectedScheduleId: '20000000-0000-4000-8000-000000000002',
      },
    })
    expect(response.statusCode).toBe(200)
    expect(service.acknowledge).toHaveBeenCalledWith(customerContext, {
      impactPublicId: 'reservation-impact-001', decision: 'reselect',
      selectedScheduleId: '20000000-0000-4000-8000-000000000002',
      idempotencyKey: 'reservation-performance-reselect-001',
    })
    await app.close()
  })

  it('rejects customer and reservation identity claims before the service call', async () => {
    const service = serviceMock()
    const app = await application(service)
    const response = await app.inject({
      method: 'POST',
      url: '/public/reservation/performance-impacts/reservation-impact-001/acknowledgements',
      headers: { 'idempotency-key': 'reservation-performance-spoof-001' },
      payload: {
        decision: 'clear',
        customerId: '20000000-0000-4000-8000-000000000099',
        reservationId: '20000000-0000-4000-8000-000000000098',
      },
    })
    expect(response.statusCode).toBe(400)
    expect(service.acknowledge).not.toHaveBeenCalled()
    await app.close()
  })

  it('fails input validation before calling mutation for an unsupported decision', async () => {
    const service = serviceMock()
    const app = await application(service)
    const response = await app.inject({
      method: 'POST',
      url: '/public/reservation/performance-impacts/reservation-impact-001/acknowledgements',
      headers: { 'idempotency-key': 'reservation-performance-invalid-001' },
      payload: { decision: 'cancel_reservation' },
    })
    expect(response.statusCode).toBe(400)
    expect(service.acknowledge).not.toHaveBeenCalled()
    await app.close()
  })
})

function serviceMock() {
  return {
    revise: vi.fn(async () => ({
      value: { publicId: 'performance-revision-new', affectedReservations: 2 }, replayed: false,
    })),
    listRevisionImpacts: vi.fn(async () => []),
    listCustomerImpacts: vi.fn(async () => []),
    acknowledge: vi.fn(async () => ({
      value: { publicId: 'reservation-impact-001', acknowledgement: { decision: 'keep' } },
      replayed: false,
    })),
  }
}

async function application(
  service = serviceMock(),
  access = { assertPermission: async () => undefined },
) {
  const app = Fastify()
  await app.register(reservationPerformanceRevisionApiPlugin, {
    transactions: { run: async (_scope, callback) => callback({ scope } as never) },
    service: service as never,
    resolveCustomerContext: () => customerContext,
    resolveStaffContext: () => staffContext,
    createStaffAccessRepository: () => access,
  })
  return app
}
