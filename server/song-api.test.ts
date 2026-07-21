import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { AuthorizationError } from './authorization.js'
import { JsonRepository } from './repository.js'
import { registerSongRoutes, SongConfigVersionConflictError } from './song-api.js'

function employeeId(roleId: string) {
  if (roleId === 'owner') return 'emp-owner'
  if (roleId === 'admin') return 'emp-admin'
  if (roleId === 'kitchen') return 'emp-han'
  if (roleId === 'host') return 'emp-host'
  if (roleId === 'cashier') return 'emp-cashier'
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
    if (error instanceof SongConfigVersionConflictError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message, currentVersion: error.currentVersion })
    }
    throw error
  })
  registerSongRoutes(app, repository)
  return { app, repository }
}

async function submitPayload(repository: JsonRepository, idempotencyKey = 'song-api-submit-actor-0001') {
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
    idempotencyKey,
  }
}

async function confirmRequest(app: FastifyInstance, requestId: string, idempotencyKey: string) {
  return app.inject({
    method: 'POST',
    url: `/api/songs/requests/${requestId}/actions`,
    headers: { 'x-test-role': 'server' },
    payload: { action: 'confirm', reason: '', refundReference: '', idempotencyKey },
  })
}

describe('song API employee authorization', () => {
  it('lets a manager configure singers, repertoire and a cross-midnight schedule', async () => {
    const { app, repository } = await fixture()
    const businessDate = (await repository.read()).store.businessDate
    const followingDate = new Date(`${businessDate}T00:00:00.000Z`)
    followingDate.setUTCDate(followingDate.getUTCDate() + 1)
    const nextDate = followingDate.toISOString().slice(0, 10)
    const singerResponse = await app.inject({
      method: 'POST', url: '/api/songs/singers', headers: { 'x-test-role': 'manager' },
      payload: { displayName: '测试驻唱', photoUrl: '', headline: '现场互动', bio: '用于排班配置测试', styleTags: ['流行'], active: true },
    })
    expect(singerResponse.statusCode, singerResponse.body).toBe(201)
    const singerId = singerResponse.json().id as string

    const repertoireResponse = await app.inject({
      method: 'POST', url: `/api/songs/singers/${singerId}/repertoire`, headers: { 'x-test-role': 'manager' },
      payload: { title: '测试歌曲', artist: '测试原唱', durationSeconds: 240, priceAmount: 9800, currency: 'CNY', enabled: true },
    })
    expect(repertoireResponse.statusCode, repertoireResponse.body).toBe(201)

    const performanceResponse = await app.inject({
      method: 'PUT', url: '/api/songs/performances/performance-config-test', headers: { 'x-test-role': 'manager' },
      payload: {
        businessDate, title: '跨午夜演出测试', status: 'scheduled',
        startsAt: `${businessDate}T20:00:00+08:00`, endsAt: `${nextDate}T02:00:00+08:00`,
        appearances: [{
          id: 'appearance-config-test', singerId,
          startsAt: `${businessDate}T20:30:00+08:00`, endsAt: `${businessDate}T21:15:00+08:00`,
          requestOpensAt: `${businessDate}T20:15:00+08:00`, requestClosesAt: `${businessDate}T21:10:00+08:00`,
          acceptingRequests: true,
        }],
      },
    })
    expect(performanceResponse.statusCode, performanceResponse.body).toBe(200)
    const state = await repository.read()
    expect(state.songState.repertoire.some((item) => item.singerId === singerId && item.priceAmount === 9800)).toBe(true)
    expect(state.songState.performanceSessions.find((item) => item.id === 'performance-config-test')).toMatchObject({ businessDate, title: '跨午夜演出测试' })
    await app.close()
    await repository.close()
  })

  it('imports a singer repertoire atomically and updates matching songs on a repeat import', async () => {
    const { app, repository } = await fixture()
    const singerResponse = await app.inject({
      method: 'POST', url: '/api/songs/singers', headers: { 'x-test-role': 'manager' },
      payload: { displayName: '批量导入歌手', photoUrl: '', headline: '', bio: '', styleTags: [], active: true },
    })
    const singerId = singerResponse.json().id as string
    const first = await app.inject({
      method: 'POST', url: `/api/songs/singers/${singerId}/repertoire/import`, headers: { 'x-test-role': 'manager' },
      payload: { rows: [
        { title: '后来', artist: '刘若英', durationSeconds: 240, priceAmount: 9800, currency: 'CNY', enabled: true },
        { title: '海阔天空', artist: 'Beyond', durationSeconds: 300, priceAmount: 12800, currency: 'CNY', enabled: true },
      ] },
    })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toEqual({ total: 2, created: 2, updated: 0 })

    const repeat = await app.inject({
      method: 'POST', url: `/api/songs/singers/${singerId}/repertoire/import`, headers: { 'x-test-role': 'manager' },
      payload: { rows: [
        { title: ' 后来 ', artist: '刘若英', durationSeconds: 260, priceAmount: 10800, currency: 'CNY', enabled: false },
      ] },
    })
    expect(repeat.statusCode, repeat.body).toBe(200)
    expect(repeat.json()).toEqual({ total: 1, created: 0, updated: 1 })

    const state = await repository.read()
    const offers = state.songState.repertoire.filter((item) => item.singerId === singerId)
    expect(offers).toHaveLength(2)
    const updatedOffer = offers.find((offer) => state.songState.songs.find((song) => song.id === offer.songId)?.title === '后来')
    expect(updatedOffer).toMatchObject({ priceAmount: 10800, enabled: false, configVersion: 2 })
    expect(state.auditEntries.filter((entry) => entry.action === 'song.repertoire_imported.v1')).toHaveLength(2)

    const denied = await app.inject({
      method: 'POST', url: `/api/songs/singers/${singerId}/repertoire/import`, headers: { 'x-test-role': 'server' },
      payload: { rows: [{ title: '越权歌曲', artist: '测试', durationSeconds: 240, priceAmount: 9800, currency: 'CNY', enabled: true }] },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toEqual({ code: 'AUTHORIZATION_DENIED', operation: 'song.manage' })
    expect((await repository.read()).songState.repertoire.filter((item) => item.singerId === singerId)).toHaveLength(2)
    await app.close()
    await repository.close()
  })

  it('keeps performance configuration behind song management permission', async () => {
    const { app, repository } = await fixture()
    const denied = await app.inject({
      method: 'PUT', url: '/api/songs/performances/performance-denied', headers: { 'x-test-role': 'server' },
      payload: {
        businessDate: (await repository.read()).store.businessDate,
        title: '越权排班', status: 'scheduled',
        startsAt: '2026-07-17T20:00:00+08:00', endsAt: '2026-07-17T23:00:00+08:00',
        appearances: [{ id: 'appearance-denied', singerId: 'singer-tianti', startsAt: '2026-07-17T20:30:00+08:00', endsAt: '2026-07-17T21:15:00+08:00', requestOpensAt: '2026-07-17T20:15:00+08:00', requestClosesAt: '2026-07-17T21:10:00+08:00', acceptingRequests: true }],
      },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toEqual({ code: 'AUTHORIZATION_DENIED', operation: 'song.manage' })
    await app.close()
    await repository.close()
  })

  it('versions performance schedules and rejects a stale manager overwrite', async () => {
    const { app, repository } = await fixture()
    const existing = (await repository.read()).songState.performanceSessions[0]!
    const payload = {
      businessDate: existing.businessDate,
      title: `${existing.title} · 版本测试`,
      status: existing.status,
      startsAt: existing.startsAt,
      endsAt: existing.endsAt,
      appearances: existing.appearances,
      expectedVersion: existing.configVersion ?? 1,
    }
    const saved = await app.inject({ method: 'PUT', url: `/api/songs/performances/${existing.id}`, headers: { 'x-test-role': 'manager' }, payload })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json().configVersion).toBe((existing.configVersion ?? 1) + 1)

    const stale = await app.inject({ method: 'PUT', url: `/api/songs/performances/${existing.id}`, headers: { 'x-test-role': 'manager' }, payload })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().code).toBe('SONG_PERFORMANCE_VERSION_CONFLICT')
    expect(stale.json().currentVersion).toBe((existing.configVersion ?? 1) + 1)
    expect(stale.json().message).toContain('请刷新后再保存')
    const audit = (await repository.read()).auditEntries.filter((entry) => entry.action === 'song.performance_config_saved.v1')
    expect(audit.at(-1)?.details).toMatchObject({ previousVersion: existing.configVersion ?? 1, version: (existing.configVersion ?? 1) + 1 })
    await app.close()
    await repository.close()
  })

  it('lets a manager maintain the singer profile shown to guests', async () => {
    const { app, repository } = await fixture()
    const singer = (await repository.read()).songState.singers[0]!
    const response = await app.inject({
      method: 'PUT',
      url: `/api/songs/singers/${singer.id}/profile`,
      headers: { 'x-test-role': 'manager' },
      payload: {
        displayName: '天天',
        photoUrl: '/singers/tianti.jpg',
        headline: '温暖声线 · 华语流行',
        bio: '擅长华语流行情歌和轻松的现场互动。',
        styleTags: ['华语流行', '情歌', '互动'],
        active: true,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ photoUrl: '/singers/tianti.jpg', styleTags: ['华语流行', '情歌', '互动'] })
    expect((await repository.read()).songState.singers[0]?.bio).toContain('现场互动')
    await app.close()
    await repository.close()
  })

  it('allows a server to submit for a guest and reads current configured permissions inside the mutation', async () => {
    const { app, repository } = await fixture()
    const submitted = await app.inject({
      method: 'POST',
      url: '/api/songs/requests',
      payload: await submitPayload(repository),
    })
    expect(submitted.statusCode).toBe(201)
    expect(submitted.json().requestedBy).toBe('emp-lin')

    await repository.mutate((state) => {
      const serverRole = state.config.roles.find((role) => role.id === 'server')!
      serverRole.permissionIds = serverRole.permissionIds?.filter((permissionId) => permissionId !== 'song.view')
      state.revision += 1
    })
    const denied = await app.inject({
      method: 'POST',
      url: '/api/songs/requests',
      payload: await submitPayload(repository, 'song-api-submit-config-denied-0001'),
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toEqual({ code: 'AUTHORIZATION_DENIED', operation: 'song.request' })
    expect((await repository.read()).songState.requests).toHaveLength(1)

    await app.close()
    await repository.close()
  })

  it.each(['admin', 'kitchen', 'host'])('rejects %s from submitting unrelated song requests', async (roleId) => {
    const { app, repository } = await fixture()
    const denied = await app.inject({
      method: 'POST',
      url: '/api/songs/requests',
      headers: { 'x-test-role': roleId },
      payload: await submitPayload(repository, `song-api-submit-${roleId}-denied-0001`),
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toEqual({ code: 'AUTHORIZATION_DENIED', operation: 'song.request' })
    expect((await repository.read()).songState.requests).toHaveLength(0)

    await app.close()
    await repository.close()
  })

  it('requires staff confirmation, then lets the cashier register onsite collection', async () => {
    const { app, repository } = await fixture()
    const submitted = await app.inject({
      method: 'POST',
      url: '/api/songs/requests',
      payload: await submitPayload(repository, 'song-api-submit-cashier-flow-0001'),
    })
    expect(submitted.statusCode).toBe(201)
    const requestId = submitted.json().id as string
    expect(submitted.json().status).toBe('pending_confirmation')

    const confirmed = await confirmRequest(app, requestId, 'song-api-confirm-server-0001')
    expect(confirmed.statusCode).toBe(200)
    expect(confirmed.json()).toMatchObject({ status: 'pending_payment', confirmedBy: 'emp-lin' })

    const paid = await app.inject({
      method: 'POST',
      url: `/api/songs/requests/${requestId}/payment`,
      headers: { 'x-test-role': 'cashier' },
      payload: { paymentReference: 'pos-cashier', collectionChannel: 'physical_pos', idempotencyKey: 'song-api-payment-cashier-0001' },
    })
    expect(paid.statusCode).toBe(200)
    expect(paid.json()).toMatchObject({ status: 'paid', payment: { collectionChannel: 'physical_pos' } })

    const audit = (await repository.read()).songState.auditEvents.filter((event) => event.requestId === requestId)
    expect(audit.find((event) => event.type === 'song_request.submitted.v1')?.actorId).toBe('emp-lin')
    expect(audit.find((event) => event.type === 'song_request.paid.v1')?.actorId).toBe('emp-cashier')

    await app.close()
    await repository.close()
  })

  it.each(['admin', 'kitchen', 'host'])('rejects %s from song payment and management', async (roleId) => {
    const { app, repository } = await fixture()
    const submitted = await app.inject({
      method: 'POST',
      url: '/api/songs/requests',
      payload: await submitPayload(repository, `song-api-submit-${roleId}-guard-0001`),
    })
    const requestId = submitted.json().id as string

    const deniedPayment = await app.inject({
      method: 'POST',
      url: `/api/songs/requests/${requestId}/payment`,
      headers: { 'x-test-role': roleId },
      payload: { paymentReference: `pos-${roleId}-denied`, collectionChannel: 'physical_pos', idempotencyKey: `song-api-payment-${roleId}-denied-0001` },
    })
    expect(deniedPayment.statusCode).toBe(403)
    expect(deniedPayment.json().operation).toBe('payment.intent.create')

    const deniedAction = await app.inject({
      method: 'POST',
      url: `/api/songs/requests/${requestId}/actions`,
      headers: { 'x-test-role': roleId },
      payload: { action: 'cancel', reason: '越权操作', refundReference: '', idempotencyKey: `song-api-action-${roleId}-denied-0001` },
    })
    expect(deniedAction.statusCode).toBe(403)
    expect(deniedAction.json().operation).toBe('song.manage')
    expect((await repository.read()).songState.requests.find((item) => item.id === requestId)?.status).toBe('pending_confirmation')

    await app.close()
    await repository.close()
  })

  it('allows supervisor and owner management according to configured permissions', async () => {
    const { app, repository } = await fixture()
    const acceptedRequest = await app.inject({
      method: 'POST',
      url: '/api/songs/requests',
      payload: await submitPayload(repository, 'song-api-submit-owner-accept-0001'),
    })
    const acceptedRequestId = acceptedRequest.json().id as string
    await confirmRequest(app, acceptedRequestId, 'song-api-confirm-owner-accept-0001')
    await app.inject({
      method: 'POST',
      url: `/api/songs/requests/${acceptedRequestId}/payment`,
      headers: { 'x-test-role': 'cashier' },
      payload: { paymentReference: 'pos-owner-accept', collectionChannel: 'physical_pos', idempotencyKey: 'song-api-payment-owner-accept-0001' },
    })

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/songs/requests/${acceptedRequestId}/actions`,
      headers: { 'x-test-role': 'owner' },
      payload: { action: 'accept', reason: '', refundReference: '', idempotencyKey: 'song-api-action-owner-accept-0001' },
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().acceptedBy).toBe('emp-owner')

    const rejectedRequest = await app.inject({
      method: 'POST',
      url: '/api/songs/requests',
      payload: await submitPayload(repository, 'song-api-submit-manager-refund-0001'),
    })
    const rejectedRequestId = rejectedRequest.json().id as string
    await confirmRequest(app, rejectedRequestId, 'song-api-confirm-manager-refund-0001')
    await app.inject({
      method: 'POST',
      url: `/api/songs/requests/${rejectedRequestId}/payment`,
      headers: { 'x-test-role': 'cashier' },
      payload: { paymentReference: 'cash-manager-refund', collectionChannel: 'cash', idempotencyKey: 'song-api-payment-manager-refund-0001' },
    })

    const supervisorRejected = await app.inject({
      method: 'POST',
      url: `/api/songs/requests/${rejectedRequestId}/actions`,
      headers: { 'x-test-role': 'supervisor' },
      payload: { action: 'reject', reason: '歌手临时无法演出', refundReference: '', idempotencyKey: 'song-api-action-supervisor-reject-0001' },
    })
    expect(supervisorRejected.statusCode).toBe(200)
    expect(supervisorRejected.json().status).toBe('refund_required')

    const refunded = await app.inject({
      method: 'POST',
      url: `/api/songs/requests/${rejectedRequestId}/actions`,
      headers: { 'x-test-role': 'owner' },
      payload: { action: 'refund', reason: '', refundReference: 'refund-owner-0001', idempotencyKey: 'song-api-action-owner-refund-0001' },
    })
    expect(refunded.statusCode).toBe(200)
    expect(refunded.json().status).toBe('refunded')

    const state = await repository.read()
    const acceptedAudit = state.songState.auditEvents.filter((event) => event.requestId === acceptedRequestId)
    const refundedAudit = state.songState.auditEvents.filter((event) => event.requestId === rejectedRequestId)
    expect(acceptedAudit.find((event) => event.type === 'song_request.accepted.v1')?.actorId).toBe('emp-owner')
    expect(refundedAudit.find((event) => event.type === 'song_request.refund_required.v1')?.actorId).toBe('emp-mia')
    expect(refundedAudit.find((event) => event.type === 'song_request.refunded.v1')?.actorId).toBe('emp-owner')

    await app.close()
    await repository.close()
  })
})
