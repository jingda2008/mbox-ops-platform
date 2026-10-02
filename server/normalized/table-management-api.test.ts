import Fastify from 'fastify'
import { StaffActionsApi } from '../../src/normalized-ui/staff-actions/staff-actions-api.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapacityOverrideReasonRequiredError } from './table-management-repository.js'
import { TableManagementConflictError, AssignmentNotCommittedError } from './table-management-repository.js'
import { StaffAccessDeniedError } from './staff-access-repository.js'
import { tableManagementApiPlugin } from './table-management-api.js'
import { IdempotencyConflictError, IdempotencyInProgressError, IdempotencyRecordError } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'
const tableId = '44444444-4444-4444-8444-444444444444'
const sourceTableId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const sourceSessionId = '99999999-9999-4999-8999-999999999999'
const targetSessionId = '88888888-8888-4888-8888-888888888888'
const participantPublicId = 'participant-public-0001'

const apps: ReturnType<typeof Fastify>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('table management API', () => {
  it('opens any table using table.open without requiring a responsibility assignment', async () => {
    const commands = commandPort()
    commands.open.mockResolvedValue({
      replayed: false,
      value: { id: 'session-id', tableId, tableCode: 'W01', guestCount: 2 },
    })
    const app = await build(commands)
    const response = await app.inject({
      method: 'POST',
      url: '/table-management/sessions/open',
      headers: { 'x-idempotency-key': 'open-w01-request-001' },
      payload: { tableId, guestCount: 2 },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({
      data: { id: 'session-id', tableId, tableCode: 'W01', guestCount: 2 },
      meta: { replayed: false },
    })
    expect(commands.open).toHaveBeenCalledWith(expect.objectContaining({
      tableId,
      guestCount: 2,
      reason: '现场开台',
      actor: { type: 'employee', employeeId },
    }))
  })

  it('accepts only the existing recommendation occasion vocabulary for an open-table profile', async () => {
    const commands = commandPort()
    commands.open.mockResolvedValue({ replayed: false, value: { id: 'session-id', tableId, tableCode: 'W01', guestCount: 2 } })
    const app = await build(commands)
    const accepted = await app.inject({
      method: 'POST',
      url: '/table-management/sessions/open',
      headers: { 'x-idempotency-key': 'open-scene-request-001' },
      payload: { tableId, guestCount: 2, guestProfileSnapshot: { recommendationScene: 'friends' } },
    })
    const rejected = await app.inject({
      method: 'POST',
      url: '/table-management/sessions/open',
      headers: { 'x-idempotency-key': 'open-scene-request-002' },
      payload: { tableId, guestCount: 2, guestProfileSnapshot: { recommendationScene: 'solo' } },
    })

    expect(accepted.statusCode).toBe(201)
    expect(commands.open).toHaveBeenCalledWith(expect.objectContaining({
      guestProfileSnapshot: { recommendationScene: 'friends' },
    }))
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json().error).toEqual({
      code: 'TABLE_REQUEST_INVALID',
      message: 'guestProfileSnapshot.recommendationScene无效',
    })

    const untrustedExtra = await app.inject({
      method: 'POST',
      url: '/table-management/sessions/open',
      headers: { 'x-idempotency-key': 'open-scene-request-003' },
      payload: { tableId, guestCount: 2, guestProfileSnapshot: { recommendationScene: 'friends', phone: '13800138000' } },
    })
    expect(untrustedExtra.statusCode).toBe(400)
    expect(untrustedExtra.json().error).toEqual({
      code: 'TABLE_REQUEST_INVALID',
      message: 'guestProfileSnapshot仅支持recommendationScene',
    })
  })

  it('returns a specific capacity override instruction instead of a generic failure', async () => {
    const commands = commandPort()
    commands.open.mockRejectedValue(new CapacityOverrideReasonRequiredError(4, 6))
    const app = await build(commands)
    const response = await app.inject({
      method: 'POST',
      url: '/table-management/sessions/open',
      headers: { 'x-idempotency-key': 'open-capacity-request-001' },
      payload: { tableId, guestCount: 6 },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual({
      error: {
        code: 'CAPACITY_OVERRIDE_REASON_REQUIRED',
        message: '人数6超过桌台容量4，必须填写加座原因',
      },
    })
  })

  it('requires an idempotency key for every write route', async () => {
    const commands = commandPort()
    const app = await build(commands)
    const response = await app.inject({
      method: 'POST',
      url: '/table-management/sessions/open',
      payload: { tableId, guestCount: 2 },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('TABLE_REQUEST_INVALID')
    expect(commands.open).not.toHaveBeenCalled()
  })

  it('does not turn an omitted layout snapshot into an empty layout during edits', async () => {
    const areaId = '55555555-5555-4555-8555-555555555555'
    const commands = commandPort()
    commands.updateArea.mockResolvedValue({ replayed: false, value: { id: areaId, name: '室外区' } })
    commands.updateTable.mockResolvedValue({ replayed: false, value: { id: tableId, displayName: 'W01' } })
    const app = await build(commands)

    const areaResponse = await app.inject({
      method: 'PATCH',
      url: `/table-management/areas/${areaId}`,
      headers: { 'x-idempotency-key': 'area-layout-preserve-001' },
      payload: { name: '室外区', areaType: 'outdoor', sortOrder: 10, status: 'active' },
    })
    const tableResponse = await app.inject({
      method: 'PATCH',
      url: `/table-management/tables/${tableId}`,
      headers: { 'x-idempotency-key': 'table-layout-preserve-001' },
      payload: {
        areaId, code: 'W01', displayName: 'W01', capacity: 4,
        minimumSpendMinor: 0, currency: 'CNY', status: 'available',
      },
    })

    expect(areaResponse.statusCode).toBe(200)
    expect(tableResponse.statusCode).toBe(200)
    expect(commands.updateArea).toHaveBeenCalledWith(expect.not.objectContaining({ layoutSnapshot: expect.anything() }))
    expect(commands.updateTable).toHaveBeenCalledWith(expect.not.objectContaining({ layoutSnapshot: expect.anything() }))
  })

  it('returns a scoped table list and marks responsibility separately from action permission', async () => {
    const commands = commandPort()
    const app = await build(commands, scriptedTransaction())
    const response = await app.inject({ method: 'GET', url: '/table-management/tables' })

    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual([expect.objectContaining({
      id: tableId,
      code: 'W01',
      assignedToActor: false,
      status: 'available',
    })])
  })

  it('publishes a multi-table responsibility roster through one batch command', async () => {
    const secondTableId = '55555555-5555-4555-8555-555555555555'
    const roleId = '66666666-6666-4666-8666-666666666666'
    const commands = commandPort()
    commands.assignMany.mockResolvedValue({
      replayed: false,
      value: { id: '77777777-7777-4777-8777-777777777777', assignments: [] },
    })
    const app = await build(commands)
    const response = await app.inject({
      method: 'POST',
      url: '/table-management/assignments/batch',
      headers: { 'x-idempotency-key': 'assign-liyan-area-001' },
      payload: {
        tableIds: [tableId, secondTableId], employeeId, roleId,
        assignmentType: 'primary', startsAt: '2026-08-15T11:00:00+08:00',
        endsAt: '2026-08-15T23:00:00+08:00', reason: '李艳负责室外区晚班服务',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(commands.assignMany).toHaveBeenCalledWith(expect.objectContaining({
      tableIds: [tableId, secondTableId], employeeId, roleId,
      assignmentType: 'primary', reason: '李艳负责室外区晚班服务',
    }), false)
  })

  it('recovers the webpage original guarded request through the new server after a lost reply', async () => {
    const commands = commandPort()
    commands.assignMany.mockImplementation(async (command) => ({ value: { id: tableId, assignments: command.tableIds.map((tableId: string) => ({ ...command, id: tableId, tableId, createdByEmployeeId: employeeId })) }, replayed: true }))
    commands.endAssignment.mockImplementation(async (command) => ({ value: { id: command.assignmentId, endsAt: command.endsAt }, replayed: false }))
    const app = await build(commands, scriptedTransaction(['table.assignment.manage']))
    let loseReply = true
    const paths: string[] = []
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input).replace(/^\/api/, '')
      paths.push(url)
      const response = await app.inject({ method: init?.method === 'POST' ? 'POST' : 'GET', url,
        headers: Object.fromEntries(new Headers(init?.headers)), payload: init?.body as string | undefined })
      if (url.endsWith('/batch') && loseReply) { loseReply = false; throw new TypeError('reply lost after server commit') }
      return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } })
    }
    let sequence = 0
    const storage = new Map<string, string>()
    const web = new StaffActionsApi({ fetch: fetcher, staffSessionId: 'web-session',
      commandStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) }, removeItem: key => { storage.delete(key) } },
      createIdempotencyKey: () => `web-original-${++sequence}` })
    const options = await web.loadTableAssignmentOptions()
    expect(options.employees[0]?.id).toBe(employeeId)
    const input = { tableIds: [tableId], employeeId, roleId: sourceTableId, assignmentType: 'backup' as const,
      startsAt: '2026-09-27T10:00:00Z', endsAt: '2026-09-27T18:00:00Z', reason: '交班安排' }
    await expect(web.assignTables(input)).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    await web.assignTables(input)
    expect(commands.assignMany.mock.calls[0]?.[0].idempotencyKey).toBe(commands.assignMany.mock.calls[1]?.[0].idempotencyKey)
    expect(commands.assignMany.mock.calls[0]?.[0].requestFingerprint).toBe(commands.assignMany.mock.calls[1]?.[0].requestFingerprint)
    expect(commands.assignMany.mock.calls.every((call) => call[1] === true)).toBe(true)
    await web.loadTableAssignments()
    await web.endTableAssignment(tableId, '交班结束')
    expect(commands.endAssignment.mock.calls[0]?.[1]).toBe(true)
    expect(paths.filter(path => path.endsWith('/batch')).every(path => path.includes('guarded-assignments'))).toBe(true)
  })

  it.each(['single', 'batch', 'end'] as const)('keeps legacy %s responses and opts only the new route into recovery', async (kind) => {
    const commands = commandPort()
    const method = kind === 'single' ? commands.assign : kind === 'batch' ? commands.assignMany : commands.endAssignment
    const value = { id: tableId, assignments: [] }
    method.mockResolvedValue({ value, replayed: true })
    const app = await build(commands)
    const suffix = kind === 'single' ? '' : kind === 'batch' ? '/batch' : `/${tableId}/end`
    const payload = { tableId, tableIds: [tableId], employeeId, roleId: sourceTableId,
      assignmentType: 'backup', startsAt: '2026-09-27T10:00:00Z', endsAt: '2026-09-27T18:00:00Z', reason: '交班安排' }
    for (const guarded of [false, true]) {
      const response = await app.inject({ method: 'POST',
        url: `/table-management/${guarded ? 'guarded-assignments' : 'assignments'}${suffix}`,
        headers: { 'x-idempotency-key': 'assignment-compatibility-001' }, payload })
      expect(response.statusCode).toBe(kind === 'end' ? 200 : 201)
      expect(response.json()).toEqual({ data: value, meta: { replayed: true } })
      expect(method.mock.calls.at(-1)?.[1]).toBe(guarded)
    }
  })

  it.each([
    [new AssignmentNotCommittedError('责任时段冲突'), 409, 'TABLE_ASSIGNMENT_NOT_COMMITTED', 'not_committed'],
    [new TableManagementConflictError('旧接口冲突'), 409, 'TABLE_OPERATION_CONFLICT', undefined],
    [new IdempotencyConflictError('assignment', 'original-key'), 409, 'TABLE_OPERATION_CONFLICT', undefined],
    [new IdempotencyInProgressError('assignment', 'original-key'), 409, 'TABLE_OPERATION_CONFLICT', undefined],
    [new IdempotencyRecordError('lost receipt'), 503, 'IDEMPOTENCY_UNAVAILABLE', undefined],
    [new StaffAccessDeniedError('revoked'), 403, 'TABLE_PERMISSION_DENIED', undefined],
    [new TypeError('bad cached result'), 500, undefined, undefined],
    [new Error('connection lost during commit'), 500, undefined, undefined],
  ])('classifies guarded recovery without treating uncertain failures as uncommitted: %s', async (error, status, code, disposition) => {
    const commands = commandPort()
    commands.endAssignment.mockRejectedValue(error)
    const app = await build(commands)
    const response = await app.inject({ method: 'POST',
      url: `/table-management/guarded-assignments/${tableId}/end`,
      headers: { 'x-idempotency-key': 'assignment-classification-001' },
      payload: { endsAt: '2026-09-27T18:00:00Z', reason: '交班结束' } })
    expect(response.statusCode).toBe(status)
    if (code) expect(response.json().error.code).toBe(code)
    expect(response.json().error?.commitDisposition).toBe(disposition)
  })

  it('only exposes employee and role assignment options to configured managers', async () => {
    const app = await build(commandPort(), scriptedTransaction(['table.assignment.manage']))
    const response = await app.inject({ method: 'GET', url: '/table-management/assignment-options' })

    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual({
      employees: [{ id: employeeId, code: 'liyan', displayName: '李艳' }],
      roles: [{ id: '66666666-6666-4666-8666-666666666666', code: 'WAITER', name: '服务员' }],
      supportsGuardedAssignmentRecovery: true, currentEmployeeId: employeeId,
    })
  })

  it('passes a typed participant movement command with an idempotency key', async () => {
    const commands=commandPort()
    commands.moveParticipants.mockResolvedValue({ replayed:false,value:{
      eventId:'77777777-7777-4777-8777-777777777777',
      targetTableSessionId:'88888888-8888-4888-8888-888888888888',
      movedParticipantCount:1,revokedGuestSessionCount:1,occurredAt:'2026-08-11T12:00:00Z',
    } })
    const app=await build(commands)
    const response=await app.inject({ method:'POST',
      url:'/table-management/sessions/99999999-9999-4999-8999-999999999999/participant-movements',
      headers:{ 'x-idempotency-key':'participant-split-0001' },payload:{
        movementKind:'participant_split',targetTableId:tableId,targetTableSessionId:null,
        movedGuestCount:1,participantPublicIds:['participant-public-0001'],reason:'顾客确认拆桌',
      } })
    expect(response.statusCode).toBe(200)
    expect(commands.moveParticipants).toHaveBeenCalledWith(expect.objectContaining({
      movementKind:'participant_split',movedGuestCount:1,
      participantPublicIds:['participant-public-0001'],reason:'顾客确认拆桌',
    }))
  })

  it('lists safe participants and previews a target-organizer role adjustment', async () => {
    const app=await build(commandPort(),scriptedTransaction(['table.participation.manage']))
    const participants=await app.inject({ method:'GET',
      url:`/table-management/sessions/${sourceSessionId}/participants` })
    expect(participants.statusCode).toBe(200)
    expect(participants.json()).toEqual({ data:[{
      publicId:participantPublicId,customerPublicId:'customer-public-safe',role:'organizer',
      confirmationState:'confirmed',identityLevel:'identified',seatLabel:'A1',
      locationStartedAt:'2026-08-11T12:00:00.000Z',
    }],meta:{ count:1 } })
    const preview=await app.inject({ method:'POST',
      url:`/table-management/sessions/${sourceSessionId}/participant-movements/preview`,
      payload:{ movementKind:'participant_merge',targetTableId:tableId,
        targetTableSessionId:targetSessionId,movedGuestCount:1,
        participantPublicIds:[participantPublicId] } })
    expect(preview.statusCode).toBe(200)
    expect(preview.json().data).toMatchObject({
      targetCapacity:4,projectedGuestCount:3,requiresCapacityOverride:false,
      finalRevalidationRequired:true,
      roleAdjustments:[{ participantPublicId,fromRole:'organizer',toRole:'companion',
        reason:'保留目标桌主联系人，迁入主联系人调整为同行顾客' }],
      blockers:[{ code:'KDS_ACTIVE',count:2,label:'仍有进行中的出品任务',
        resolution:'请先完成或取消相关KDS任务' }],
    })
  })

  it('denies participant list, preview, and execution without the movement permission', async () => {
    const commands=commandPort()
    commands.moveParticipants.mockRejectedValue(new StaffAccessDeniedError('revoked during command'))
    const app=await build(commands,scriptedTransaction())
    const list=await app.inject({ method:'GET',
      url:`/table-management/sessions/${sourceSessionId}/participants` })
    const preview=await app.inject({ method:'POST',
      url:`/table-management/sessions/${sourceSessionId}/participant-movements/preview`,payload:{
        movementKind:'participant_merge',targetTableId:tableId,targetTableSessionId:targetSessionId,
        movedGuestCount:1,participantPublicIds:[participantPublicId],
      } })
    const execute=await app.inject({ method:'POST',
      url:`/table-management/sessions/${sourceSessionId}/participant-movements`,
      headers:{ 'x-idempotency-key':'participant-denied-0001' },payload:{
        movementKind:'participant_merge',targetTableId:tableId,targetTableSessionId:targetSessionId,
        movedGuestCount:1,participantPublicIds:[participantPublicId],reason:'顾客确认并桌',
      } })
    for (const response of [list,preview,execute]) {
      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({ error:{ code:'TABLE_PERMISSION_DENIED',
        message:'当前岗位无权执行该桌台操作' } })
    }
  })

  it('maps movement conflicts to a privacy-safe 409 without target identifiers', async () => {
    const commands=commandPort()
    commands.moveParticipants.mockRejectedValue(new TableManagementConflictError(
      '当前桌次存在未结业务、容量或位置冲突，请处理后重试',
    ))
    const app=await build(commands)
    const response=await app.inject({ method:'POST',
      url:`/table-management/sessions/${sourceSessionId}/participant-movements`,
      headers:{ 'x-idempotency-key':'participant-conflict-0001' },payload:{
        movementKind:'participant_merge',targetTableId:tableId,targetTableSessionId:targetSessionId,
        movedGuestCount:1,participantPublicIds:[participantPublicId],reason:'顾客确认并桌',
      } })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('TABLE_OPERATION_CONFLICT')
    expect(response.body).not.toContain(tableId)
    expect(response.body).not.toContain(targetSessionId)
  })
})

async function build(commands = commandPort(), transaction = scriptedTransaction()) {
  const app = Fastify()
  apps.push(app)
  await app.register(tableManagementApiPlugin, {
    transactions: {
      run: async (_scope, operation) => operation(transaction),
    },
    commands,
    resolveContext: () => ({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-11',
      capabilities: ['table.open'],
    }),
  })
  return app
}

function commandPort() {
  return {
    createArea: vi.fn(), updateArea: vi.fn(), createTable: vi.fn(), updateTable: vi.fn(),
    assign: vi.fn(), assignMany: vi.fn(), endAssignment: vi.fn(), open: vi.fn(), transfer: vi.fn(),
    moveParticipants:vi.fn(),
  }
}

function scriptedTransaction(permissionCodes: string[] = ['table.open']): ScopedTransaction {
  return {
    scope: { tenantId, storeId },
    query: async <Row extends Record<string, unknown>>(sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ')
      let rows: Record<string, unknown>[]
      if (normalized.includes('FROM mbox.table_assignments AS assignment')) {
        rows = []
      } else if (normalized.includes('FROM mbox.employees')) {
        rows = [{ id: employeeId, employee_code: 'liyan', display_name: '李艳', status: 'active', resolved_at: '2026-08-11T10:00:00.123456Z' }]
      } else if (normalized.includes('permission_facts')) {
        rows = permissionCodes.map((code) => ({ code, role_granted: true, override_granted: false, override_denied: false }))
      } else if (normalized.includes('FROM mbox.employee_roles')) {
        rows = [{ code: 'STORE_MANAGER', name: '店长' }]
      } else if (normalized.includes('FROM mbox.role_data_scopes')) {
        rows = []
      } else if (normalized.includes('FROM mbox.role_approval_limits')) {
        rows = []
      } else if (normalized.includes('FROM mbox.role_navigation_items')) {
        rows = []
      } else if (normalized.includes('FROM mbox.roles')) {
        rows = [{ id: '66666666-6666-4666-8666-666666666666', code: 'WAITER', name: '服务员' }]
      } else if (normalized.includes('FROM mbox.tables AS venue_table')) {
        rows = [{
          id: tableId, area_id: '55555555-5555-4555-8555-555555555555',
          area_code: 'OUTSIDE', area_name: '室外区域', code: 'W01', display_name: 'W01',
          capacity: 4, minimum_spend_minor: null, currency: 'CNY', layout_snapshot: {},
          status: 'available', assigned_to_actor: false, active_session_id: null,
          active_guest_count: null, created_at: '2026-08-11T00:00:00.000Z',
          updated_at: '2026-08-11T00:00:00.000Z',
        }]
      } else if (normalized.includes('customer.public_id AS customer_public_id')) {
        rows=[{ public_id:participantPublicId,customer_public_id:'customer-public-safe',
          participation_role:'organizer',confirmation_state:'confirmed',identity_level:'identified',
          seat_label:'A1',location_started_at:'2026-08-11T12:00:00.000Z' }]
      } else if (normalized.includes('source_session.guest_count AS source_guest_count')) {
        rows=[{ capacity:4,source_guest_count:1,source_table_id:sourceTableId,
          target_guest_count:2,target_session_id:targetSessionId,target_has_organizer:true }]
      } else if (normalized.includes('AS order_item_unresolved')) {
        rows=[{ order_item_unresolved:'0',kds_active:'2',payment_pending:'0',
          refund_pending:'0',service_active:'0' }]
      } else {
        throw new Error(`Unexpected query: ${normalized}`)
      }
      return { rows: rows as Row[], rowCount: rows.length }
    },
  }
}
