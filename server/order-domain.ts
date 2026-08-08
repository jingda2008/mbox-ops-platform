import type {
  AddOrderItemCommand,
  AuthorizationKind,
  CreateOrderDraftCommand,
  DecideKdsExceptionCommand,
  DecideOrderAuthorizationCommand,
  FulfillmentWorkstationConfig,
  IdempotencyRecord,
  KdsExceptionEvent,
  KdsExceptionKind,
  KdsExceptionReasonCode,
  KdsTask,
  KdsTaskActionCommand,
  KdsTaskStatus,
  Order,
  OrderAmounts,
  OrderAuthorization,
  OrderAuthorizationAuthority,
  OrderDomainState,
  OrderItem,
  ProductFulfillmentType,
  ReportKdsExceptionCommand,
  RequestOrderAuthorizationCommand,
  SubmitOrderCommand,
  TableAccountSummary,
  TableLedgerEntry,
  TableLedgerEntryType,
} from '../src/shared/order-contracts.js'
import { BusinessRuleError } from './business-rule-error.js'
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
    authority.allowedCategoryIds?.forEach((categoryId) => assertNonEmpty(categoryId, '授权商品分类ID'))
    for (const [value, label] of [
      [authority.maxPerTableAmount, '单桌累计赠送额度'],
      [authority.maxPerShiftAmount, '班次累计赠送额度'],
      [authority.maxPerBusinessDayAmount, '营业日累计赠送额度'],
      [authority.maxPerMonthAmount, '月度累计赠送额度'],
    ] as const) {
      if (value != null) assertNonNegativeMoney(value, label)
    }
    if (authority.maxPerBusinessDayCount != null && (!Number.isSafeInteger(authority.maxPerBusinessDayCount) || authority.maxPerBusinessDayCount < 1)) {
      throw new Error('营业日赠送次数必须为正整数')
    }
    if (authority.maxQuantityPerOrder != null && (!Number.isSafeInteger(authority.maxQuantityPerOrder) || authority.maxQuantityPerOrder < 1)) {
      throw new Error('单次赠送数量必须为正整数')
    }
  }
  validateFulfillmentWorkstations(fulfillmentWorkstations)
  return {
    orders: [],
    authorizations: [],
    authorizationAuthorities: authorizationAuthorities.map((authority) => ({
      ...authority,
      kinds: [...authority.kinds],
      allowedSkuIds: authority.allowedSkuIds ? [...authority.allowedSkuIds] : null,
      allowedCategoryIds: authority.allowedCategoryIds ? [...authority.allowedCategoryIds] : null,
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

function normalizeFulfillmentNote(value = '') {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (normalized.length > 300) throw new Error('订单备注不能超过300字')
  return normalized
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

const fulfillmentTypes = new Set<ProductFulfillmentType>([
  'ready_to_serve',
  'made_to_order',
  'service_only',
  'no_fulfillment',
])

function fulfillmentTypeOf(item: {
  fulfillmentType?: ProductFulfillmentType
  requiresFulfillment?: boolean
}): ProductFulfillmentType {
  return item.fulfillmentType ?? (item.requiresFulfillment === false ? 'no_fulfillment' : 'made_to_order')
}

function requiresKdsTask(item: {
  fulfillmentType?: ProductFulfillmentType
  requiresFulfillment?: boolean
}) {
  return fulfillmentTypeOf(item) !== 'no_fulfillment'
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

function idempotencyFingerprint(payload: unknown) {
  const fingerprintPayload = typeof payload === 'object' && payload !== null
    ? Object.fromEntries(Object.entries(payload).filter(([field]) => field !== 'occurredAt'))
    : payload
  return canonicalize(fingerprintPayload)
}

function resolveIdempotencyReplay<T>(
  state: OrderDomainState,
  key: string,
  operation: string,
  payload: unknown,
  resolve: (resultId: string) => T | undefined,
): { replayed: false; fingerprint: string } | { replayed: true; result: T } {
  assertNonEmpty(key, '幂等键')
  const fingerprint = idempotencyFingerprint(payload)
  const existing = state.idempotencyRecords.find((record) => record.key === key)
  if (!existing) return { replayed: false, fingerprint }
  if (existing.operation !== operation || existing.fingerprint !== fingerprint) {
    throw new Error('幂等键已用于不同请求')
  }
  const result = resolve(existing.resultId)
  if (!result) throw new Error('幂等记录指向的领域对象不存在')
  return { replayed: true, result }
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
  const replay = resolveIdempotencyReplay(state, key, operation, payload, resolve)
  if (replay.replayed) return replay.result

  const result = execute()
  state.idempotencyRecords.push({
    key,
    operation,
    fingerprint: replay.fingerprint,
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

function findKdsExceptionEvent(state: OrderDomainState, eventId: string) {
  for (const task of state.kdsTasks) {
    const event = task.exceptionEvents?.find((candidate) => candidate.id === eventId)
    if (event) return event
  }
  return undefined
}

function findKdsExceptionReport(state: OrderDomainState, exceptionId: string) {
  for (const task of state.kdsTasks) {
    const event = task.exceptionEvents?.find((candidate) => (
      candidate.exceptionId === exceptionId && candidate.type === 'reported'
    ))
    if (event) return { task, event }
  }
  return undefined
}

function exceptionDisposition(task: KdsTask, exceptionId: string) {
  return task.exceptionEvents?.find((event) => (
    event.exceptionId === exceptionId && event.type === 'manager_disposition'
  ))
}

function taskBlockingException(task: KdsTask) {
  const reports = task.exceptionEvents?.filter((event) => event.type === 'reported') ?? []
  return reports.find((report) => !exceptionDisposition(task, report.exceptionId))
    ?? reports.find((report) => exceptionDisposition(task, report.exceptionId))
}

function calculateOrderAmounts(items: OrderItem[]): OrderAmounts {
  let grossAmount = 0
  let discountAmount = 0
  let giftAmount = 0
  let payableAmount = 0

  for (const item of items) {
    if (item.commercialLine === false) continue
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
  if (item.commercialLine === false) return null
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
  const fulfillmentNote = normalizeFulfillmentNote(command.fulfillmentNote)

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
        fulfillmentNote,
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
  if (command.item.fulfillmentType !== undefined && !fulfillmentTypes.has(command.item.fulfillmentType)) {
    throw new Error('商品履约类型不受支持')
  }
  const fulfillmentType = fulfillmentTypeOf(command.item)
  if (
    command.item.requiresFulfillment !== undefined
    && command.item.requiresFulfillment !== (fulfillmentType !== 'no_fulfillment')
  ) {
    throw new Error('商品履约类型与旧版履约开关冲突')
  }
  if (fulfillmentType !== 'no_fulfillment') {
    resolveFulfillmentWorkstation(state, command.item.stationId)
  }

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
        requiresFulfillment: fulfillmentType !== 'no_fulfillment',
        fulfillmentType,
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
          (
            candidate.allowedCategoryIds != null
            || candidate.allowedSkuIds == null
            || authorizationItems.every((item) => candidate.allowedSkuIds?.includes(item.skuId))
          ) &&
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

function initialKdsProgress(
  fulfillmentType: ProductFulfillmentType,
  workstation: FulfillmentWorkstationConfig,
  occurredAt: string,
  actorId: string,
): Pick<
  KdsTask,
  | 'status'
  | 'productionSla'
  | 'pickupSla'
  | 'startedAt'
  | 'startedBy'
  | 'completedAt'
  | 'completedBy'
  | 'pickedUpAt'
  | 'pickedUpBy'
  | 'deliveredAt'
  | 'deliveredBy'
> {
  const untouched = {
    startedAt: null,
    startedBy: null,
    deliveredAt: null,
    deliveredBy: null,
  }
  if (fulfillmentType === 'ready_to_serve') {
    return {
      ...untouched,
      status: 'completed',
      productionSla: undefined,
      pickupSla: {
        targetSeconds: workstation.pickupSlaSeconds,
        dueAt: isoAfter(occurredAt, workstation.pickupSlaSeconds),
      },
      completedAt: occurredAt,
      completedBy: actorId,
      pickedUpAt: null,
      pickedUpBy: null,
    }
  }
  if (fulfillmentType === 'service_only') {
    return {
      ...untouched,
      status: 'picked_up',
      productionSla: undefined,
      pickupSla: {
        targetSeconds: workstation.pickupSlaSeconds,
        dueAt: isoAfter(occurredAt, workstation.pickupSlaSeconds),
      },
      completedAt: occurredAt,
      completedBy: actorId,
      pickedUpAt: occurredAt,
      pickedUpBy: actorId,
    }
  }
  return {
    ...untouched,
    status: 'queued',
    productionSla: {
      targetSeconds: workstation.productionSlaSeconds,
      dueAt: isoAfter(occurredAt, workstation.productionSlaSeconds),
    },
    pickupSla: { targetSeconds: workstation.pickupSlaSeconds, dueAt: null },
    completedAt: null,
    completedBy: null,
    pickedUpAt: null,
    pickedUpBy: null,
  }
}

function buildLedgerEntries(state: OrderDomainState, order: Order, actorId: string, occurredAt: string) {
  const drafts: Array<{ type: TableLedgerEntryType; amount: number; lineIds: string[] }> = [
    {
      type: 'order_gross_charge',
      amount: order.amounts.grossAmount,
      lineIds: order.items.filter((item) => item.commercialLine !== false).map((item) => item.id),
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

      const fulfillmentItems = order.items.filter(requiresKdsTask)
      const tasks = fulfillmentItems.map((item): KdsTask => {
        const workstation = resolveFulfillmentWorkstation(state, item.stationId)
        const fulfillmentType = fulfillmentTypeOf(item)
        return {
          id: kdsTaskId(order.id, item.id),
          orderId: order.id,
          orderItemId: item.id,
          tableSessionId: order.tableSessionId,
          stationId: workstation.id,
          itemName: item.name,
          specification: item.specification,
          quantity: item.quantity,
          fulfillmentType,
          fulfillmentNote: order.fulfillmentNote ?? '',
          workstation,
          deliveryServiceTask: null,
          remakeOf: null,
          exceptionEvents: [],
          queuedAt: command.occurredAt,
          ...initialKdsProgress(fulfillmentType, workstation, command.occurredAt, command.submittedBy),
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
        if (!requiresKdsTask(item)) {
          item.fulfillmentStatus = 'delivered'
          item.kdsTaskId = null
        } else {
          const task = tasks.find((candidate) => candidate.orderItemId === item.id)
          if (!task) throw new Error('订单明细缺少KDS任务')
          item.fulfillmentStatus = task.status
          item.kdsTaskId = task.id
        }
      }
      order.status = tasks.length === 0
        ? 'fulfilled'
        : tasks.some((task) => task.status !== 'queued') ? 'in_fulfillment' : 'submitted'
      order.submittedBy = command.submittedBy
      order.submittedAt = command.occurredAt
      order.fulfilledAt = tasks.length === 0 ? command.occurredAt : null
      state.kdsTasks.push(...tasks)
      state.tableLedgerEntries.push(...ledgerEntries)
      return order
    },
    (order) => order.id,
  )
}

function effectiveKdsOutcome(state: OrderDomainState, item: OrderItem) {
  let task = item.kdsTaskId ? state.kdsTasks.find((candidate) => candidate.id === item.kdsTaskId) : undefined
  const visited = new Set<string>()

  while (task && !visited.has(task.id)) {
    visited.add(task.id)
    const report = task.exceptionEvents?.find((event) => event.type === 'reported')
    if (!report) return { task, cancelled: false, pendingException: false }
    const disposition = exceptionDisposition(task, report.exceptionId)
    if (!disposition) return { task, cancelled: false, pendingException: true }
    if (disposition.managerDisposition === 'cancelled') {
      return { task, cancelled: true, pendingException: false }
    }
    task = disposition.remakeKdsTaskId
      ? state.kdsTasks.find((candidate) => candidate.id === disposition.remakeKdsTaskId)
      : undefined
  }

  return { task, cancelled: false, pendingException: true }
}

function syncOrderFulfillment(state: OrderDomainState, order: Order, occurredAt: string) {
  const outcomes = order.items
    .filter(requiresKdsTask)
    .map((item) => effectiveKdsOutcome(state, item))
  const allClosed = outcomes.every((outcome) => (
    outcome.cancelled || (!outcome.pendingException && outcome.task?.status === 'delivered')
  ))
  if (allClosed) {
    order.status = 'fulfilled'
    order.fulfilledAt = occurredAt
    return
  }

  order.fulfilledAt = null
  const started = outcomes.some((outcome) => (
    outcome.pendingException || outcome.task?.remakeOf != null || (outcome.task && outcome.task.status !== 'queued')
  ))
  if (started) {
    order.status = 'in_fulfillment'
  } else if (['submitted', 'in_fulfillment', 'fulfilled'].includes(order.status)) {
    order.status = 'submitted'
  }
}

const exceptionReasonCodesByKind: Record<KdsExceptionKind, ReadonlySet<KdsExceptionReasonCode>> = {
  shortage: new Set(['product_out_of_stock', 'ingredient_out_of_stock', 'equipment_unavailable', 'other']),
  production_rejection: new Set(['equipment_unavailable', 'quality_rejected', 'damaged', 'other']),
  wrong_item: new Set(['wrong_product', 'wrong_specification', 'quality_rejected', 'damaged', 'other']),
}

function assertExceptionCanBeReported(task: KdsTask, exceptionKind: KdsExceptionKind) {
  if (taskBlockingException(task)) throw new Error('该KDS任务已有异常记录，不能重复报告')
  if (exceptionKind === 'wrong_item') {
    if (!['preparing', 'completed', 'picked_up', 'delivered'].includes(task.status)) {
      throw new Error('当前KDS状态不能报告错品')
    }
    return
  }
  const canReportReadyShortage = task.fulfillmentType === 'ready_to_serve'
    && exceptionKind === 'shortage'
    && task.status === 'completed'
  if (!canReportReadyShortage && !['queued', 'preparing'].includes(task.status)) {
    throw new Error('当前KDS状态不能拒绝出品')
  }
}

export function reportKdsException(state: OrderDomainState, command: ReportKdsExceptionCommand) {
  assertNonEmpty(command.exceptionId, '异常ID')
  assertNonEmpty(command.eventId, '异常事件ID')
  assertNonEmpty(command.taskId, 'KDS任务ID')
  assertNonEmpty(command.actorId, '操作人')
  assertNonEmpty(command.actorRoleId, '操作岗位')
  assertTimestamp(command.occurredAt)
  if (!exceptionReasonCodesByKind[command.exceptionKind].has(command.reasonCode)) {
    throw new Error('异常类型与原因不匹配')
  }
  if (command.reasonCode === 'other') assertNonEmpty(command.reasonNote, '其他原因说明')

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'kds.exception.report.v1',
    command,
    'kds_exception_event',
    (id) => findKdsExceptionEvent(state, id),
    () => {
      const task = state.kdsTasks.find((candidate) => candidate.id === command.taskId)
      if (!task) throw new Error('KDS任务不存在')
      assertExceptionCanBeReported(task, command.exceptionKind)
      if (Date.parse(command.occurredAt) < Date.parse(task.queuedAt)) throw new Error('异常时间不能早于KDS排队时间')
      if (findKdsExceptionReport(state, command.exceptionId)) throw new Error('异常ID已存在')
      if (findKdsExceptionEvent(state, command.eventId)) throw new Error('异常事件ID已存在')

      const order = findOrder(state, task.orderId)
      const item = order.items.find((candidate) => candidate.id === task.orderItemId)
      const originalOrderItemId = task.remakeOf?.orderItemId ?? task.orderItemId
      const originalKdsTaskId = task.remakeOf?.kdsTaskId ?? task.id
      if (!item || item.id !== originalOrderItemId || item.kdsTaskId !== originalKdsTaskId) {
        throw new Error('KDS任务与原订单明细不一致')
      }

      const event: KdsExceptionEvent = {
        id: command.eventId,
        exceptionId: command.exceptionId,
        type: 'reported',
        exceptionKind: command.exceptionKind,
        reasonCode: command.reasonCode,
        reasonNote: command.reasonNote.trim() || null,
        orderId: task.orderId,
        orderItemId: task.orderItemId,
        kdsTaskId: task.id,
        originalOrderItemId,
        originalKdsTaskId,
        actorId: command.actorId,
        actorRoleId: command.actorRoleId,
        occurredAt: command.occurredAt,
        managerDisposition: null,
        remakeKdsTaskId: null,
      }
      task.exceptionEvents ??= []
      task.exceptionEvents.push(event)
      syncOrderFulfillment(state, order, command.occurredAt)
      return event
    },
    (event) => event.id,
  )
}

function cloneWorkstationSnapshot(workstation: FulfillmentWorkstationConfig): FulfillmentWorkstationConfig {
  return {
    ...workstation,
    productionRoleIds: [...workstation.productionRoleIds],
    deliveryRoleIds: [...workstation.deliveryRoleIds],
    requiredSkillIds: [...workstation.requiredSkillIds],
  }
}

export function decideKdsException(state: OrderDomainState, command: DecideKdsExceptionCommand) {
  assertNonEmpty(command.eventId, '处置事件ID')
  assertNonEmpty(command.exceptionId, '异常ID')
  assertNonEmpty(command.actorId, '处置人')
  assertNonEmpty(command.actorRoleId, '处置岗位')
  assertTimestamp(command.occurredAt)
  if (!['supervisor', 'manager', 'operations_director', 'owner'].includes(command.actorRoleId)) {
    throw new Error('只有领班、店长、运营负责人或老板可以处置KDS异常')
  }
  const allowedReasonCodes = command.disposition === 'cancelled'
    ? ['unavailable_confirmed', 'guest_cancelled', 'manager_cancelled', 'other']
    : ['service_recovery', 'quality_recovery', 'other']
  if (!allowedReasonCodes.includes(command.reasonCode)) throw new Error('经理处置与原因不匹配')
  if (command.reasonCode === 'other') assertNonEmpty(command.reasonNote, '其他处置原因说明')
  if (command.disposition === 'remake' && !command.remakeTaskId) throw new Error('补做必须提供新KDS任务ID')
  if (command.disposition === 'cancelled' && command.remakeTaskId) throw new Error('取消处置不能创建补做任务')

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'kds.exception.decide.v1',
    command,
    'kds_exception_event',
    (id) => findKdsExceptionEvent(state, id),
    () => {
      const reported = findKdsExceptionReport(state, command.exceptionId)
      if (!reported) throw new Error('KDS异常不存在')
      const { task, event: report } = reported
      if (exceptionDisposition(task, command.exceptionId)) throw new Error('KDS异常已经处置')
      if (Date.parse(command.occurredAt) < Date.parse(report.occurredAt)) throw new Error('处置时间不能早于异常报告时间')
      if (findKdsExceptionEvent(state, command.eventId)) throw new Error('处置事件ID已存在')

      const order = findOrder(state, task.orderId)
      const item = order.items.find((candidate) => candidate.id === report.originalOrderItemId)
      if (!item || item.kdsTaskId !== report.originalKdsTaskId) throw new Error('异常与原订单明细不一致')

      let remakeTask: KdsTask | null = null
      if (command.disposition === 'remake') {
        if (state.kdsTasks.some((candidate) => candidate.id === command.remakeTaskId)) throw new Error('补做KDS任务ID已存在')
        const workstation = cloneWorkstationSnapshot(task.workstation ?? resolveFulfillmentWorkstation(state, task.stationId))
        const attempt = state.kdsTasks.filter((candidate) => (
          candidate.remakeOf?.kdsTaskId === report.originalKdsTaskId
        )).length + 1
        const fulfillmentType = task.fulfillmentType ?? fulfillmentTypeOf(item)
        remakeTask = {
          id: command.remakeTaskId!,
          orderId: task.orderId,
          orderItemId: report.originalOrderItemId,
          tableSessionId: task.tableSessionId,
          ...(task.tableCode === undefined ? {} : { tableCode: task.tableCode }),
          stationId: task.stationId,
          itemName: task.itemName,
          specification: task.specification,
          quantity: task.quantity,
          fulfillmentType,
          workstation,
          deliveryServiceTask: null,
          remakeOf: {
            orderItemId: report.originalOrderItemId,
            kdsTaskId: report.originalKdsTaskId,
            exceptionId: report.exceptionId,
            attempt,
          },
          exceptionEvents: [],
          queuedAt: command.occurredAt,
          ...initialKdsProgress(fulfillmentType, workstation, command.occurredAt, command.actorId),
        }
      }

      const dispositionEvent: KdsExceptionEvent = {
        id: command.eventId,
        exceptionId: command.exceptionId,
        type: 'manager_disposition',
        exceptionKind: report.exceptionKind,
        reasonCode: command.reasonCode,
        reasonNote: command.reasonNote.trim() || null,
        orderId: report.orderId,
        orderItemId: report.orderItemId,
        kdsTaskId: report.kdsTaskId,
        originalOrderItemId: report.originalOrderItemId,
        originalKdsTaskId: report.originalKdsTaskId,
        actorId: command.actorId,
        actorRoleId: command.actorRoleId,
        occurredAt: command.occurredAt,
        managerDisposition: command.disposition,
        remakeKdsTaskId: remakeTask?.id ?? null,
      }
      task.exceptionEvents ??= []
      task.exceptionEvents.push(dispositionEvent)
      if (remakeTask) {
        state.kdsTasks.push(remakeTask)
        item.fulfillmentStatus = remakeTask.status
      }
      syncOrderFulfillment(state, order, command.occurredAt)
      return dispositionEvent
    },
    (event) => event.id,
  )
}

function applyKdsTransition(
  state: OrderDomainState,
  command: KdsTaskActionCommand,
  operation: string,
  expectedStatus: KdsTaskStatus | readonly KdsTaskStatus[],
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
      const rank: Partial<Record<KdsTaskStatus, number>> = {
        queued: 0,
        preparing: 1,
        completed: 2,
        picked_up: 3,
        delivered: 4,
      }
      if ((rank[task.status] ?? -1) >= (rank[nextStatus] ?? Number.MAX_SAFE_INTEGER)) return task
      const blockingException = taskBlockingException(task)
      if (blockingException) {
        const disposition = exceptionDisposition(task, blockingException.exceptionId)
        throw new Error(disposition ? '原KDS任务已由异常处置关闭' : 'KDS异常待领班或经理处置')
      }
      const expectedStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus]
      if (!expectedStatuses.includes(task.status)) {
        throw new BusinessRuleError(`KDS任务不能从${task.status}跳转到${nextStatus}`, 'KDS_STATE_CONFLICT')
      }
      const priorTimestamp = previousAt(task)
      if (!priorTimestamp) throw new Error('KDS任务缺少前序时间')
      if (Date.parse(command.occurredAt) < Date.parse(priorTimestamp)) throw new Error('KDS操作时间早于前序操作')

      const order = findOrder(state, task.orderId)
      const item = order.items.find((candidate) => candidate.id === task.orderItemId)
      const linkedToOriginal = item?.kdsTaskId === task.id
      const linkedAsRemake = item != null
        && task.remakeOf?.orderItemId === item.id
        && task.remakeOf.kdsTaskId === item.kdsTaskId
      if (!item || (!linkedToOriginal && !linkedAsRemake)) throw new Error('KDS任务与订单明细不一致')

      task.status = nextStatus
      update(task)
      item.fulfillmentStatus = nextStatus
      syncOrderFulfillment(state, order, command.occurredAt)
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
    ['queued', 'preparing'],
    'completed',
    (task) => task.startedAt ?? task.queuedAt,
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

export function completeAndDeliverKdsTask(state: OrderDomainState, command: KdsTaskActionCommand) {
  assertNonEmpty(command.taskId, 'KDS任务ID')
  assertNonEmpty(command.actorId, '操作人')
  assertTimestamp(command.occurredAt)
  normalizeOrderFulfillmentState(state)
  const replay = resolveIdempotencyReplay(
    state,
    command.idempotencyKey,
    'kds.complete_and_deliver.v1',
    command,
    (id) => state.kdsTasks.find((task) => task.id === id),
  )
  if (replay.replayed) return replay.result
  const currentTask = state.kdsTasks.find((candidate) => candidate.id === command.taskId)
  if (!currentTask) throw new Error('KDS任务不存在')
  if (currentTask.status === 'delivered') return currentTask

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'kds.complete_and_deliver.v1',
    command,
    'kds_task',
    (id) => state.kdsTasks.find((task) => task.id === id),
    () => {
      const task = state.kdsTasks.find((candidate) => candidate.id === command.taskId)
      if (!task) throw new Error('KDS任务不存在')
      const blockingException = taskBlockingException(task)
      if (blockingException) {
        const disposition = exceptionDisposition(task, blockingException.exceptionId)
        throw new Error(disposition ? '原KDS任务已由异常处置关闭' : 'KDS异常待领班或经理处置')
      }
      if ((task.fulfillmentType ?? 'made_to_order') !== 'made_to_order') {
        throw new Error('只有现制商品可以完成并送达')
      }
      if (task.status !== 'preparing') {
        throw new BusinessRuleError(`KDS任务不能从${task.status}完成并送达`, 'KDS_STATE_CONFLICT')
      }
      if (!task.startedAt) throw new Error('KDS任务缺少开始制作时间')
      if (Date.parse(command.occurredAt) < Date.parse(task.startedAt)) throw new Error('KDS操作时间早于前序操作')

      const order = findOrder(state, task.orderId)
      const item = order.items.find((candidate) => candidate.id === task.orderItemId)
      const linkedToOriginal = item?.kdsTaskId === task.id
      const linkedAsRemake = item != null
        && task.remakeOf?.orderItemId === item.id
        && task.remakeOf.kdsTaskId === item.kdsTaskId
      if (!item || (!linkedToOriginal && !linkedAsRemake)) throw new Error('KDS任务与订单明细不一致')

      task.status = 'delivered'
      task.completedAt = command.occurredAt
      task.completedBy = command.actorId
      task.pickedUpAt = command.occurredAt
      task.pickedUpBy = command.actorId
      task.deliveredAt = command.occurredAt
      task.deliveredBy = command.actorId
      task.pickupSla = {
        targetSeconds: task.pickupSla?.targetSeconds ?? task.workstation?.pickupSlaSeconds ?? 0,
        dueAt: isoAfter(
          command.occurredAt,
          task.pickupSla?.targetSeconds ?? task.workstation?.pickupSlaSeconds ?? 0,
        ),
      }
      item.fulfillmentStatus = 'delivered'
      syncOrderFulfillment(state, order, command.occurredAt)
      return task
    },
    (task) => task.id,
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
