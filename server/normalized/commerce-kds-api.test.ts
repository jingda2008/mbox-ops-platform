import { readFile } from 'node:fs/promises'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CommandOutcome,
  IdempotentCommand,
} from './command-executor.js'
import { IdempotencyConflictError } from './command-executor.js'
import {
  commerceKdsApiPlugin,
  type CommerceKdsApiOptions,
} from './commerce-kds-api.js'
import type { SubmittedCommerceResult } from './commerce-command-service.js'
import type { FulfillmentStaffView } from './fulfillment-query-service.js'
import type { KdsTask } from './kds-repository.js'
import { FulfillmentCapacityUnavailableError } from './fulfillment-capacity-repository.js'
import { OrderProductUnavailableError, type OrderItem } from './order-repository.js'
import type {
  PostgresQueryResult,
  ScopedTransaction,
} from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const employeeId = '33333333-3333-4333-8333-333333333333'
const tableId = '44444444-4444-4444-8444-444444444444'
const tableSessionId = '55555555-5555-4555-8555-555555555555'
const orderId = '66666666-6666-4666-8666-666666666666'
const paymentId = '67676767-6767-4767-8767-676767676767'
const orderItemId = '77777777-7777-4777-8777-777777777777'
const productId = '88888888-8888-4888-8888-888888888888'
const taskId = '99999999-9999-4999-8999-999999999999'
const assistedContextId = '12121212-1212-4121-8121-121212121212'
const staffSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const deviceAccessLeaseId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const assistedToken = 'A'.repeat(43)
const giftApprovalId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const submittedOrderItem: OrderItem = {
  id: orderItemId,
  orderId,
  productId,
  quantity: 2,
  unitPriceMinor: 6_800,
  discountAmountMinor: 0,
  totalAmountMinor: 13_600,
  currency: 'CNY',
  fulfillmentStation: 'bar',
  productSnapshot: { code: 'BEER-001', name: '精酿啤酒' },
  costSnapshot: {},
  status: 'submitted',
  note: '少冰',
  createdAt: '2026-08-11T12:00:00.000Z',
}

const baseTask: KdsTask = {
  id: taskId,
  orderItemId,
  remakeOfTaskId: null,
  stationCode: 'bar',
  status: 'pending',
  priority: 100,
  quantity: 2,
  assignedEmployeeId: null,
  dueAt: null,
  nextActionAt: '2026-08-11T12:00:00.000Z',
  acceptedAt: null,
  readyAt: null,
  cancelledAt: null,
}

const commerceResult: SubmittedCommerceResult = {
  order: {
    id: orderId,
    tableSessionId,
    publicId: 'ORDER-VIP1-001',
    channel: 'staff_assisted',
    settlementMode: 'immediate_payment',
    status: 'submitted',
    paymentStatus: 'unpaid',
    subtotalAmountMinor: 13_600,
    discountAmountMinor: 0,
    totalAmountMinor: 13_600,
    currency: 'CNY',
    note: '整单一起上',
    createdByEmployeeId: employeeId,
    createdAt: '2026-08-11T12:00:00.000Z',
    submittedAt: '2026-08-11T12:00:00.000Z',
    items: [submittedOrderItem],
  },
  kdsTasks: [baseTask],
  inventoryConsumptions: [],
  paymentNextStep: {
    status: 'required',
    action: 'create_payment_intent',
    orderId,
    amountMinor: 13_600,
    currency: 'CNY',
    paymentStatus: 'unpaid',
  },
}

const fulfillmentView: FulfillmentStaffView = {
  actor: {
    employeeId,
    employeeCode: 'LIYAN',
    displayName: '李艳',
    roleCodes: ['MANAGER'],
    permissions: ['order.view'],
    allowedStations: [],
    canViewAll: false,
  },
  generatedAt: '2026-08-11T12:00:00.000Z',
  workItems: [],
}

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function fixture(input: {
  permissions?: string[]
  kdsStatus?: KdsTask['status']
  replayed?: boolean
  commerceError?: Error
  giftLimitAmountMinor?: number
  commerceResultOverride?: SubmittedCommerceResult
  onlinePaymentAvailable?: boolean
  onlinePaymentProvider?: 'postar' | 'simulation' | null
  resolveOnlinePaymentAvailable?: (scope: Readonly<{ tenantId: string; storeId: string }>) => Promise<boolean>
  tableAccessAllowed?: boolean
} = {}) {
  const permissions = input.permissions ?? [
    'order.create', 'order.view', 'kds.prepare', 'kds.deliver', 'kds.exception.manage',
  ]
  const staffQueries: string[] = []
  const staffTransaction: ScopedTransaction = {
    scope: { tenantId, storeId },
    query: async <Row extends Record<string, unknown>>(text: string): Promise<PostgresQueryResult<Row>> => {
      const sql = text.replace(/\s+/g, ' ').trim()
      staffQueries.push(sql)
      if (sql.includes('FROM mbox.employees') && sql.includes('employee_code')) {
        return rows([{
          id: employeeId,
          employee_code: 'LIYAN',
          display_name: '李艳',
          status: 'active',
        }]) as PostgresQueryResult<Row>
      }
      if (sql.startsWith('SELECT DISTINCT r.code, r.name')) {
        return rows([{ code: 'MANAGER', name: '店长' }]) as PostgresQueryResult<Row>
      }
      if (sql.includes('role_granted')) {
        return rows(permissions.map((code) => ({
          code,
          role_granted: true,
          override_granted: false,
          override_denied: false,
        }))) as PostgresQueryResult<Row>
      }
      if (sql.includes('session.status AS session_status')) {
        return rows([{
          employee_status: 'active',
          session_status: 'open',
          allowed: input.tableAccessAllowed ?? true,
          permissions_allowed: true,
        }]) as PostgresQueryResult<Row>
      }
      if (sql.includes('order_header.public_id AS order_public_id')) {
        return rows([
          {
            order_id: orderId,
            order_public_id: 'ORDER-VIP1-001',
            order_status: 'fulfilling',
            order_fulfillment_state: 'active',
            item_id: orderItemId,
            product_name: '精酿啤酒',
            quantity: '2',
            fulfillment_station: 'bar',
            item_status: 'delivered',
            kds_status: 'ready',
          },
          {
            order_id: orderId,
            order_public_id: 'ORDER-VIP1-001',
            order_status: 'fulfilling',
            order_fulfillment_state: 'active',
            item_id: '78787878-7878-4787-8787-787878787878',
            product_name: '威士忌酸',
            quantity: '1',
            fulfillment_station: 'bar',
            item_status: 'ready',
            kds_status: 'ready',
          },
          {
            order_id: '68686868-6868-4686-8686-686868686868',
            order_public_id: 'ORDER-VIP1-002',
            order_status: 'submitted',
            order_fulfillment_state: 'awaiting_payment',
            item_id: '79797979-7979-4797-8979-797979797979',
            product_name: '组合套餐',
            quantity: '1',
            fulfillment_station: 'kitchen',
            item_status: 'submitted',
            kds_status: null,
          },
        ]) as PostgresQueryResult<Row>
      }
      if (sql.includes('table_allowed')) {
        return rows([{ table_allowed: true }]) as PostgresQueryResult<Row>
      }
      if (sql.includes('FROM mbox.orders order_header')) {
        return rows([{
          id: orderId,
          public_id: 'ORDER-VIP1-001',
          currency: 'CNY',
          payment_status: 'unpaid',
          outstanding_amount_minor: '13600',
          has_online_payment_in_progress: true,
          unresolved_online_payment_id: paymentId,
        }]) as PostgresQueryResult<Row>
      }
      if (sql.includes('INSERT INTO mbox.assisted_order_contexts')) {
        return rows([{
          id: assistedContextId,
          employee_id: employeeId,
          staff_session_id: staffSessionId,
          device_access_lease_id: deviceAccessLeaseId,
          table_session_id: tableSessionId,
          table_id: tableId,
          table_code: 'VIP1',
          expires_at: '2026-08-11T12:15:00.000Z',
        }]) as PostgresQueryResult<Row>
      }
      if (sql.includes('FROM mbox.role_data_scopes')) {
        return rows([{
          scope_key: 'kds.station_codes', effect: 'include', value_kind: 'text_set',
          boolean_value: null, text_value: null, text_values: ['bar'],
        }]) as PostgresQueryResult<Row>
      }
      if (sql.includes('FROM mbox.role_approval_limits')) {
        return input.giftLimitAmountMinor === undefined
          ? rows([]) as PostgresQueryResult<Row>
          : rows([{
            id: giftApprovalId,
            approval_code: 'order.gift',
            amount_minor: String(input.giftLimitAmountMinor),
            currency: 'CNY',
            calculation_mode: 'full_gift', fixed_amount_minor: null,
            discount_basis_points: null, allow_full_gift: true,
            requires_reason: true, requires_second_actor: false,
          }]) as PostgresQueryResult<Row>
      }
      return rows([]) as PostgresQueryResult<Row>
    },
  }
  const staffAccessRunOptions: Array<{ readOnly?: boolean } | undefined> = []
  const staffAccessTransactions = {
    run: async <Result>(
      _scope: Readonly<{ tenantId: string; storeId: string }>,
      operation: (transaction: ScopedTransaction) => Promise<Result>,
      transactionOptions?: { readOnly?: boolean },
    ) => {
      staffAccessRunOptions.push(transactionOptions)
      return operation(staffTransaction)
    },
  } as CommerceKdsApiOptions['staffAccessTransactions']

  const currentTask = { ...baseTask, status: input.kdsStatus ?? baseTask.status }
  const commandQueries: string[] = []
  const commandTransaction: ScopedTransaction = {
    scope: { tenantId, storeId },
    query: async <Row extends Record<string, unknown>>(text: string): Promise<PostgresQueryResult<Row>> => {
      const sql = text.replace(/\s+/g, ' ').trim()
      commandQueries.push(sql)
      if (sql.includes('FROM mbox.kds_tasks AS task')) {
        return rows([{
          id: taskId,
          order_item_id: orderItemId,
          remake_of_task_id: null,
          station_code: 'bar',
          status: currentTask.status,
          priority: currentTask.priority,
          quantity: currentTask.quantity,
          assigned_employee_id: currentTask.assignedEmployeeId,
          due_at: currentTask.dueAt,
          next_action_at: currentTask.nextActionAt,
          accepted_at: currentTask.acceptedAt,
          ready_at: currentTask.readyAt,
          cancelled_at: currentTask.cancelledAt,
          created_at: '2026-08-11T12:00:00.000Z',
        }]) as PostgresQueryResult<Row>
      }
      if (sql.includes('FROM mbox.kds_exceptions AS exception')) {
        return rows([{
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          reason_code: 'ingredient_out_of_stock',
          reason_note: '青柠临时缺货',
        }]) as PostgresQueryResult<Row>
      }
      if (sql.startsWith('SELECT item.status FROM mbox.order_items AS item')) {
        return rows([{ status: 'preparing' }]) as PostgresQueryResult<Row>
      }
      if (sql.includes('FROM mbox.order_items AS item')) {
        return rows([{
          order_item_id: orderItemId,
          order_id: orderId,
          table_session_id: tableSessionId,
          table_id: tableId,
          table_code: 'VIP1',
          product_id: productId,
          product_name: '精酿啤酒',
          specification: '330ml',
          product_snapshot: { name: '精酿啤酒' },
          fulfillment_note: '整单一起上',
        }]) as PostgresQueryResult<Row>
      }
      if (sql.includes('FROM mbox.employees') && sql.includes('employee_code')) {
        return rows([{ id: employeeId, employee_code: 'LIYAN', display_name: '李艳', status: 'active' }]) as PostgresQueryResult<Row>
      }
      if (sql.startsWith('SELECT DISTINCT r.code, r.name')) {
        return rows([{ code: 'MANAGER', name: '店长' }]) as PostgresQueryResult<Row>
      }
      if (sql.includes('role_granted')) {
        return rows(permissions.map((code) => ({ code, role_granted: true, override_granted: false, override_denied: false }))) as PostgresQueryResult<Row>
      }
      if (sql.includes('FROM mbox.role_data_scopes')) {
        return rows([{
          scope_key: 'kds.station_codes', effect: 'include', value_kind: 'text_set',
          boolean_value: null, text_value: null, text_values: ['bar'],
        }]) as PostgresQueryResult<Row>
      }
      if (sql.includes('FROM mbox.staff_sessions AS session')) {
        return rows([{ id: staffSessionId }]) as PostgresQueryResult<Row>
      }
      if (sql.includes('FROM mbox.table_assignments AS assignment')) {
        return rows([{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }]) as PostgresQueryResult<Row>
      }
      if (sql.includes('FROM mbox.inventory_order_reservations')) {
        return rows([]) as PostgresQueryResult<Row>
      }
      if (sql.includes('FROM mbox.kds_remake_inventory_reservations')) {
        return rows([]) as PostgresQueryResult<Row>
      }
      if (sql.startsWith('UPDATE mbox.kds_tasks SET status=')) {
        return { rows: [] as Row[], rowCount: 1 }
      }
      if (sql.startsWith('INSERT INTO mbox.kds_task_events')) {
        return { rows: [] as Row[], rowCount: 1 }
      }
      if (sql.startsWith('INSERT INTO mbox.kds_exceptions')) {
        return { rows: [] as Row[], rowCount: 1 }
      }
      if (sql.startsWith('UPDATE mbox.kds_exceptions')) {
        return { rows: [] as Row[], rowCount: 1 }
      }
      if (sql.includes('FROM mbox.role_approval_limits') || sql.includes('FROM mbox.role_navigation_items')) {
        return rows([]) as PostgresQueryResult<Row>
      }
      throw new Error(`Unexpected command query: ${sql}`)
    },
  }
  const executions: Array<{
    command: IdempotentCommand<unknown>
    outcome: CommandOutcome<unknown>
  }> = []
  const commandExecutor = {
    execute: vi.fn(async <Result>(
      command: Readonly<IdempotentCommand<Result>>,
      operation: (transaction: ScopedTransaction) => Promise<CommandOutcome<Result>>,
    ) => {
      const outcome = await operation(commandTransaction)
      executions.push({
        command: command as IdempotentCommand<unknown>,
        outcome: outcome as CommandOutcome<unknown>,
      })
      return { value: outcome.result, replayed: input.replayed ?? false }
    }),
  }

  const acceptedTask = { ...currentTask, status: 'accepted' as const, assignedEmployeeId: employeeId }
  const preparingTask = { ...acceptedTask, status: 'preparing' as const }
  const readyTask = { ...preparingTask, status: 'ready' as const, readyAt: '2026-08-11T12:01:00.000Z' }
  const remadeTask = {
    ...baseTask,
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    status: 'pending' as const,
  }
  const kdsRepository = {
    accept: vi.fn(async () => acceptedTask),
    startPreparing: vi.fn(async () => preparingTask),
    markReady: vi.fn(async () => readyTask),
    cancel: vi.fn(async () => ({ ...currentTask, status: 'cancelled' as const })),
    fail: vi.fn(async () => ({ ...currentTask, status: 'failed' as const })),
    create: vi.fn(async () => remadeTask),
  }
  const deliveredItem = { ...submittedOrderItem, status: 'delivered' as const }
  const orderRepository = {
    markDelivered: vi.fn(async () => deliveredItem),
  }
  const commerce = {
    submitOrder: vi.fn(async () => {
      if (input.commerceError) throw input.commerceError
      return { value: input.commerceResultOverride ?? commerceResult, replayed: input.replayed ?? false }
    }),
  }
  const fulfillmentQuery = {
    getStaffWorkQueue: vi.fn(async () => fulfillmentView),
  }
  const options: CommerceKdsApiOptions = {
    commerce,
    fulfillmentQuery,
    commandExecutor,
    staffAccessTransactions,
    resolveContext: () => ({
      scope: { tenantId, storeId },
      employeeId,
      staffSessionId,
      deviceAccessLeaseId,
      businessDate: '2026-08-11',
    }),
    createKdsRepository: () => kdsRepository,
    createOrderRepository: () => orderRepository,
    resolveOpenTableSessionId: async (_scope, requestedTableId) => (
      requestedTableId === tableId ? tableSessionId : null
    ),
    onlinePaymentAvailable: input.onlinePaymentAvailable,
    resolveOnlinePaymentAvailable: input.resolveOnlinePaymentAvailable,
    onlinePaymentProvider: input.onlinePaymentProvider,
  }
  const app = Fastify()
  apps.push(app)
  app.register(commerceKdsApiPlugin, { ...options, prefix: '/api' })
  return {
    app,
    commerce,
    fulfillmentQuery,
    commandExecutor,
    kdsRepository,
    orderRepository,
    staffQueries,
    staffAccessRunOptions,
    commandQueries,
    executions,
  }
}

describe('commerceKdsApiPlugin', () => {
  it('returns order and employee gift capability without exposing the authority source id', async () => {
    const value = fixture({
      permissions: ['order.create', 'order.gift'],
      giftLimitAmountMinor: 50_000,
    })
    const response = await value.app.inject({ method: 'GET', url: '/api/commerce/assisted-order-access' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      data: {
        canCreateOrder: true,
        canInitiatePayment: false,
        paymentInitiationBlockReason: 'permission_required',
        canQueryOnlinePayment: false,
        onlinePaymentProvider: null,
        manualCollection: { canRecordCash: false, canRecordPos: false, canRecordExternal: false },
        gift: { enabled: true, maximumAmountMinor: 50_000, currency: 'CNY' },
      },
    })
    expect(JSON.stringify(response.json())).not.toContain(giftApprovalId)
  })

  it('returns the server-selected payment provider instead of letting the staff client guess it', async () => {
    const value = fixture({
      permissions: ['order.create', 'payment.initiate.staff'],
      onlinePaymentAvailable: true,
      onlinePaymentProvider: 'simulation',
    })
    const response = await value.app.inject({ method: 'GET', url: '/api/commerce/assisted-order-access' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: {
      canCreateOrder: true,
      canInitiatePayment: true,
      paymentInitiationBlockReason: null,
      canQueryOnlinePayment: false,
      onlinePaymentProvider: 'simulation',
    } })
  })

  it('reports each manual collection choice from live fine-grained permissions', async () => {
    const value = fixture({
      permissions: [
        'order.create',
        'payment.manual.cash.record',
        'payment.manual.pos.record',
        'payment.manual.external.record',
      ],
    })
    const response = await value.app.inject({ method: 'GET', url: '/api/commerce/assisted-order-access' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: {
      canCreateOrder: true,
      manualCollection: { canRecordCash: true, canRecordPos: true, canRecordExternal: true },
    } })
  })

  it('returns the unresolved payment id so an assigned employee can query or release the stalled attempt', async () => {
    const value = fixture({ permissions: ['payment.manual.cash.record'] })
    const response = await value.app.inject({
      method: 'GET',
      url: `/api/commerce/table-sessions/${tableSessionId}/payment-orders`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: [{
      id: orderId,
      publicId: 'ORDER-VIP1-001',
      currency: 'CNY',
      paymentStatus: 'unpaid',
      outstandingAmountMinor: 13_600,
      hasOnlinePaymentInProgress: true,
      unresolvedOnlinePaymentId: paymentId,
    }] })
    expect(value.staffQueries.some((sql) => sql.includes('pending.unresolved_online_payment_id'))).toBe(true)
    expect(value.staffAccessRunOptions).toEqual([{ readOnly: true }, { readOnly: true }])
  })

  it('keeps the table payment order list hidden from staff without any collection capability', async () => {
    const value = fixture({ permissions: ['order.view'] })
    const response = await value.app.inject({
      method: 'GET',
      url: `/api/commerce/table-sessions/${tableSessionId}/payment-orders`,
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({
      error: { code: 'STAFF_ACCESS_FORBIDDEN', message: '当前员工无权执行此操作' },
    })
    expect(value.staffQueries.some((sql) => sql.includes('FROM mbox.orders order_header'))).toBe(false)
  })

  it('lets any service employee inspect active-table delivery progress without payment data', async () => {
    const value = fixture({ permissions: ['service.execute'] })
    const response = await value.app.inject({
      method: 'GET',
      url: `/api/commerce/table-sessions/${tableSessionId}/order-details`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: [
      {
        publicId: 'ORDER-VIP1-001',
        items: [
          {
            id: orderItemId,
            productName: '精酿啤酒',
            quantity: 2,
            fulfillmentStation: 'bar',
            fulfillmentStatus: 'delivered',
          },
          {
            id: '78787878-7878-4787-8787-787878787878',
            productName: '威士忌酸',
            quantity: 1,
            fulfillmentStation: 'bar',
            fulfillmentStatus: 'ready_for_delivery',
          },
        ],
      },
      {
        publicId: 'ORDER-VIP1-002',
        items: [{
          id: '79797979-7979-4797-8979-797979797979',
          productName: '组合套餐',
          quantity: 1,
          fulfillmentStation: 'kitchen',
          fulfillmentStatus: 'awaiting_payment',
        }],
      },
    ] })
    const detailQuery = value.staffQueries.find((sql) => sql.includes('order_header.public_id AS order_public_id'))
    expect(detailQuery).toContain('item.status AS item_status')
    expect(detailQuery).toContain("WHEN 'ready' THEN 0")
    expect(detailQuery).not.toContain('total_amount_minor')
    expect(detailQuery).not.toContain('mbox.payments')
    expect(value.staffAccessRunOptions).toEqual([{ readOnly: true }, { readOnly: true }])
  })

  it('returns a clear 403 rather than a 500 when a table order detail read loses its active-table scope', async () => {
    const value = fixture({ permissions: ['service.execute'], tableAccessAllowed: false })
    const response = await value.app.inject({
      method: 'GET',
      url: `/api/commerce/table-sessions/${tableSessionId}/order-details`,
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({
      error: { code: 'TABLE_ACCESS_FORBIDDEN', message: '当前员工不是该桌负责人，无权操作此桌' },
    })
  })

  it('uses the current store policy instead of the startup payment flag', async () => {
    const value = fixture({
      permissions: ['order.create', 'payment.initiate.staff'],
      onlinePaymentAvailable: true,
      onlinePaymentProvider: 'postar',
      resolveOnlinePaymentAvailable: vi.fn(async () => false),
    })
    const response = await value.app.inject({ method: 'GET', url: '/api/commerce/assisted-order-access' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: {
      canInitiatePayment: false,
      paymentInitiationBlockReason: 'online_payment_unavailable',
      onlinePaymentProvider: 'postar',
    } })
  })

  it('distinguishes an unconfigured payment provider from a missing service permission', async () => {
    const value = fixture({
      permissions: ['order.create', 'payment.initiate.staff'],
      onlinePaymentAvailable: true,
      onlinePaymentProvider: null,
    })
    const response = await value.app.inject({ method: 'GET', url: '/api/commerce/assisted-order-access' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: {
      canInitiatePayment: false,
      paymentInitiationBlockReason: 'provider_not_configured',
      onlinePaymentProvider: null,
    } })
  })

  it('issues a server-bound short-lived assisted-order context for an open assigned table', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/commerce/assisted-order-contexts',
      payload: { tableId, actorId: employeeId },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      data: {
        id: assistedContextId,
        employeeId,
        staffSessionId,
        deviceAccessLeaseId,
        tableSessionId,
        tableCode: 'VIP1',
      },
    })
    expect(response.json().data.token).toMatch(/^[A-Za-z0-9_-]{32,128}$/)
    expect(value.staffQueries.some((sql) => sql.includes('table_allowed'))).toBe(true)
  })

  it('submits a staff-assisted order with live order permission and stable response compatibility', async () => {
    const value = fixture()
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/commerce/orders',
      headers: {
        'idempotency-key': 'order-vip1-0001',
        'x-assisted-order-context': assistedToken,
      },
      payload: {
        tableSessionId,
        actorId: employeeId,
        items: [{ productId, quantity: 2, note: '少冰' }],
        fulfillmentNote: '整单一起上',
        settlementMode: 'immediate_payment',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      id: orderId,
      tableSessionId,
      status: 'submitted',
      paymentStatus: 'unpaid',
      settlementMode: 'immediate_payment',
      totalAmountMinor: 13_600,
      fulfillmentNote: '整单一起上',
      amounts: {
        grossAmount: 13_600,
        discountAmount: 0,
        giftAmount: 0,
        payableAmount: 13_600,
      },
      kdsTasks: [{ id: taskId }],
      paymentNextStep: {
        status: 'required', action: 'create_payment_intent', paymentStatus: 'unpaid',
      },
      items: [{
        id: orderItemId,
        skuId: productId,
        name: '精酿啤酒',
        quantity: 2,
        unitListPriceAmount: 6_800,
        stationId: 'bar',
        kdsTaskId: taskId,
        addedBy: employeeId,
        addedAt: '2026-08-11T12:00:00.000Z',
      }],
      meta: { replayed: false },
    })
    expect(value.commerce.submitOrder).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId, storeId },
      actor: { type: 'employee', employeeId },
      createdByEmployeeId: employeeId,
      tableSessionId,
      channel: 'staff_assisted',
      idempotencyKey: 'order-vip1-0001',
      lines: [{ productId, quantity: 2, note: '少冰' }],
      settlementMode: 'immediate_payment',
      assistedOrderContext: {
        token: assistedToken,
        employeeId,
        staffSessionId,
        deviceAccessLeaseId,
      },
    }))
    expect(value.staffQueries.some((sql) => sql.includes('role_granted'))).toBe(true)
  })

  it('returns a safe request reference when an unexpected order failure needs investigation', async () => {
    const value = fixture({ commerceError: new Error('database detail must stay private') })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/commerce/orders',
      headers: {
        'idempotency-key': 'order-unexpected-0001',
        'x-assisted-order-context': assistedToken,
      },
      payload: { tableSessionId, items: [{ productId, quantity: 1 }] },
    })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务暂时不可用，请稍后重试',
        referenceId: expect.stringMatching(/^[A-Za-z0-9._:-]{1,64}$/),
      },
    })
    expect(response.body).not.toContain('database detail')
  })

  it('resolves an employee gift authority on the server and records the required reason', async () => {
    const giftResult: SubmittedCommerceResult = {
      ...commerceResult,
      order: {
        ...commerceResult.order,
        settlementMode: 'table_tab',
        subtotalAmountMinor: 6_800,
        discountAmountMinor: 6_800,
        totalAmountMinor: 0,
        note: '赠送原因：生日关怀',
        items: [{
          ...submittedOrderItem,
          quantity: 1,
          discountAmountMinor: 6_800,
          totalAmountMinor: 0,
        }],
      },
      paymentNextStep: {
        status: 'deferred', action: 'settle_table_later', orderId, amountMinor: 0,
        currency: 'CNY', paymentStatus: 'unpaid',
      },
    }
    const value = fixture({
      permissions: ['order.create', 'order.gift'],
      giftLimitAmountMinor: 50_000,
      commerceResultOverride: giftResult,
    })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/commerce/orders',
      headers: {
        'idempotency-key': 'gift-vip1-0001',
        'x-assisted-order-context': assistedToken,
      },
      payload: {
        tableSessionId,
        orderMode: 'gift',
        giftReason: '生日关怀',
        items: [{ productId, quantity: 1 }],
        pricingAuthorization: { sourceType: 'employee', sourceId: employeeId },
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      orderMode: 'gift',
      totalAmountMinor: 0,
      amounts: { grossAmount: 6_800, discountAmount: 0, giftAmount: 6_800, payableAmount: 0 },
    })
    expect(value.commerce.submitOrder).toHaveBeenCalledWith(expect.objectContaining({
      note: '赠送原因：生日关怀',
      settlementMode: 'table_tab',
      pricingAuthorization: { sourceType: 'employee', sourceId: giftApprovalId },
    }))
  })

  it('rejects a gift without a reason before resolving or submitting authority', async () => {
    const value = fixture({
      permissions: ['order.create', 'order.gift'],
      giftLimitAmountMinor: 50_000,
    })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/commerce/orders',
      headers: { 'x-assisted-order-context': assistedToken },
      payload: {
        idempotencyKey: 'gift-reason-missing',
        tableSessionId,
        orderMode: 'gift',
        items: [{ productId, quantity: 1 }],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: { code: 'GIFT_REASON_REQUIRED', message: '请填写至少2个字的赠送原因' },
    })
    expect(value.commerce.submitOrder).not.toHaveBeenCalled()
  })

  it('does not trust an old tableId claim during staff-assisted submit', async () => {
    const value = fixture({ replayed: true })
    const response = await value.app.inject({
      method: 'POST',
      url: '/api/commerce/orders',
      headers: { 'x-assisted-order-context': assistedToken },
      payload: {
        tableId,
        actorId: employeeId,
        idempotencyKey: 'order-table-alias-0001',
        items: [{ productId, quantity: 1 }],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ meta: { replayed: true } })
    expect(value.commerce.submitOrder).toHaveBeenCalledWith(expect.objectContaining({
      tableSessionId: undefined,
      assistedOrderContext: expect.objectContaining({ token: assistedToken }),
    }))
  })

  it('rejects actor impersonation and missing live order permission before creating an order', async () => {
    const impersonated = fixture()
    const actorResponse = await impersonated.app.inject({
      method: 'POST',
      url: '/api/commerce/orders',
      payload: {
        tableSessionId,
        actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        idempotencyKey: 'order-actor-denied',
        items: [{ productId, quantity: 1 }],
      },
    })
    expect(actorResponse.statusCode).toBe(403)
    expect(actorResponse.json()).toEqual({
      error: { code: 'ACTOR_BINDING_FORBIDDEN', message: '请求中的员工身份与当前登录员工不一致' },
    })
    expect(impersonated.commerce.submitOrder).not.toHaveBeenCalled()

    const denied = fixture({ permissions: ['order.view'] })
    const deniedResponse = await denied.app.inject({
      method: 'POST',
      url: '/api/commerce/orders',
      headers: {
        'idempotency-key': 'order-permission-denied',
        'x-assisted-order-context': assistedToken,
      },
      payload: { tableSessionId, items: [{ productId, quantity: 1 }] },
    })
    expect(deniedResponse.statusCode).toBe(403)
    expect(deniedResponse.json()).toEqual({
      error: { code: 'STAFF_ACCESS_FORBIDDEN', message: '当前员工无权执行此操作' },
    })
    expect(denied.commerce.submitOrder).not.toHaveBeenCalled()
  })

  it('returns the role-filtered fulfillment queue only to employees with a relevant permission', async () => {
    const value = fixture({ permissions: ['kds.deliver'] })
    const response = await value.app.inject({ method: 'GET', url: '/api/commerce/fulfillment' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ data: fulfillmentView })
    expect(value.fulfillmentQuery.getStaffWorkQueue).toHaveBeenCalledWith(
      { tenantId, storeId },
      employeeId,
      '2026-08-11',
    )

    const denied = fixture({ permissions: ['dashboard.view'] })
    const deniedResponse = await denied.app.inject({ method: 'GET', url: '/api/commerce/fulfillment' })
    expect(deniedResponse.statusCode).toBe(403)
    expect(denied.fulfillmentQuery.getStaffWorkQueue).not.toHaveBeenCalled()
  })

  it('maps old start semantics to accept then start in one idempotent normalized command', async () => {
    const value = fixture({ permissions: ['kds.prepare'], kdsStatus: 'pending' })
    const response = await value.app.inject({
      method: 'POST',
      url: `/api/commerce/kds/${taskId}/actions`,
      payload: { action: 'start', actorId: employeeId, idempotencyKey: 'kds-start-0001' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: taskId,
      status: 'preparing',
      normalizedStatus: 'preparing',
      fulfillmentStatus: 'in_progress',
      meta: { replayed: false },
    })
    expect(value.kdsRepository.accept).toHaveBeenCalledOnce()
    expect(value.kdsRepository.startPreparing).toHaveBeenCalledOnce()
    expect(value.commandQueries[0]).toContain('task.id = $3::uuid')
    expect(value.commandQueries[0]).not.toContain('JOIN mbox.order_items')
    expect(value.commandQueries[1]).toContain('item.id = $3::uuid')
    expect(value.commandQueries[1]).not.toContain('FOR UPDATE')
    expect(value.executions[0]?.command).toMatchObject({
      operationScope: 'commerce.kds.action',
      idempotencyKey: 'kds-start-0001',
    })
    expect(value.executions[0]?.outcome.auditEvents[0]).toMatchObject({
      actor: { type: 'employee', employeeId },
      action: 'kds.start',
      objectId: taskId,
    })
    expect(value.executions[0]?.outcome.outboxMessages[0]).toMatchObject({
      eventType: 'kds.start.v1',
    })
  })

  it('completes pending production through required intermediate states', async () => {
    const value = fixture({ permissions: ['kds.prepare'], kdsStatus: 'pending' })
    const response = await value.app.inject({
      method: 'POST',
      url: `/api/commerce/kds/${taskId}/actions`,
      headers: { 'idempotency-key': 'kds-complete-0001' },
      payload: { action: 'complete' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      status: 'completed',
      normalizedStatus: 'ready',
      fulfillmentStatus: 'ready',
    })
    expect(value.kdsRepository.accept).toHaveBeenCalledOnce()
    expect(value.kdsRepository.startPreparing).toHaveBeenCalledOnce()
    expect(value.kdsRepository.markReady).toHaveBeenCalledOnce()
  })

  it('delivers only a ready item with kds.deliver permission and keeps financial actions out of scope', async () => {
    const value = fixture({ permissions: ['kds.deliver'], kdsStatus: 'ready' })
    const response = await value.app.inject({
      method: 'POST',
      url: `/api/commerce/kds/${taskId}/actions`,
      payload: { action: 'pickupAndDeliver', idempotencyKey: 'kds-deliver-0001' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: taskId,
      status: 'delivered',
      normalizedStatus: 'ready',
      fulfillmentStatus: 'delivered',
      deliveredOrderItem: { id: orderItemId, status: 'delivered' },
    })
    expect(value.orderRepository.markDelivered).toHaveBeenCalledWith(orderItemId, employeeId)
    expect(value.kdsRepository.markReady).not.toHaveBeenCalled()
    expect(value.commandQueries[0]).toContain('mbox.kds_tasks')
    expect(value.commandQueries[0]).not.toContain('mbox.order_items')
    expect(value.commandQueries[1]).toContain('mbox.order_items')
  })

  it('removes ordinary cancel and requires failure reasons with actionable audit evidence', async () => {
    const value = fixture({ permissions: ['kds.prepare'], kdsStatus: 'pending' })
    const cancelled = await value.app.inject({
      method: 'POST',
      url: `/api/commerce/kds/${taskId}/actions`,
      payload: { action: 'cancel', idempotencyKey: 'ordinary-cancel-0001' },
    })
    expect(cancelled.statusCode).toBe(400)
    expect(cancelled.json()).toMatchObject({ error: { code: 'KDS_ACTION_INVALID' } })
    expect(value.kdsRepository.cancel).not.toHaveBeenCalled()

    const missingReason = await value.app.inject({
      method: 'POST',
      url: `/api/commerce/kds/${taskId}/actions`,
      payload: { action: 'fail', idempotencyKey: 'kds-fail-missing-reason' },
    })
    expect(missingReason.statusCode).toBe(400)
    expect(value.kdsRepository.fail).not.toHaveBeenCalled()

    const failed = await value.app.inject({
      method: 'POST',
      url: `/api/commerce/kds/${taskId}/actions`,
      payload: {
        action: 'fail', idempotencyKey: 'kds-fail-with-reason',
        reasonCode: 'ingredient_out_of_stock', reasonNote: '青柠临时缺货',
      },
    })
    expect(failed.statusCode).toBe(200)
    expect(failed.json()).toMatchObject({
      normalizedStatus: 'failed',
      exceptionEvents: [{
        type: 'reported',
        exceptionKind: 'production_rejection',
        reasonCode: 'ingredient_out_of_stock',
        orderId,
        orderItemId,
        kdsTaskId: taskId,
        managerDisposition: null,
        financialTruth: 'unchanged_pending_review',
        requiredActions: ['manager_review', 'inventory_review', 'remake_or_cancel_decision'],
      }],
    })
    expect(value.commandQueries.some((sql) => sql.startsWith('INSERT INTO mbox.kds_exceptions'))).toBe(true)
    expect(value.executions.at(-1)?.outcome.outboxMessages[0]?.payload).toMatchObject({
      exceptionEvidence: { reasonNote: '青柠临时缺货' },
    })
  })

  it('uses a separate manager exception route and does not pretend financial truth changed', async () => {
    const value = fixture({
      permissions: ['kds.exception.manage'],
      kdsStatus: 'pending',
    })
    const response = await value.app.inject({
      method: 'POST',
      url: `/api/commerce/kds/${taskId}/manager-cancel`,
      payload: {
        idempotencyKey: 'manager-cancel-0001',
        reasonCode: 'guest_cancelled',
        reasonNote: '客人确认不再需要，等待财务和库存复核',
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      normalizedStatus: 'cancelled',
      exceptionEvents: [{
        type: 'manager_disposition',
        managerDisposition: 'cancelled',
        orderId,
        orderItemId,
        kdsTaskId: taskId,
        financialTruth: 'unchanged_pending_review',
        inventoryTruth: 'unchanged_pending_review',
        requiredActions: ['financial_review', 'inventory_review', 'guest_communication'],
      }],
    })
    expect(value.kdsRepository.cancel).toHaveBeenCalledOnce()
    expect(value.executions[0]?.outcome.auditEvents[0]).toMatchObject({
      action: 'kds.manager_cancelled',
      afterData: { exceptionEvidence: { reasonCode: 'guest_cancelled' } },
    })
    expect(value.executions[0]?.outcome.outboxMessages[0]).toMatchObject({
      eventType: 'kds.manager_cancelled.v1',
    })
  })

  it('keeps a failed production task visible through a narrow remake command without reopening its history', async () => {
    const value = fixture({
      permissions: ['kds.exception.manage'],
      kdsStatus: 'failed',
    })
    const response = await value.app.inject({
      method: 'POST',
      url: `/api/commerce/kds/${taskId}/remake`,
      payload: {
        idempotencyKey: 'kds-remake-0001',
        reasonCode: 'production_remake',
        reasonNote: '现场确认后重新制作',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      normalizedStatus: 'pending',
      exceptionEvents: [{
        type: 'remade',
        managerDisposition: 'remade',
        originalKdsTaskId: taskId,
        remakeKdsTaskId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        financialTruth: 'no_action_required',
        inventoryTruth: 'no_action_required',
      }],
    })
    expect(value.kdsRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      orderItemId,
      stationCode: 'bar',
    }))
    expect(value.kdsRepository.fail).not.toHaveBeenCalled()
    expect(value.executions[0]?.outcome.auditEvents[0]).toMatchObject({ action: 'kds.exception_remade' })
  })

  it('returns stable business errors for combined actions, stale products and idempotency conflicts', async () => {
    const combined = fixture({ permissions: ['kds.prepare', 'kds.deliver'] })
    const combinedResponse = await combined.app.inject({
      method: 'POST',
      url: `/api/commerce/kds/${taskId}/actions`,
      payload: { action: 'completeAndDeliver', idempotencyKey: 'kds-combined-0001' },
    })
    expect(combinedResponse.statusCode).toBe(409)
    expect(combinedResponse.json()).toMatchObject({ error: { code: 'KDS_COMBINED_ACTION_DISABLED' } })

    const stale = fixture({ commerceError: new OrderProductUnavailableError(productId) })
    const staleResponse = await stale.app.inject({
      method: 'POST',
      url: '/api/commerce/orders',
      headers: { 'x-assisted-order-context': assistedToken },
      payload: {
        tableSessionId,
        idempotencyKey: 'order-stale-product',
        items: [{ productId, quantity: 1 }],
      },
    })
    expect(staleResponse.statusCode).toBe(409)
    expect(staleResponse.json()).toMatchObject({ error: { code: 'ORDER_PRODUCT_UNAVAILABLE' } })

    const capacity = fixture({
      commerceError: new FulfillmentCapacityUnavailableError(
        'FULFILLMENT_CAPACITY_CONFIGURATION_INCOMPLETE',
        '出品产能时间窗未完整配置，请联系值班经理',
      ),
    })
    const capacityResponse = await capacity.app.inject({
      method: 'POST',
      url: '/api/commerce/orders',
      headers: { 'x-assisted-order-context': assistedToken },
      payload: {
        tableSessionId,
        idempotencyKey: 'order-capacity-incomplete',
        items: [{ productId, quantity: 1 }],
      },
    })
    expect(capacityResponse.statusCode).toBe(409)
    expect(capacityResponse.json()).toMatchObject({ error: {
      code: 'FULFILLMENT_CAPACITY_CONFIGURATION_INCOMPLETE',
    } })

    const idempotency = fixture({
      commerceError: new IdempotencyConflictError('commerce.order.submit', 'order-conflict-0001'),
    })
    const conflictResponse = await idempotency.app.inject({
      method: 'POST',
      url: '/api/commerce/orders',
      headers: { 'x-assisted-order-context': assistedToken },
      payload: {
        tableSessionId,
        idempotencyKey: 'order-conflict-0001',
        items: [{ productId, quantity: 1 }],
      },
    })
    expect(conflictResponse.statusCode).toBe(409)
    expect(conflictResponse.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } })
  })

  it('contains no dependency on retired state or projection paths', async () => {
    const source = await readFile(new URL('./commerce-kds-api.ts', import.meta.url), 'utf8')
    const forbidden = [
      ['Runtime', 'State'].join(''),
      ['repository', 'mutate'].join('.'),
      ['operational', '_'].join(''),
    ]
    for (const token of forbidden) expect(source).not.toContain(token)
  })
})

function rows(values: Record<string, unknown>[]): PostgresQueryResult {
  return { rows: values, rowCount: values.length }
}
