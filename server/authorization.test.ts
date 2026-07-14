import Fastify, { type FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { RequestActorContext } from '../src/shared/auth-contracts.js'
import {
  AuthorizationError,
  requireCommerceDecisionAuthority,
  requireOperation,
  requireOrderCreationRole,
} from './authorization.js'
import { createSeedState } from './seed.js'

function actor(roleId: string, actorId = 'employee-test'): RequestActorContext {
  return {
    actorId,
    roleId,
    storeId: 'mbox-lujiazui',
    runtimeMode: 'test',
    authenticatedBy: 'local_header',
  }
}

async function authorizationResponse(roleId: string, operation: Parameters<typeof requireOperation>[1]) {
  const app = Fastify()
  app.decorateRequest('mboxActor', null)
  app.addHook('preHandler', async (request) => {
    request.mboxActor = actor(roleId)
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthorizationError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message, operation: error.operation })
    }
    throw error
  })
  app.post('/', async (request) => requireOperation(request, operation))
  const response = await app.inject({ method: 'POST', url: '/' })
  await app.close()
  return response
}

describe('staff role authorization', () => {
  it('returns a structured 403 for an unauthorized role', async () => {
    const response = await authorizationResponse('server', 'config.write')
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({
      code: 'AUTHORIZATION_DENIED',
      message: '当前岗位无权修改门店配置',
      operation: 'config.write',
    })
  })

  it('allows supervisors to manage store data but reserves commerce authority for managers', async () => {
    expect((await authorizationResponse('supervisor', 'config.write')).statusCode).toBe(200)
    expect((await authorizationResponse('supervisor', 'master-data.write')).statusCode).toBe(200)
    expect((await authorizationResponse('supervisor', 'commerce-authority.write')).statusCode).toBe(403)
    expect((await authorizationResponse('manager', 'commerce-authority.write')).statusCode).toBe(200)
  })

  it('separates KDS preparation from pickup and delivery duties', async () => {
    expect((await authorizationResponse('specialist', 'commerce.kds.prepare')).statusCode).toBe(200)
    expect((await authorizationResponse('server', 'commerce.kds.prepare')).statusCode).toBe(403)
    expect((await authorizationResponse('server', 'commerce.kds.deliver')).statusCode).toBe(200)
    expect((await authorizationResponse('specialist', 'commerce.authorization.request')).statusCode).toBe(200)
  })

  it('allows servers to create bills and request refunds but reserves money confirmation for supervisors', async () => {
    expect((await authorizationResponse('server', 'payment.intent.create')).statusCode).toBe(200)
    expect((await authorizationResponse('server', 'payment.pos.report')).statusCode).toBe(403)
    expect((await authorizationResponse('server', 'payment.refund.request')).statusCode).toBe(200)
    expect((await authorizationResponse('server', 'payment.refund.approve')).statusCode).toBe(403)
    expect((await authorizationResponse('supervisor', 'payment.pos.report')).statusCode).toBe(200)
    expect((await authorizationResponse('manager', 'payment.refund.approve')).statusCode).toBe(200)
  })

  it('uses the configured order-help roles for order creation', async () => {
    const state = createSeedState()
    const app = Fastify()
    app.decorateRequest('mboxActor', null)
    app.addHook('preHandler', async (request) => {
      request.mboxActor = actor('specialist')
    })
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AuthorizationError) return reply.status(403).send({ code: error.code })
      throw error
    })
    app.post('/', async (request) => requireOrderCreationRole(request, state))

    expect((await app.inject({ method: 'POST', url: '/' })).statusCode).toBe(403)
    state.config.serviceTypes.find((item) => item.code === 'ORDER_HELP')!.dispatchRoleIds.push('specialist')
    expect((await app.inject({ method: 'POST', url: '/' })).statusCode).toBe(200)
    await app.close()
  })

  it('allows commerce decisions only when the employee has a current configured authority', async () => {
    const state = createSeedState()
    state.orderDomain.orders.push({
      id: 'order-test',
      tableSessionId: 'session:table-l01:test',
      status: 'authorization_pending',
      items: [{
        id: 'line-test', skuId: 'product-beer', name: '精酿啤酒', specification: '1杯', quantity: 1,
        unitListPriceAmount: 6800, unitSalePriceAmount: 0, unitCostAmount: 1800, stationId: 'bar-main',
        configVersion: 1, fulfillmentStatus: 'draft', kdsTaskId: null, addedBy: 'emp-lin',
        addedAt: new Date().toISOString(),
      }],
      amounts: { grossAmount: 6800, discountAmount: 0, giftAmount: 6800, payableAmount: 0 },
      revision: 1,
      createdBy: 'emp-lin',
      createdAt: new Date().toISOString(),
      submittedBy: null,
      submittedAt: null,
      fulfilledAt: null,
    })
    state.orderDomain.authorizations.push({
      id: 'authorization-test',
      orderId: 'order-test',
      orderRevision: 1,
      kind: 'gift',
      lineIds: ['line-test'],
      requestedAmount: 1000,
      status: 'pending',
      requestedBy: 'emp-lin',
      requestedAt: new Date().toISOString(),
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
    })
    const request = { mboxActor: actor('server', 'emp-lin') } as unknown as FastifyRequest
    const configuredAuthority = state.orderDomain.authorizationAuthorities.find((item) => item.actorId === 'emp-lin')!
    const duringAuthority = new Date(Date.parse(configuredAuthority.validFrom) + 1)
    expect(requireCommerceDecisionAuthority(request, state, 'authorization-test', duringAuthority).actorId).toBe('emp-lin')

    request.mboxActor = actor('server', 'emp-wu')
    expect(() => requireCommerceDecisionAuthority(request, state, 'authorization-test', duringAuthority))
      .toThrowError(AuthorizationError)

    request.mboxActor = actor('server', 'emp-lin')
    state.orderDomain.authorizations[0]!.requestedAmount = configuredAuthority.maxAmount + 1
    expect(() => requireCommerceDecisionAuthority(request, state, 'authorization-test', duringAuthority))
      .toThrowError('当前员工没有有效的经营审批授权')
  })
})
