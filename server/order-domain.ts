import type {
  AddOrderItemCommand,
  AuthorizationKind,
  CreateOrderDraftCommand,
  DecideOrderAuthorizationCommand,
  FulfillmentWorkstationConfig,
  IdempotencyRecord,
  KdsTask,
  KdsTaskActionCommand,
  KdsTaskStatus,
  Order,
  OrderAmounts,
  OrderAuthorization,
  OrderAuthorizationAuthority,
  OrderDomainState,
  OrderItem,
  RequestOrderAuthorizationCommand,
  SubmitOrderCommand,
  TableAccountSummary,
  TableLedgerEntry,
  TableLedgerEntryType,
} from '../src/shared/order-contracts.js'
import {
  defaultFulfillmentWorkstations,
  normalizeOrderFulfillmentState,
  resolveFulfillmentWorkstation,
  validateFulfillmentWorkstations,
} from './fulfillment-workstations.js'

type IdempotencyResultType = IdempotencyRecord['resultType']

export function createOrderDomainState(
  authorizationAuthorities: OrderAuthorizationAuthority[] = [],
  fulfillmentWorkstations: FulfillmentWorkstationConfig[] = defaultFulfillmentWorkstations.map((item) => ({
    ...item,
    productionRoleIds: [...item.productionRoleIds],
    deliveryRoleIds: [...item.deliveryRoleIds],
    requiredSkillIds: [...item.requiredSkillIds],
  })),
): OrderDomainState {
  if (new Set(authorizationAuthorities.map((authority) => authority.id)).size !== authorizationAuthorities.length) {
    throw new Error('授权配置ID不能重复')
  }
  for (const authority of authorizationAuthorities) {
    assertNonEmpty(authority.id, '授权配置ID')
    assertNonEmpty(authority.actorId, '授权人')
    if (authority.kinds.length === 0) throw new Error('授权配置必须包含授权类型')
    assertNonNegativeMoney(authority.maxAmount, '授权额度')
    assertTimestamp(authority.validFrom)
    assertTimestamp(authority.validUntil)
    if (Date.parse(authority.validUntil) < Date.parse(authority.validFrom)) throw new Error('授权有效期不合法')
    authority.tableSessionIds?.forEach((tableSessionId) => assertNonEmpty(tableSessionId, '授权桌台会话ID'))
    authority.allowedSkuIds?.forEach((skuId) => assertNonEmpty(skuId, '授权商品ID'))
  }
  validateFulfillmentWorkstations(fulfillmentWorkstations)
  return {
    orders: [],
    authorizations: [],
    authorizationAuthorities: authorizationAuthorities.map((authority) => ({
      ...authority,
      kinds: [...authority.kinds],
      allowedSkuIds: authority.allowedSkuIds ? [...authority.allowedSkuIds] : null,
      tableSessionIds: authority.tableSessionIds ? [...authority.tableSessionIds] : null,
    })),
    fulfillmentWorkstations: fulfillmentWorkstations.map((workstation) => ({
      ...workstation,
      productionRoleIds: [...workstation.productionRoleIds],
      deliveryRoleIds: [...workstation.deliveryRoleIds],
      requiredSkillIds: [...workstation.requiredSkillIds],
    })),
    kdsTasks: [],
    tableLedgerEntries: [],
    idempotencyRecords: [],
  }
}

function assertNonEmpty(value: string, label: string) {
  if (value.trim().length === 0) throw new Error(`${label}不能为空`)
}

function assertTimestamp(value: string) {
  if (Number.isNaN(Date.parse(value))) throw new Error('时间必须是有效的ISO时间')
}

function assertNonNegativeMoney(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负安全整数`)
}

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}必须是正安全整数`)
}

function safeAdd(left: number, right: number, label: string) {
  const result = left + right
  if (!Number.isSafeInteger(result)) throw new Error(`${label}超出安全整数范围`)
  return result
}

function safeMultiply(left: number, right: number, label: string) {
  const result = left * right
  if (!Number.isSafeInteger(result)) throw new Error(`${label}超出安全整数范围`)
  return result
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`

  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'number':
      return JSON.stringify(value)
    case 'object': {
      const entries = Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`
    }
    default:
      throw new Error('幂等请求包含不支持的数据类型')
  }
}

function executeIdempotent<T>(
  state: OrderDomainState,
  key: string,
  operation: string,
  payload: unknown,
  resultType: IdempotencyResultType,
  resolve: (resultId: string) => T | undefined,
  execute: () => T,
  resultId: (result: T) => string,
) {
  normalizeOrderFulfillmentState(state)
  assertNonEmpty(key, '幂等键')
  const fingerprintPayload = typeof payload === 'object' && payload !== null
    ? Object.fromEntries(Object.entries(payload).filter(([field]) => field !== 'occurredAt'))
    : payload
  const fingerprint = canonicalize(fingerprintPayload)
  const existing = state.idempotencyRecords.find((record) => record.key === key)
  if (existing) {
    if (existing.operation !== operation || existing.fingerprint !== fingerprint) {
      throw new Error('幂等键已用于不同请求')
    }
    const result = resolve(existing.resultId)
    if (!result) throw new Error('幂等记录指向的领域对象不存在')
    return result
  }

  const result = execute()
  state.idempotencyRecords.push({
    key,
    operation,
    fingerprint,
    resultType,
    resultId: resultId(result),
  })
  return result
}

function findOrder(state: OrderDomainState, orderId: string) {
  const order = state.orders.find((item) => item.id === orderId)
  if (!order) throw new Error('订单不存在')
  return order
}

function findOrderItem(state: OrderDomainState, itemId: string) {
  for (const order of state.orders) {
    const item = order.items.find((candidate) => candidate.id === itemId)
    if (item) return item
  }
  return undefined
}

function calculateOrderAmounts(items: OrderItem[]): OrderAmounts {
  let grossAmount = 0
  let discountAmount = 0
  let giftAmount = 0
  let payableAmount = 0

  for (const item of items) {
    const gross = safeMultiply(item.unitListPriceAmount, item.quantity, '商品原价金额')
    const payable = safeMultiply(item.unitSalePriceAmount, item.quantity, '商品成交金额')
    const adjustment = gross - payable
    grossAmount = safeAdd(grossAmount, gross, '订单原价金额')
    payableAmount = safeAdd(payableAmount, payable, '订单应付金额')
    if (item.unitSalePriceAmount === 0 && item.unitListPriceAmount > 0) {
      giftAmount = safeAdd(giftAmount, adjustment, '订单赠送金额')
    } else {
      discountAmount = safeAdd(discountAmount, adjustment, '订单折扣金额')
    }
  }

  if (grossAmount - discountAmount - giftAmount !== payableAmount) {
    throw new Error('订单金额计算不一致')
  }
  return { grossAmount, discountAmount, giftAmount, payableAmount }
}

function requiredAuthorizationKind(item: OrderItem): AuthorizationKind | null {
  if (item.unitSalePriceAmount === item.unitListPriceAmount) return null
  return item.unitSalePriceAmount === 0 ? 'gift' : 'discount'
}

function requiredAuthorizationAmount(item: OrderItem) {
  return safeMultiply(item.unitListPriceAmount - item.unitSalePriceAmount, item.quantity, '授权金额')
}

export function createOrderDraft(state: OrderDomainState, command: CreateOrderDraftCommand) {
  assertNonEmpty(command.orderId, '订单ID')
  assertNonEmpty(command.tableSessionId, '桌台会话ID')
  assertNonEmpty(command.createdBy, '创建人')
  assertTimestamp(command.occurredAt)

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'order.create_draft.v1',
    command,
    'order',
    (id) => state.orders.find((order) => order.id === id),
    () => {
      if (state.orders.some((order) => order.id === command.orderId)) throw new Error('订单ID已存在')
      const order: Order = {
        id: command.orderId,
        tableSessionId: command.tableSessionId,
        status: 'draft',
        items: [],
        amounts: { grossAmount: 0, discountAmount: 0, giftAmount: 0, payableAmount: 0 },
        revision: 1,
        createdBy: command.createdBy,
        createdAt: command.occurredAt,
        submittedBy: null,
        submittedAt: null,
        fulfilledAt: null,
      }
      state.orders.push(order)
      return order
    },
    (order) => order.id,
  )
}

export function addOrderItem(state: OrderDomainState, command: AddOrderItemCommand) {
  assertNonEmpty(command.orderId, '订单ID')
  assertNonEmpty(command.item.id, '订单明细ID')
  assertNonEmpty(command.item.skuId, '商品ID')
  assertNonEmpty(command.item.name, '商品名称')
  assertNonEmpty(command.item.stationId, '出品口ID')
  assertNonEmpty(command.actorId, '操作人')
  assertTimestamp(command.occurredAt)
  assertPositiveInteger(command.item.quantity, '商品数量')
  assertPositiveInteger(command.item.configVersion, '配置版本')
  assertNonNegativeMoney(command.item.unitListPriceAmount, '商品原价')
  assertNonNegativeMoney(command.item.unitSalePriceAmount, '商品成交价')
  assertNonNegativeMoney(command.item.unitCostAmount, '商品成本')
  if (command.item.unitSalePriceAmount > command.item.unitListPriceAmount) {
    throw new Error('商品成交价不能高于原价')
  }
  resolveFulfillmentWorkstation(state, command.item.stationId)

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'order.add_item.v1',
    command,
    'order_item',
    (id) => findOrderItem(state, id),
    () => {
      const order = findOrder(state, command.orderId)
      if (order.status !== 'draft') throw new Error('只有草稿订单可以添加商品')
      if (findOrderItem(state, command.item.id)) throw new Error('订单明细ID已存在')

      const item: OrderItem = {
        ...command.item,
        fulfillmentStatus: 'draft',
        kdsTaskId: null,
        addedBy: command.actorId,
        addedAt: command.occurredAt,
      }
      const nextItems = [...order.items, item]
      const amounts = calculateOrderAmounts(nextItems)
      order.items = nextItems
      order.amounts = amounts
      order.revision += 1
      return item
    },
    (item) => item.id,
  )
}

export function requestOrderAuthorization(
  state: OrderDomainState,
  command: RequestOrderAuthorizationCommand,
) {
  assertNonEmpty(command.authorizationId, '授权ID')
  assertNonEmpty(command.orderId, '订单ID')
  assertNonEmpty(command.requestedBy, '授权申请人')
  assertTimestamp(command.occurredAt)
  if (command.lineIds.length === 0) throw new Error('授权必须包含商品明细')
  if (new Set(command.lineIds).size !== command.lineIds.length) throw new Error('授权商品明细不能重复')

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'order.request_authorization.v1',
    command,
    'authorization',
    (id) => state.authorizations.find((authorization) => authorization.id === id),
    () => {
      if (state.authorizations.some((authorization) => authorization.id === command.authorizationId)) {
        throw new Error('授权ID已存在')
      }
      const order = findOrder(state, command.orderId)
      if (!['draft', 'authorization_pending'].includes(order.status)) throw new Error('当前订单不能申请授权')

      const lines = command.lineIds.map((lineId) => {
        const line = order.items.find((item) => item.id === lineId)
        if (!line) throw new Error('授权商品明细不属于该订单')
        if (requiredAuthorizationKind(line) !== command.kind) throw new Error('授权类型与商品调整不匹配')
        return line
      })
      const hasActiveOverlap = state.authorizations.some(
        (authorization) =>
          authorization.orderId === order.id &&
          authorization.orderRevision === order.revision &&
          authorization.kind === command.kind &&
          authorization.status !== 'rejected' &&
          authorization.lineIds.some((lineId) => command.lineIds.includes(lineId)),
      )
      if (hasActiveOverlap) throw new Error('商品明细已有生效中的授权申请')

      const requestedAmount = lines.reduce(
        (total, item) => safeAdd(total, requiredAuthorizationAmount(item), '授权申请金额'),
        0,
      )
      const authorization: OrderAuthorization = {
        id: command.authorizationId,
        orderId: order.id,
        orderRevision: order.revision,
        kind: command.kind,
        lineIds: [...command.lineIds],
        requestedAmount,
        status: 'pending',
        requestedBy: command.requestedBy,
        requestedAt: command.occurredAt,
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
      }
      state.authorizations.push(authorization)
      order.status = 'authorization_pending'
      return authorization
    },
    (authorization) => authorization.id,
  )
}

export function decideOrderAuthorization(
  state: OrderDomainState,
  command: DecideOrderAuthorizationCommand,
) {
  assertNonEmpty(command.authorizationId, '授权ID')
  assertNonEmpty(command.decidedBy, '授权审批人')
  assertTimestamp(command.occurredAt)
  if (command.decision === 'rejected') assertNonEmpty(command.reason, '拒绝原因')

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'order.decide_authorization.v1',
    command,
    'authorization',
    (id) => state.authorizations.find((authorization) => authorization.id === id),
    () => {
      const authorization = state.authorizations.find((item) => item.id === command.authorizationId)
      if (!authorization) throw new Error('授权申请不存在')
      if (authorization.status !== 'pending') throw new Error('授权申请已经处理')
      if (Date.parse(command.occurredAt) < Date.parse(authorization.requestedAt)) {
        throw new Error('授权时间不能早于申请时间')
      }
      const order = findOrder(state, authorization.orderId)
      const authorizationItems = order.items.filter((item) => authorization.lineIds.includes(item.id))
      const occurredAt = Date.parse(command.occurredAt)
      const authority = state.authorizationAuthorities.find(
        (candidate) =>
          candidate.actorId === command.decidedBy &&
          candidate.kinds.includes(authorization.kind) &&
          candidate.maxAmount >= authorization.requestedAmount &&
          (candidate.allowedSkuIds == null || authorizationItems.every((item) => candidate.allowedSkuIds?.includes(item.skuId))) &&
          (candidate.tableSessionIds === null || candidate.tableSessionIds.includes(order.tableSessionId)) &&
          occurredAt >= Date.parse(candidate.validFrom) &&
          occurredAt <= Date.parse(candidate.validUntil),
      )
      if (!authority) throw new Error('审批人没有该授权额度或授权已失效')
      authorization.status = command.decision
      authorization.decidedBy = command.decidedBy
      authorization.decidedAt = command.occurredAt
      authorization.decisionReason = command.reason.trim() || null
      return authorization
    },
    (authorization) => authorization.id,
  )
}

function hasGrantedAuthorization(
  state: OrderDomainState,
  order: Order,
  item: OrderItem,
  kind: AuthorizationKind,
) {
  return state.authorizations.some(
    (authorization) =>
      authorization.orderId === order.id &&
      authorization.orderRevision === order.revision &&
      authorization.kind === kind &&
      authorization.status === 'granted' &&
      authorization.lineIds.includes(item.id),
  )
}

function ledgerEntryId(orderId: string, type: TableLedgerEntryType) {
  return `ledger:${orderId}:${type}`
}

function kdsTaskId(orderId: string, itemId: string) {
  return `kds:${orderId}:${itemId}`
}

function isoAfter(value: string, seconds: number) {
  return new Date(Date.parse(value) + seconds * 1000).toISOString()
}

function buildLedgerEntries(state: OrderDomainState, order: Order, actorId: string, occurredAt: string) {
  const drafts: Array<{ type: TableLedgerEntryType; amount: number; lineIds: string[] }> = [
    {
      type: 'order_gross_charge',
      amount: order.amounts.grossAmount,
      lineIds: order.items.map((item) => item.id),
    },
  ]
  const discountedLineIds = order.items
    .filter((item) => requiredAuthorizationKind(item) === 'discount')
    .map((item) => item.id)
  const giftedLineIds = order.items
    .filter((item) => requiredAuthorizationKind(item) === 'gift')
    .map((item) => item.id)
  if (order.amounts.discountAmount > 0) {
    drafts.push({ type: 'order_discount', amount: -order.amounts.discountAmount, lineIds: discountedLineIds })
  }
  if (order.amounts.giftAmount > 0) {
    drafts.push({ type: 'order_gift', amount: -order.amounts.giftAmount, lineIds: giftedLineIds })
  }

  let balance = getTableBalance(state, order.tableSessionId)
  let sequence = state.tableLedgerEntries.filter((entry) => entry.tableSessionId === order.tableSessionId).length
  return drafts.map((draft): TableLedgerEntry => {
    balance = safeAdd(balance, draft.amount, '桌账余额')
    sequence += 1
    return {
      id: ledgerEntryId(order.id, draft.type),
      tableSessionId: order.tableSessionId,
      orderId: order.id,
      type: draft.type,
      amount: draft.amount,
      balanceAfter: balance,
      sequence,
      actorId,
      occurredAt,
      lineIds: draft.lineIds,
    }
  })
}

export function submitOrder(state: OrderDomainState, command: SubmitOrderCommand) {
  assertNonEmpty(command.orderId, '订单ID')
  assertNonEmpty(command.submittedBy, '提交人')
  assertTimestamp(command.occurredAt)

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'order.submit.v1',
    command,
    'order',
    (id) => state.orders.find((order) => order.id === id),
    () => {
      const order = findOrder(state, command.orderId)
      if (!['draft', 'authorization_pending'].includes(order.status)) throw new Error('当前订单不能提交')
      if (order.items.length === 0) throw new Error('空订单不能提交')
      if (Date.parse(command.occurredAt) < Date.parse(order.createdAt)) throw new Error('提交时间不能早于创建时间')

      const uncoveredItems = order.items.filter((item) => {
        const kind = requiredAuthorizationKind(item)
        return kind !== null && !hasGrantedAuthorization(state, order, item, kind)
      })
      if (uncoveredItems.length > 0) {
        const hasPending = state.authorizations.some(
          (authorization) =>
            authorization.orderId === order.id &&
            authorization.orderRevision === order.revision &&
            authorization.status === 'pending' &&
            authorization.lineIds.some((lineId) => uncoveredItems.some((item) => item.id === lineId)),
        )
        throw new Error(hasPending ? '订单授权尚未完成' : '订单缺少折扣或赠送授权')
      }

      const tasks = order.items.map((item): KdsTask => {
        const workstation = resolveFulfillmentWorkstation(state, item.stationId)
        return {
          id: kdsTaskId(order.id, item.id),
          orderId: order.id,
          orderItemId: item.id,
          tableSessionId: order.tableSessionId,
          stationId: workstation.id,
          itemName: item.name,
          specification: item.specification,
          quantity: item.quantity,
          status: 'queued',
          workstation,
          productionSla: {
            targetSeconds: workstation.productionSlaSeconds,
            dueAt: isoAfter(command.occurredAt, workstation.productionSlaSeconds),
          },
          pickupSla: { targetSeconds: workstation.pickupSlaSeconds, dueAt: null },
          deliveryServiceTask: null,
          queuedAt: command.occurredAt,
          startedAt: null,
          startedBy: null,
          completedAt: null,
          completedBy: null,
          pickedUpAt: null,
          pickedUpBy: null,
          deliveredAt: null,
          deliveredBy: null,
        }
      })
      if (tasks.some((task) => state.kdsTasks.some((existing) => existing.id === task.id))) {
        throw new Error('KDS任务ID已存在')
      }

      const ledgerEntries = buildLedgerEntries(state, order, command.submittedBy, command.occurredAt)
      if (ledgerEntries.some((entry) => state.tableLedgerEntries.some((existing) => existing.id === entry.id))) {
        throw new Error('桌账流水ID已存在')
      }

      for (const item of order.items) {
        item.fulfillmentStatus = 'queued'
        item.kdsTaskId = kdsTaskId(order.id, item.id)
      }
      order.status = 'submitted'
      order.submittedBy = command.submittedBy
      order.submittedAt = command.occurredAt
      state.kdsTasks.push(...tasks)
      state.tableLedgerEntries.push(...ledgerEntries)
      return order
    },
    (order) => order.id,
  )
}

function syncOrderFulfillment(order: Order, occurredAt: string) {
  if (order.items.every((item) => item.fulfillmentStatus === 'delivered')) {
    order.status = 'fulfilled'
    order.fulfilledAt = occurredAt
    return
  }
  if (order.items.some((item) => item.fulfillmentStatus !== 'queued')) {
    order.status = 'in_fulfillment'
  }
}

function applyKdsTransition(
  state: OrderDomainState,
  command: KdsTaskActionCommand,
  operation: string,
  expectedStatus: KdsTaskStatus,
  nextStatus: KdsTaskStatus,
  previousAt: (task: KdsTask) => string | null,
  update: (task: KdsTask) => void,
) {
  assertNonEmpty(command.taskId, 'KDS任务ID')
  assertNonEmpty(command.actorId, '操作人')
  assertTimestamp(command.occurredAt)

  return executeIdempotent(
    state,
    command.idempotencyKey,
    operation,
    command,
    'kds_task',
    (id) => state.kdsTasks.find((task) => task.id === id),
    () => {
      const task = state.kdsTasks.find((item) => item.id === command.taskId)
      if (!task) throw new Error('KDS任务不存在')
      if (task.status !== expectedStatus) throw new Error(`KDS任务不能从${task.status}跳转到${nextStatus}`)
      const priorTimestamp = previousAt(task)
      if (!priorTimestamp) throw new Error('KDS任务缺少前序时间')
      if (Date.parse(command.occurredAt) < Date.parse(priorTimestamp)) throw new Error('KDS操作时间早于前序操作')

      const order = findOrder(state, task.orderId)
      const item = order.items.find((candidate) => candidate.id === task.orderItemId)
      if (!item || item.kdsTaskId !== task.id) throw new Error('KDS任务与订单明细不一致')

      task.status = nextStatus
      update(task)
      item.fulfillmentStatus = nextStatus
      syncOrderFulfillment(order, command.occurredAt)
      return task
    },
    (task) => task.id,
  )
}

export function startKdsTask(state: OrderDomainState, command: KdsTaskActionCommand) {
  return applyKdsTransition(
    state,
    command,
    'kds.start.v1',
    'queued',
    'preparing',
    (task) => task.queuedAt,
    (task) => {
      task.startedAt = command.occurredAt
      task.startedBy = command.actorId
    },
  )
}

export function completeKdsTask(state: OrderDomainState, command: KdsTaskActionCommand) {
  return applyKdsTransition(
    state,
    command,
    'kds.complete.v1',
    'preparing',
    'completed',
    (task) => task.startedAt,
    (task) => {
      task.completedAt = command.occurredAt
      task.completedBy = command.actorId
      const pickupSlaSeconds = task.pickupSla?.targetSeconds ?? task.workstation?.pickupSlaSeconds
      if (pickupSlaSeconds) {
        task.pickupSla = {
          targetSeconds: pickupSlaSeconds,
          dueAt: isoAfter(command.occurredAt, pickupSlaSeconds),
        }
      }
    },
  )
}

export function pickUpKdsTask(state: OrderDomainState, command: KdsTaskActionCommand) {
  return applyKdsTransition(
    state,
    command,
    'kds.pick_up.v1',
    'completed',
    'picked_up',
    (task) => task.completedAt,
    (task) => {
      task.pickedUpAt = command.occurredAt
      task.pickedUpBy = command.actorId
    },
  )
}

export function deliverKdsTask(state: OrderDomainState, command: KdsTaskActionCommand) {
  return applyKdsTransition(
    state,
    command,
    'kds.deliver.v1',
    'picked_up',
    'delivered',
    (task) => task.pickedUpAt,
    (task) => {
      task.deliveredAt = command.occurredAt
      task.deliveredBy = command.actorId
    },
  )
}

export function getTableBalance(state: OrderDomainState, tableSessionId: string) {
  normalizeOrderFulfillmentState(state)
  assertNonEmpty(tableSessionId, '桌台会话ID')
  return state.tableLedgerEntries
    .filter((entry) => entry.tableSessionId === tableSessionId)
    .reduce((balance, entry) => safeAdd(balance, entry.amount, '桌账余额'), 0)
}

export function getTableAccountSummary(
  state: OrderDomainState,
  tableSessionId: string,
): TableAccountSummary {
  const entries = state.tableLedgerEntries
    .filter((entry) => entry.tableSessionId === tableSessionId)
    .sort((left, right) => left.sequence - right.sequence)
    .map((entry) => ({ ...entry, lineIds: [...entry.lineIds] }))
  return { tableSessionId, balance: getTableBalance(state, tableSessionId), entries }
}
