import Fastify, { type FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { RequestActorContext } from '../src/shared/auth-contracts.js'
import {
  AuthorizationError,
  canAccessDataScope,
  canApproveAmount,
  canApproveHighRiskOperation,
  canPerformOperation,
  createPermissionPolicy,
  createPermissionPolicyFromRuntimeState,
  DEFAULT_PERMISSION_POLICY,
  isHighRiskOperation,
  requireApprovalAmount,
  requireCommerceDecisionAuthority,
  requireConfiguredOperation,
  requireDataScope,
  requireHighRiskApproval,
  requireOperation,
  requireOrderCreationRole,
  requireTableDataScope,
  STAFF_OPERATION_PERMISSION_IDS,
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
      message: '岗位 server 无权修改门店配置；允许岗位：owner、operations_director、admin',
      operation: 'config.write',
    })
  })

  it.each([
    ['owner', 'commerce-authority.write'],
    ['admin', 'config.write'],
    ['manager', 'payment.refund.approve'],
    ['supervisor', 'benefit.grant'],
    ['server', 'commerce.order.create'],
    ['server', 'table.open'],
    ['server', 'table.write'],
    ['server', 'table.close'],
    ['bartender', 'commerce.kds.prepare'],
    ['kitchen', 'commerce.kds.prepare'],
    ['cashier', 'payment.pos.report'],
    ['host', 'reservation.manage'],
    ['runner', 'commerce.kds.deliver'],
  ] as const)('supports the %s role', (roleId, operation) => {
    expect(canPerformOperation(roleId, operation)).toBe(true)
  })

  it('keeps the legacy backup and specialist permissions', () => {
    expect(canPerformOperation('backup', 'commerce.order.create')).toBe(true)
    expect(canPerformOperation('backup', 'table.open')).toBe(true)
    expect(canPerformOperation('backup', 'table.write')).toBe(true)
    expect(canPerformOperation('backup', 'table.close')).toBe(true)
    expect(canPerformOperation('specialist', 'commerce.kds.prepare')).toBe(true)
    expect(canPerformOperation('specialist', 'commerce.order.create')).toBe(true)
    expect(canPerformOperation('specialist', 'table.open')).toBe(true)
    expect(canPerformOperation('specialist', 'table.write')).toBe(true)
    expect(canPerformOperation('specialist', 'table.close')).toBe(true)
    expect(canPerformOperation('host', 'table.open')).toBe(true)
    expect(canPerformOperation('bartender', 'table.open')).toBe(false)
  })

  it('supports policy overrides without changing the default policy', async () => {
    const policy = createPermissionPolicy({
      roles: {
        auditor: {
          name: '审计员',
          operations: ['notification.retry'],
          dataScope: 'organization',
          canApproveHighRisk: true,
        },
        server: { operations: ['commerce.order.create'] },
      },
      operations: { 'notification.retry': { name: '重放通知' } },
    })
    expect(canPerformOperation('auditor', 'notification.retry', policy)).toBe(true)
    expect(canPerformOperation('server', 'payment.intent.create', policy)).toBe(false)
    expect(canPerformOperation('server', 'payment.intent.create')).toBe(true)

    const request = { mboxActor: actor('auditor') } as unknown as FastifyRequest
    expect(requireOperation(request, 'notification.retry', policy).roleId).toBe('auditor')
  })

  it('maps every staff operation to a shared permission id', () => {
    expect(STAFF_OPERATION_PERMISSION_IDS).toMatchObject({
      'reservation.manage': 'reservation.manage',
      'reservation.deposit.confirm': 'payment.collect',
      'reservation.deposit.refund.request': 'payment.refund.request',
      'reservation.deposit.refund.approve': 'payment.refund.approve',
      'inventory.manage': 'inventory.manage',
      'inventory.approve': 'inventory.approve',
      'benefit.grant': 'benefit.grant',
      'benefit.approve': 'benefit.approve',
      'song.request': 'song.view',
      'song.manage': 'song.manage',
      'store-import.apply': 'store_import.apply',
      'service.task.create': 'service.execute',
      'service.task.action': 'service.execute',
    })
    for (const [operation, permissionId] of Object.entries(STAFF_OPERATION_PERMISSION_IDS)) {
      expect(DEFAULT_PERMISSION_POLICY.operations[operation as keyof typeof STAFF_OPERATION_PERMISSION_IDS].permissionId)
        .toBe(permissionId)
    }
  })

  it('enforces the audited cashier, host, owner, admin and manager boundaries', () => {
    expect(canPerformOperation('cashier', 'reservation.deposit.confirm')).toBe(true)
    expect(canPerformOperation('cashier', 'reservation.deposit.refund.request')).toBe(true)
    expect(canPerformOperation('cashier', 'reservation.deposit.refund.approve')).toBe(false)
    expect(canPerformOperation('cashier', 'inventory.manage')).toBe(false)

    expect(canPerformOperation('host', 'reservation.manage')).toBe(true)
    expect(canPerformOperation('host', 'service.task.create')).toBe(true)
    expect(canPerformOperation('host', 'reservation.deposit.confirm')).toBe(false)

    for (const operation of Object.keys(STAFF_OPERATION_PERMISSION_IDS) as Parameters<typeof canPerformOperation>[1][]) {
      expect(canPerformOperation('owner', operation), operation).toBe(true)
    }

    expect(canPerformOperation('admin', 'config.write')).toBe(true)
    expect(canPerformOperation('admin', 'master-data.write')).toBe(true)
    expect(canPerformOperation('admin', 'store-import.apply')).toBe(true)
    expect(canPerformOperation('admin', 'payment.intent.create')).toBe(false)
    expect(canPerformOperation('admin', 'benefit.approve')).toBe(false)

    expect(canPerformOperation('manager', 'reservation.deposit.refund.approve')).toBe(true)
    expect(canPerformOperation('manager', 'inventory.approve')).toBe(true)
    expect(canPerformOperation('manager', 'benefit.approve')).toBe(true)
    expect(canPerformOperation('manager', 'song.manage')).toBe(true)
    expect(canPerformOperation('manager', 'service.task.action')).toBe(true)
    expect(canPerformOperation('manager', 'config.write')).toBe(false)
  })

  it('builds the policy from store role permissions, data scope and approval limits', () => {
    const state = createSeedState()
    const serverRole = state.config.roles.find((role) => role.id === 'server')!
    serverRole.permissionIds = ['inventory.manage']
    serverRole.dataScope = 'all_stores'
    serverRole.approvalLimits = {
      giftAmount: 1234,
      discountAmount: 2345,
      refundRequestAmount: 3456,
      refundApproveAmount: 4567,
      inventoryAdjustmentAmount: 5678,
    }

    const policy = createPermissionPolicyFromRuntimeState(state)
    expect(canPerformOperation('server', 'inventory.manage', policy)).toBe(true)
    expect(canPerformOperation('server', 'commerce.order.create', policy)).toBe(false)
    expect(policy.roles.server).toMatchObject({
      permissionIds: ['inventory.manage'],
      dataScope: 'all_stores',
      approvalLimits: { giftAmount: 1234, inventoryAdjustmentAmount: 5678 },
    })
  })

  it('uses an active shift role before the employee default role for configured operations', () => {
    const state = createSeedState()
    const request = { mboxActor: actor('admin', 'emp-admin') } as unknown as FastifyRequest
    const shift = state.shiftAssignments.find((item) => item.employeeId === 'emp-admin')!

    shift.roleId = 'cashier'
    expect(requireConfiguredOperation(request, state, 'payment.intent.create').roleId).toBe('cashier')
    expect(() => requireConfiguredOperation(request, state, 'config.write')).toThrowError(
      '岗位 cashier 无权修改门店配置',
    )

    shift.status = 'completed'
    expect(requireConfiguredOperation(request, state, 'config.write').roleId).toBe('admin')
    expect(() => requireConfiguredOperation(request, state, 'payment.intent.create')).toThrowError(
      '岗位 admin 无权创建收款单',
    )
  })

  it('checks all configured approval limit types and active shift roles', () => {
    const state = createSeedState()
    const managerRequest = { mboxActor: actor('manager', 'emp-chen') } as unknown as FastifyRequest
    const limitTypes = ['gift', 'discount', 'refundRequest', 'refundApprove', 'inventoryAdjustment'] as const
    for (const limitType of limitTypes) {
      expect(canApproveAmount('manager', limitType, 100_000, createPermissionPolicyFromRuntimeState(state))).toBe(true)
      expect(requireApprovalAmount(managerRequest, state, limitType, 100_000).roleId).toBe('manager')
      expect(() => requireApprovalAmount(managerRequest, state, limitType, 100_001)).toThrowError('额度不足')
    }

    const adminRequest = { mboxActor: actor('admin', 'emp-admin') } as unknown as FastifyRequest
    const adminShift = state.shiftAssignments.find((item) => item.employeeId === 'emp-admin')!
    adminShift.roleId = 'cashier'
    expect(requireApprovalAmount(adminRequest, state, 'refundRequest', 100_000).roleId).toBe('cashier')
    expect(() => requireApprovalAmount(adminRequest, state, 'refundApprove', 1)).toThrowError(
      '岗位 cashier 的退款审批额度不足',
    )
  })

  it('checks hierarchical data scopes and reports the required scope', () => {
    expect(canAccessDataScope('server', 'assigned_areas')).toBe(true)
    expect(canAccessDataScope('server', 'store')).toBe(false)
    expect(canAccessDataScope('manager', 'store')).toBe(true)
    expect(canAccessDataScope('owner', 'all_stores')).toBe(true)

    const request = { mboxActor: actor('runner') } as unknown as FastifyRequest
    expect(() => requireDataScope(request, 'store', 'task.list')).toThrowError(
      '岗位 runner 的数据范围不足：当前为已分配区域，需要当前门店范围',
    )
    try {
      requireDataScope(request, 'store', 'task.list')
    } catch (error) {
      expect(error).toMatchObject({
        operation: 'task.list',
        details: { reason: 'scope_not_allowed', roleId: 'runner', grantedScope: 'assigned_areas', requiredScope: 'store' },
      })
    }
  })

  it('enforces own, assigned-area, store and all-store table boundaries', () => {
    const state = createSeedState()
    const serverRole = state.config.roles.find((role) => role.id === 'server')!
    const serverRequest = { mboxActor: actor('server', 'emp-lin') } as unknown as FastifyRequest

    serverRole.dataScope = 'own'
    expect(requireTableDataScope(serverRequest, state, 'table-l01').actorId).toBe('emp-lin')
    expect(() => requireTableDataScope(serverRequest, state, 'table-i01')).toThrowError('无权访问桌台 I01')

    serverRole.dataScope = 'assigned_areas'
    const serverShift = state.shiftAssignments.find((shift) => shift.employeeId === 'emp-lin')!
    serverShift.areaIds = ['interactive']
    expect(requireTableDataScope(serverRequest, state, 'table-i01').actorId).toBe('emp-lin')
    expect(() => requireTableDataScope(serverRequest, state, 'table-l01')).toThrowError('无权访问桌台 L01')

    const managerRequest = { mboxActor: actor('manager', 'emp-chen') } as unknown as FastifyRequest
    expect(requireTableDataScope(managerRequest, state, 'table-i01').actorId).toBe('emp-chen')
    managerRequest.mboxActor = { ...actor('manager', 'emp-chen'), storeId: 'another-store' }
    expect(() => requireTableDataScope(managerRequest, state, 'table-i01')).toThrowError('无权访问桌台 I01')

    const ownerRequest = {
      mboxActor: { ...actor('owner', 'emp-owner'), storeId: 'another-store' },
    } as unknown as FastifyRequest
    expect(requireTableDataScope(ownerRequest, state, 'table-i01').actorId).toBe('emp-owner')
  })

  it('uses active shift areas before static employee areas and falls back after the shift', () => {
    const state = createSeedState()
    const request = { mboxActor: actor('server', 'emp-lin') } as unknown as FastifyRequest
    const employee = state.employees.find((item) => item.id === 'emp-lin')!
    const shift = state.shiftAssignments.find((item) => item.employeeId === 'emp-lin')!
    employee.areaIds = ['lounge']
    shift.areaIds = ['interactive']

    expect(requireTableDataScope(request, state, 'table-i01').actorId).toBe('emp-lin')
    expect(() => requireTableDataScope(request, state, 'table-l01')).toThrowError(AuthorizationError)

    shift.status = 'completed'
    expect(requireTableDataScope(request, state, 'table-l01').actorId).toBe('emp-lin')
    expect(() => requireTableDataScope(request, state, 'table-i01')).toThrowError(AuthorizationError)
  })

  it('returns a structured 403 for a table outside the actor data scope', async () => {
    const state = createSeedState()
    const app = Fastify()
    app.decorateRequest('mboxActor', null)
    app.addHook('preHandler', async (request) => {
      request.mboxActor = actor('server', 'emp-lin')
    })
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AuthorizationError) {
        return reply.status(error.statusCode).send({ code: error.code, operation: error.operation, details: error.details })
      }
      throw error
    })
    app.post('/:tableId', async (request) => {
      const { tableId } = request.params as { tableId: string }
      return requireTableDataScope(request, state, tableId, 'table.test.write')
    })

    const response = await app.inject({ method: 'POST', url: '/table-i01' })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({
      code: 'AUTHORIZATION_DENIED',
      operation: 'table.test.write',
      details: {
        reason: 'scope_not_allowed',
        roleId: 'server',
        grantedScope: 'assigned_areas',
        tableId: 'table-i01',
        areaId: 'interactive',
      },
    })

    const missing = await app.inject({ method: 'POST', url: '/missing-table' })
    expect(missing.statusCode).toBe(403)
    expect(missing.json()).toMatchObject({ details: { reason: 'scope_not_allowed', tableId: 'missing-table' } })
    await app.close()
  })

  it('identifies high-risk operations and separates execution from approval capability', () => {
    expect(isHighRiskOperation('payment.refund.approve')).toBe(true)
    expect(isHighRiskOperation('commerce.order.create')).toBe(false)
    expect(canPerformOperation('cashier', 'payment.pos.report')).toBe(true)
    expect(canApproveHighRiskOperation('cashier', 'payment.pos.report')).toBe(false)
    expect(canApproveHighRiskOperation('manager', 'payment.refund.approve')).toBe(true)

    const cashierRequest = { mboxActor: actor('cashier') } as unknown as FastifyRequest
    expect(() => requireHighRiskApproval(cashierRequest, 'payment.pos.report')).toThrowError(
      '岗位 cashier 无权审批高风险操作：报送物理POS收款',
    )
    expect(requireHighRiskApproval(cashierRequest, 'commerce.order.create').roleId).toBe('cashier')
  })

  it('keeps administrators on configuration and master data without financial authority', async () => {
    expect((await authorizationResponse('admin', 'config.write')).statusCode).toBe(200)
    expect((await authorizationResponse('admin', 'master-data.write')).statusCode).toBe(200)
    expect((await authorizationResponse('admin', 'payment.intent.create')).statusCode).toBe(403)
    expect((await authorizationResponse('admin', 'payment.refund.approve')).statusCode).toBe(403)
    expect((await authorizationResponse('supervisor', 'master-data.write')).statusCode).toBe(403)
    expect((await authorizationResponse('supervisor', 'commerce-authority.write')).statusCode).toBe(200)
    expect((await authorizationResponse('manager', 'commerce-authority.write')).statusCode).toBe(200)
  })

  it('separates KDS preparation from pickup and delivery duties', async () => {
    expect((await authorizationResponse('specialist', 'commerce.kds.prepare')).statusCode).toBe(200)
    expect((await authorizationResponse('server', 'commerce.kds.prepare')).statusCode).toBe(403)
    expect((await authorizationResponse('server', 'commerce.kds.deliver')).statusCode).toBe(200)
    expect((await authorizationResponse('specialist', 'commerce.authorization.request')).statusCode).toBe(200)
  })

  it('allows operational payment roles but reserves refund approval for managers and owners', async () => {
    expect((await authorizationResponse('server', 'payment.intent.create')).statusCode).toBe(200)
    expect((await authorizationResponse('server', 'payment.pos.report')).statusCode).toBe(403)
    expect((await authorizationResponse('server', 'payment.refund.request')).statusCode).toBe(200)
    expect((await authorizationResponse('server', 'payment.refund.approve')).statusCode).toBe(403)
    expect((await authorizationResponse('supervisor', 'payment.pos.report')).statusCode).toBe(200)
    expect((await authorizationResponse('supervisor', 'payment.refund.approve')).statusCode).toBe(403)
    expect((await authorizationResponse('cashier', 'payment.pos.report')).statusCode).toBe(200)
    expect((await authorizationResponse('manager', 'payment.refund.approve')).statusCode).toBe(200)
  })

  it('uses order.create permission only and never grants ordering through dispatch roles', async () => {
    const state = createSeedState()
    const app = Fastify()
    app.decorateRequest('mboxActor', null)
    app.addHook('preHandler', async (request) => {
      request.mboxActor = actor('bartender')
    })
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AuthorizationError) return reply.status(403).send({ code: error.code })
      throw error
    })
    app.post('/', async (request) => requireOrderCreationRole(request, state))

    expect((await app.inject({ method: 'POST', url: '/' })).statusCode).toBe(403)
    state.config.serviceTypes.find((item) => item.code === 'ORDER_HELP')!.dispatchRoleIds.push('bartender')
    expect((await app.inject({ method: 'POST', url: '/' })).statusCode).toBe(403)
    state.config.roles.find((role) => role.id === 'bartender')!.permissionIds!.push('order.create')
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

    const activeShift = state.shiftAssignments.find((shift) => shift.employeeId === 'emp-lin')!
    activeShift.roleId = 'bartender'
    expect(() => requireCommerceDecisionAuthority(request, state, 'authorization-test', duringAuthority))
      .toThrowError('岗位 bartender 的赠送额度不足')
    activeShift.roleId = 'server'

    request.mboxActor = actor('server', 'emp-wu')
    expect(() => requireCommerceDecisionAuthority(request, state, 'authorization-test', duringAuthority))
      .toThrowError(AuthorizationError)

    request.mboxActor = actor('server', 'emp-lin')
    const serverRole = state.config.roles.find((role) => role.id === 'server')!
    serverRole.approvalLimits!.giftAmount = configuredAuthority.maxAmount + 100
    state.orderDomain.authorizations[0]!.requestedAmount = configuredAuthority.maxAmount + 1
    expect(() => requireCommerceDecisionAuthority(request, state, 'authorization-test', duringAuthority))
      .toThrowError('当前员工没有有效的经营审批授权')

    configuredAuthority.maxAmount = 10_000
    serverRole.approvalLimits!.giftAmount = 500
    state.orderDomain.authorizations[0]!.requestedAmount = 501
    expect(() => requireCommerceDecisionAuthority(request, state, 'authorization-test', duringAuthority))
      .toThrowError('岗位 server 的赠送额度不足：申请 501 分，上限 500 分')
  })
})
