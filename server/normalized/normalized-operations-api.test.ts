import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandOutcome, IdempotentCommand } from './command-executor.js'
import { IdempotencyConflictError } from './command-executor.js'
import {
  normalizedOperationsApiPlugin,
  type NormalizedOperationsApiOptions,
} from './normalized-operations-api.js'
import { NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
import type { ServiceTask } from './service-task-repository.js'
import {
  ServiceTaskSessionMismatchError,
  ServiceTaskTransitionError,
} from './service-task-repository.js'
import type { TableSession } from './table-session-repository.js'
import { TableAlreadyOpenError } from './table-session-repository.js'
import { StaffSessionNotFoundError } from './staff-session-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'
const tableId = '44444444-4444-4444-8444-444444444444'
const sessionId = '55555555-5555-4555-8555-555555555555'
const taskId = '66666666-6666-4666-8666-666666666666'

const session: TableSession = {
  id: sessionId,
  tableId,
  tableCode: 'VIP1',
  publicId: 'session-public-vip1',
  businessDate: '2026-08-11',
  guestCount: 8,
  guestProfileSnapshot: {},
  status: 'open',
  openedByEmployeeId: employeeId,
  closedByEmployeeId: null,
  openedAt: '2026-08-11T12:00:00.000Z',
  closedAt: null,
}

const task: ServiceTask = {
  id: taskId,
  tableId,
  tableSessionId: sessionId,
  publicId: 'service-task-public-vip1',
  taskType: 'water',
  title: '送两杯冰水',
  detail: null,
  priority: 'normal',
  status: 'pending',
  source: 'employee',
  requestedRoleCode: 'SERVER',
  assignedEmployeeId: null,
  backupEmployeeId: null,
  requestCount: 1,
  requestSnapshot: {},
  dueAt: null,
  escalateAt: null,
  nextActionAt: '2026-08-11T12:05:00.000Z',
  acknowledgedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: '2026-08-11T12:00:00.000Z',
  updatedAt: '2026-08-11T12:00:00.000Z',
}

const transaction: ScopedTransaction = {
  scope: { tenantId, storeId },
  query: async () => ({ rows: [], rowCount: 0 }),
}

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function fixture(overrides: Partial<NormalizedOperationsApiOptions> = {}) {
  const operationsQuery = { getStaffView: vi.fn(async () => ({
    store: {
      id: storeId,
      code: 'lujiazui',
      name: 'M-BOX',
      timezone: 'Asia/Shanghai',
      businessDayCutoff: '06:00:00',
    },
    actor: {
      id: employeeId,
      employeeCode: 'LIYAN',
      displayName: '李艳',
      roleCodes: ['MANAGER'],
      roleNames: ['店长'],
      capabilities: ['table.view_all'],
    },
    tables: [],
    tasks: [],
  })) }
  const tableSessions = { open: vi.fn(async () => ({ value: session, replayed: false })) }
  const tableRepository = {
    beginClosing: vi.fn(async () => ({ ...session, status: 'closing' as const })),
    completeClosing: vi.fn(async () => ({
      ...session,
      status: 'closed' as const,
      closedByEmployeeId: employeeId,
      closedAt: '2026-08-11T12:30:00.000Z',
    })),
  }
  const taskRepository = {
    create: vi.fn(async () => task),
    findById: vi.fn(async () => task),
    acknowledge: vi.fn(async () => ({ ...task, status: 'acknowledged' as const })),
    start: vi.fn(async () => ({ ...task, status: 'in_progress' as const })),
    complete: vi.fn(async () => ({ ...task, status: 'completed' as const })),
    cancel: vi.fn(async () => ({ ...task, status: 'cancelled' as const })),
  }
  const executions: Array<{
    command: IdempotentCommand<unknown>
    outcome: CommandOutcome<unknown>
  }> = []
  const commandExecutor = {
    execute: vi.fn(async <Result>(
      command: Readonly<IdempotentCommand<Result>>,
      handler: (value: ScopedTransaction) => Promise<CommandOutcome<Result>>,
    ) => {
      const outcome = await handler(transaction)
      executions.push({
        command: command as IdempotentCommand<unknown>,
        outcome: outcome as CommandOutcome<unknown>,
      })
      return { value: outcome.result, replayed: false }
    }),
  }
  const options: NormalizedOperationsApiOptions = {
    operationsQuery,
    tableSessions,
    commandExecutor,
    resolveContext: () => ({
      scope: { tenantId, storeId },
      employeeId,
      businessDate: '2026-08-11',
      capabilities: ['dashboard.view', 'table.open', 'table.close', 'service.execute'],
    }),
    createTableSessionRepository: () => tableRepository,
    createServiceTaskRepository: () => taskRepository,
    createPublicId: (kind) => `${kind}-generated-0001`,
    ...overrides,
  }
  const app = Fastify()
  apps.push(app)
  app.register(normalizedOperationsApiPlugin, { ...options, prefix: '/api' })
  return {
    app,
    options,
    operationsQuery,
    tableSessions,
    tableRepository,
    taskRepository,
    commandExecutor,
    executions,
  }
}

describe('normalizedOperationsApiPlugin', () => {
  it('returns the normalized employee view and ignores client attempts to widen table scope', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'GET',
      url: '/api/operations?includeAllTables=true',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: { actor: { id: employeeId, displayName: '李艳' } } })
    expect(value.operationsQuery.getStaffView).toHaveBeenCalledWith(
      { tenantId, storeId },
      employeeId,
    )

    const forged = await value.app.inject({
      method: 'GET',
      url: '/api/operations?includeAllTables=all',
    })
    expect(forged.statusCode).toBe(200)
  })

  it('binds an open-table command to the resolved employee and requires idempotency', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/table-sessions',
      headers: { 'idempotency-key': 'open-vip1-0001' },
      payload: { tableCode: 'VIP1', guestCount: 8, actorId: employeeId },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ data: session, meta: { replayed: false } })
    expect(value.tableSessions.open).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId, storeId },
      actor: { type: 'employee', employeeId },
      openedByEmployeeId: employeeId,
      businessDate: '2026-08-11',
      idempotencyKey: 'open-vip1-0001',
      publicId: 'table-session-generated-0001',
      table: { kind: 'code', value: 'VIP1' },
    }))
    const command = value.tableSessions.open.mock.calls[0]?.[0]
    expect(command?.requestFingerprint).toContain(employeeId)

    const missing = await value.app.inject({
      method: 'POST',
      url: '/api/table-sessions',
      payload: { tableCode: 'VIP1', guestCount: 8 },
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json()).toMatchObject({ error: { code: 'REQUEST_INVALID' } })
  })

  it('rejects actor impersonation before calling a domain dependency', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/table-sessions',
      headers: { 'idempotency-key': 'open-vip1-0002' },
      payload: {
        tableCode: 'VIP1',
        guestCount: 8,
        actorId: '77777777-7777-4777-8777-777777777777',
      },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'ACTOR_BINDING_FORBIDDEN' } })
    expect(value.tableSessions.open).not.toHaveBeenCalled()
  })

  it('rejects a correctly identified employee who lacks the required capability', async () => {
    const value = fixture({
      resolveContext: () => ({
        scope: { tenantId, storeId },
        employeeId,
        businessDate: '2026-08-11',
        capabilities: ['dashboard.view'],
      }),
    })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/table-sessions',
      headers: { 'idempotency-key': 'open-vip1-no-capability' },
      payload: { tableCode: 'VIP1', guestCount: 8 },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'CAPABILITY_FORBIDDEN' } })
    expect(value.tableSessions.open).not.toHaveBeenCalled()
  })

  it('executes both table closing stages through the injected transaction executor', async () => {
    const value = fixture()
    const begin = await value.app.inject({
      method: 'POST',
      url: `/api/table-sessions/${sessionId}/begin-closing`,
      headers: { 'idempotency-key': 'closing-vip1-0001' },
    })
    const close = await value.app.inject({
      method: 'POST',
      url: `/api/table-sessions/${sessionId}/close`,
      headers: { 'idempotency-key': 'close-vip1-0001' },
    })

    expect(begin.statusCode).toBe(200)
    expect(close.statusCode).toBe(200)
    expect(value.tableRepository.beginClosing).toHaveBeenCalledWith(sessionId, employeeId)
    expect(value.tableRepository.completeClosing).toHaveBeenCalledWith(sessionId, employeeId)
    expect(value.executions.map((item) => item.command.operationScope)).toEqual([
      'table-session.begin-closing',
      'table-session.close',
    ])
    expect(value.executions[0]?.outcome.auditEvents[0]).toMatchObject({
      actor: { type: 'employee', employeeId },
      action: 'table_session.closing_started',
    })
  })

  it('blocks final table closing while payable orders remain unsettled', async () => {
    const unsettledTransaction: ScopedTransaction = {
      scope: { tenantId, storeId },
      query: vi.fn(async (sql: string) => sql.includes('outstanding_amount_minor')
        ? { rows: [{ order_count: '2', outstanding_amount_minor: '15600' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }),
    }
    const commandExecutor = {
      execute: vi.fn(async <Result>(
        _command: Readonly<IdempotentCommand<Result>>,
        handler: (value: ScopedTransaction) => Promise<CommandOutcome<Result>>,
      ) => {
        const outcome = await handler(unsettledTransaction)
        return { value: outcome.result, replayed: false }
      }),
    }
    const value = fixture({ commandExecutor })

    const response = await value.app.inject({
      method: 'POST',
      url: `/api/table-sessions/${sessionId}/close`,
      headers: { 'idempotency-key': 'close-unsettled-vip1-0001' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({
      error: {
        code: 'TABLE_SESSION_UNSETTLED',
        message: '本桌仍有2笔未结订单（待收¥156.00），请先完成收款再关台',
      },
    })
    expect(value.tableRepository.completeClosing).not.toHaveBeenCalled()
  })

  it('lets authorized managers safely process only awaiting prior business days',async()=>{
    const value=fixture({resolveContext:()=>({
      scope:{tenantId,storeId},employeeId,businessDate:'2026-08-11',
      capabilities:['dashboard.view','business_day.close'],
    })})
    const response=await value.app.inject({
      method:'POST',url:'/api/business-days/close-pending',
      headers:{'idempotency-key':'close-pending-days-0001'},payload:{},
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({data:{businessDays:[],closedBusinessDayCount:0,
      closedTableSessionCount:0,blockedTableSessionCount:0},meta:{replayed:false}})
    expect(value.executions.at(-1)?.command.operationScope).toBe('business-day.close-pending')
  })

  it('denies prior-day closure without the dedicated capability',async()=>{
    const value=fixture()
    const response=await value.app.inject({method:'POST',url:'/api/business-days/close-pending',
      headers:{'idempotency-key':'close-pending-days-denied-0001'},payload:{}})
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({error:{code:'CAPABILITY_FORBIDDEN'}})
  })

  it('creates an employee service task with audit and outbox in one command', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/service-tasks',
      headers: { 'idempotency-key': 'task-water-0001' },
      payload: {
        tableId,
        tableSessionId: sessionId,
        taskType: 'water',
        title: '送两杯冰水',
        requestedRoleCode: 'SERVER',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ data: task, meta: { replayed: false } })
    expect(value.taskRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      publicId: 'service-task-generated-0001',
      source: 'employee',
      createdByEmployeeId: employeeId,
      actor: { type: 'employee', employeeId },
      eventIdempotencyKey: 'task-water-0001:created',
    }))
    expect(value.executions[0]?.outcome.auditEvents[0]).toMatchObject({
      actor: { type: 'employee', employeeId },
      action: 'service_task.created',
    })
    expect(value.executions[0]?.outcome.outboxMessages[0]).toMatchObject({
      eventType: 'service_task.created.v1',
    })
  })

  it.each([
    ['acknowledge', 'acknowledged'],
    ['start', 'in_progress'],
    ['complete', 'completed'],
    ['cancel', 'cancelled'],
  ] as const)('executes task %s with the authenticated actor', async (action, expectedStatus) => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: `/api/service-tasks/${taskId}/${action}`,
      headers: { 'idempotency-key': `task-${action}-0001` },
      payload: { note: '现场已确认' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: { id: taskId, status: expectedStatus } })
    expect(value.taskRepository[action]).toHaveBeenCalledWith({
      taskId,
      actor: { type: 'employee', employeeId },
      note: '现场已确认',
      eventIdempotencyKey: `task-${action}-0001:${action}`,
    })
  })

  it('keeps complaints manager-only and requires a recorded resolution', async () => {
    const complaint = { ...task, taskType: 'guest.complaint', title: '投诉 / 不满意', source: 'guest' as const }
    const server = fixture()
    server.taskRepository.findById.mockResolvedValue(complaint)
    const denied = await server.app.inject({
      method: 'POST',
      url: `/api/service-tasks/${taskId}/complete`,
      headers: { 'idempotency-key': 'complaint-server-denied-0001' },
      payload: { note: '已经处理完成' },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({ error: { code: 'CAPABILITY_FORBIDDEN' } })
    expect(server.taskRepository.complete).not.toHaveBeenCalled()

    const manager = fixture({
      resolveContext: () => ({
        scope: { tenantId, storeId }, employeeId, businessDate: '2026-08-11',
        capabilities: ['service.execute', 'service.manage'],
      }),
    })
    manager.taskRepository.findById.mockResolvedValue(complaint)
    const missingResolution = await manager.app.inject({
      method: 'POST',
      url: `/api/service-tasks/${taskId}/complete`,
      headers: { 'idempotency-key': 'complaint-manager-note-0001' },
      payload: {},
    })
    expect(missingResolution.statusCode).toBe(400)
    expect(manager.taskRepository.complete).not.toHaveBeenCalled()

    const completed = await manager.app.inject({
      method: 'POST',
      url: `/api/service-tasks/${taskId}/complete`,
      headers: { 'idempotency-key': 'complaint-manager-complete-0001' },
      payload: { note: '已到桌沟通并补送饮品' },
    })
    expect(completed.statusCode).toBe(200)
    expect(manager.taskRepository.complete).toHaveBeenCalledWith(expect.objectContaining({
      note: '已到桌沟通并补送饮品',
    }))
  })

  it('maps domain and idempotency failures to stable API errors', async () => {
    const tableConflict = fixture({
      tableSessions: { open: vi.fn(async () => { throw new TableAlreadyOpenError('VIP1') }) },
    })
    const open = await tableConflict.app.inject({
      method: 'POST',
      url: '/api/table-sessions',
      headers: { 'idempotency-key': 'open-vip1-conflict' },
      payload: { tableCode: 'VIP1', guestCount: 8 },
    })
    expect(open.statusCode).toBe(409)
    expect(open.json()).toMatchObject({ error: { code: 'TABLE_ALREADY_OPEN' } })

    const taskConflict = fixture()
    taskConflict.taskRepository.complete.mockRejectedValueOnce(
      new ServiceTaskTransitionError(taskId, 'completed'),
    )
    const complete = await taskConflict.app.inject({
      method: 'POST',
      url: `/api/service-tasks/${taskId}/complete`,
      headers: { 'idempotency-key': 'task-complete-conflict' },
    })
    expect(complete.statusCode).toBe(409)
    expect(complete.json()).toMatchObject({ error: { code: 'SERVICE_TASK_TRANSITION_CONFLICT' } })

    const taskSessionConflict = fixture()
    taskSessionConflict.taskRepository.create.mockRejectedValueOnce(
      new ServiceTaskSessionMismatchError(tableId, sessionId),
    )
    const createTask = await taskSessionConflict.app.inject({
      method: 'POST',
      url: '/api/service-tasks',
      headers: { 'idempotency-key': 'task-create-session-conflict' },
      payload: {
        tableId,
        tableSessionId: sessionId,
        taskType: 'water',
        title: '送两杯冰水',
      },
    })
    expect(createTask.statusCode).toBe(409)
    expect(createTask.json()).toMatchObject({
      error: {
        code: 'SERVICE_TASK_SESSION_MISMATCH',
        message: '桌台当前营业桌次已变化，请刷新后重试',
      },
    })

    const idempotency = fixture({
      commandExecutor: {
        execute: vi.fn(async () => {
          throw new IdempotencyConflictError('service-task.complete', 'task-complete-0001')
        }),
      },
    })
    const duplicate = await idempotency.app.inject({
      method: 'POST',
      url: `/api/service-tasks/${taskId}/complete`,
      headers: { 'idempotency-key': 'task-complete-0001' },
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } })
  })

  it.each([
    new NormalizedAuthenticationRequiredError(),
    new StaffSessionNotFoundError(),
  ])('maps missing or expired staff authentication to a stable 401 response', async (error) => {
    const value = fixture({ resolveContext: async () => { throw error } })
    const response = await value.app.inject({ method: 'GET', url: '/api/operations' })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: { code: 'AUTH_REQUIRED', message: '登录信息无效或已过期，请重新登录' },
    })
  })

  it('rejects malformed identifiers and unsupported employee task sources', async () => {
    const value = fixture()
    const malformed = await value.app.inject({
      method: 'POST',
      url: '/api/service-tasks/not-an-id/complete',
      headers: { 'idempotency-key': 'task-complete-0002' },
    })
    expect(malformed.statusCode).toBe(400)

    const source = await value.app.inject({
      method: 'POST',
      url: '/api/service-tasks',
      headers: { 'idempotency-key': 'task-water-0002' },
      payload: {
        tableId,
        tableSessionId: sessionId,
        taskType: 'water',
        title: '送水',
        source: 'guest',
      },
    })
    expect(source.statusCode).toBe(403)
    expect(source.json()).toMatchObject({ error: { code: 'ACTOR_BINDING_FORBIDDEN' } })
  })
})
