import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { AuthorizationError } from './authorization.js'
import { JsonRepository } from './repository.js'
import { registerSongRoutes } from './song-api.js'

function employeeId(roleId: string) {
  if (roleId === 'specialist') return 'emp-qing'
  if (roleId === 'supervisor') return 'emp-mia'
  if (roleId === 'manager') return 'emp-chen'
  return 'emp-lin'
}

async function fixture() {
  const repository = new JsonRepository(`/tmp/mbox-song-api-rbac-${crypto.randomUUID()}.json`)
  await repository.init()
  const app = Fastify()
  app.decorateRequest('mboxActor', null)
  app.addHook('preHandler', async (request) => {
    const roleId = String(request.headers['x-test-role'] ?? 'server')
    request.mboxActor = {
      actorId: employeeId(roleId),
      storeId: 'mbox-lujiazui',
      roleId,
      runtimeMode: 'test',
      authenticatedBy: 'local_header',
    }
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthorizationError) {
      return reply.status(error.statusCode).send({ code: error.code, operation: error.operation })
    }
    throw error
  })
  registerSongRoutes(app, repository)
  return { app, repository }
}

async function submitPayload(repository: JsonRepository) {
  const state = await repository.read()
  const performance = state.songState.performanceSessions.find((item) => item.status === 'live')!
  const appearance = performance.appearances.find((item) => item.acceptingRequests)!
  const offer = state.songState.repertoire.find((item) => item.singerId === appearance.singerId && item.enabled)!
  const table = state.songState.tableSessions.find((item) => item.status === 'open')!
  return {
    performanceSessionId: performance.id,
    appearanceId: appearance.id,
    tableSessionId: table.id,
    singerId: appearance.singerId,
    songId: offer.songId,
    requestedBy: 'emp-chen',
    customerNote: '',
    idempotencyKey: 'song-api-submit-actor-0001',
  }
}

describe('song API employee authorization', () => {
  it('rejects roles outside the service team from submitting employee song requests', async () => {
    const { app, repository } = await fixture()
    const response = await app.inject({
      method: 'POST',
      url: '/api/songs/requests',
      headers: { 'x-test-role': 'specialist' },
      payload: await submitPayload(repository),
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ code: 'AUTHORIZATION_DENIED', operation: 'song.request.submit' })
    expect((await repository.read()).songState.requests).toHaveLength(0)
    await app.close()
    await repository.close()
  })

  it('binds submit, payment, and action audit to authenticated employees and blocks service roles from management', async () => {
    const { app, repository } = await fixture()
    const submitted = await app.inject({
      method: 'POST',
      url: '/api/songs/requests',
      payload: await submitPayload(repository),
    })
    expect(submitted.statusCode).toBe(201)
    expect(submitted.json().requestedBy).toBe('emp-lin')
    const requestId = submitted.json().id as string

    const deniedPayment = await app.inject({
      method: 'POST',
      url: `/api/songs/requests/${requestId}/payment`,
      payload: { paymentReference: 'payment-denied', idempotencyKey: 'song-api-payment-denied-0001' },
    })
    expect(deniedPayment.statusCode).toBe(403)
    expect(deniedPayment.json().operation).toBe('song.request.payment')

    const deniedAction = await app.inject({
      method: 'POST',
      url: `/api/songs/requests/${requestId}/actions`,
      payload: { action: 'accept', reason: '', refundReference: '', idempotencyKey: 'song-api-action-denied-0001' },
    })
    expect(deniedAction.statusCode).toBe(403)
    expect(deniedAction.json().operation).toBe('song.request.manage')

    const paid = await app.inject({
      method: 'POST',
      url: `/api/songs/requests/${requestId}/payment`,
      headers: { 'x-test-role': 'manager' },
      payload: { paymentReference: 'payment-manager', idempotencyKey: 'song-api-payment-manager-0001' },
    })
    expect(paid.statusCode).toBe(200)

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/songs/requests/${requestId}/actions`,
      headers: { 'x-test-role': 'manager' },
      payload: { action: 'accept', reason: '', refundReference: '', idempotencyKey: 'song-api-action-manager-0001' },
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().acceptedBy).toBe('emp-chen')

    const state = await repository.read()
    const audit = state.songState.auditEvents.filter((event) => event.requestId === requestId)
    expect(audit.find((event) => event.type === 'song_request.submitted.v1')?.actorId).toBe('emp-lin')
    expect(audit.find((event) => event.type === 'song_request.paid.v1')?.actorId).toBe('emp-chen')
    expect(audit.find((event) => event.type === 'song_request.accepted.v1')?.actorId).toBe('emp-chen')

    await app.close()
    await repository.close()
  })
})
