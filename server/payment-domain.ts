import type {
  ApplyPaymentQueryResultCommand,
  ApproveRefundCommand,
  CashierHandover,
  ChannelPaymentStatus,
  ConfirmCashPaymentCommand,
  CreatePaymentIntentCommand,
  HandlePaymentNotificationCommand,
  MarkRefundFailedCommand,
  MarkRefundSucceededCommand,
  PaymentDomainResultType,
  PaymentDomainState,
  PaymentIdempotencyRecord,
  PaymentIntent,
  PaymentNotification,
  PaymentStatusQuery,
  Refund,
  RefundItem,
  RejectRefundCommand,
  ReportPhysicalPosPaymentCommand,
  ReviewCashierHandoverCommand,
  RequestPaymentStatusQueryCommand,
  RequestRefundCommand,
  SettlementChannel,
  SettlementChannelSummary,
  StartRefundCommand,
  SubmitCashierHandoverCommand,
} from '../src/shared/payment-contracts.js'
import { venueBusinessDateKey } from '../src/shared/venue-time.js'
import {
  CASH_PAYMENT_CHANNEL,
  PHYSICAL_POS_CHANNEL,
  SETTLEMENT_CHANNELS,
} from '../src/shared/payment-contracts.js'

export function createPaymentDomainState(): PaymentDomainState {
  return {
    paymentIntents: [],
    paymentNotifications: [],
    paymentStatusQueries: [],
    physicalPosReports: [],
    cashPaymentConfirmations: [],
    refunds: [],
    cashierHandovers: [],
    idempotencyRecords: [],
  }
}

function cashPaymentConfirmations(state: PaymentDomainState) {
  return state.cashPaymentConfirmations ?? (state.cashPaymentConfirmations = [])
}

export function cashierHandovers(state: PaymentDomainState) {
  return state.cashierHandovers ?? (state.cashierHandovers = [])
}

function assertNonEmpty(value: string, label: string) {
  if (value.trim().length === 0) throw new Error(`${label}不能为空`)
}

function assertTimestamp(value: string, label = '时间') {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label}必须是有效的ISO时间`)
}

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}必须是正安全整数`)
}

function assertCurrency(value: string) {
  if (!/^[A-Z]{3}$/.test(value)) throw new Error('币种必须是三位大写代码')
}

function assertBusinessDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error('营业日必须是有效日期')
  }
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
  state: PaymentDomainState,
  key: string,
  operation: string,
  payload: unknown,
  resultType: PaymentDomainResultType,
  resolve: (resultId: string) => T | undefined,
  execute: () => T,
  resultId: (result: T) => string,
) {
  assertNonEmpty(key, '幂等键')
  const serverGeneratedFields = new Set(['occurredAt'])
  if (operation === 'payment.create_intent.v1') serverGeneratedFields.add('expiresAt')
  if (operation === 'payment.report_physical_pos.v1') serverGeneratedFields.add('paidAt')
  const fingerprintPayload = typeof payload === 'object' && payload !== null
    ? Object.fromEntries(Object.entries(payload).filter(([field]) => !serverGeneratedFields.has(field)))
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
  const record: PaymentIdempotencyRecord = {
    key,
    operation,
    fingerprint,
    resultType,
    resultId: resultId(result),
  }
  state.idempotencyRecords.push(record)
  return result
}

function findPaymentIntent(state: PaymentDomainState, paymentIntentId: string) {
  const intent = state.paymentIntents.find((item) => item.id === paymentIntentId)
  if (!intent) throw new Error('支付意图不存在')
  return intent
}

function findRefund(state: PaymentDomainState, refundId: string) {
  const refund = state.refunds.find((item) => item.id === refundId)
  if (!refund) throw new Error('退款申请不存在')
  return refund
}

function findResult(
  state: PaymentDomainState,
  resultType: PaymentDomainResultType,
  resultId: string,
) {
  switch (resultType) {
    case 'payment_intent':
      return state.paymentIntents.find((item) => item.id === resultId)
    case 'payment_query':
      return state.paymentStatusQueries.find((item) => item.id === resultId)
    case 'physical_pos_report':
      return state.physicalPosReports.find((item) => item.id === resultId)
    case 'cash_payment_confirmation':
      return cashPaymentConfirmations(state).find((item) => item.id === resultId)
    case 'refund':
      return state.refunds.find((item) => item.id === resultId)
    case 'cashier_handover':
      return cashierHandovers(state).find((item) => item.id === resultId)
  }
}

export function createPaymentIntent(state: PaymentDomainState, command: CreatePaymentIntentCommand) {
  assertNonEmpty(command.paymentIntentId, '支付意图ID')
  assertNonEmpty(command.tableSessionId, '桌台会话ID')
  assertNonEmpty(command.channel, '支付渠道')
  assertNonEmpty(command.merchantId, '商户ID')
  assertNonEmpty(command.createdBy, '创建人')
  assertNonEmpty(command.deviceId, '设备ID')
  assertTimestamp(command.occurredAt, '创建时间')
  assertTimestamp(command.expiresAt, '失效时间')
  assertPositiveInteger(command.amount, '支付金额')
  assertCurrency(command.currency)
  if (command.businessDate) assertBusinessDate(command.businessDate)
  if (command.sourceRefundId) assertNonEmpty(command.sourceRefundId, '重收来源退款ID')
  if (Date.parse(command.expiresAt) <= Date.parse(command.occurredAt)) throw new Error('失效时间必须晚于创建时间')
  if (command.lineAllocations.length === 0) throw new Error('支付意图必须明确关联订单商品')

  const allocationKeys = new Set<string>()
  let allocatedAmount = 0
  const lineAllocations = command.lineAllocations.map((allocation) => {
    assertNonEmpty(allocation.orderId, '订单ID')
    assertNonEmpty(allocation.orderItemId, '订单明细ID')
    assertPositiveInteger(allocation.quantity, '支付商品数量')
    assertPositiveInteger(allocation.unitPaidAmount, '商品实付单价')
    if (allocation.sourceUnitPriceAmount !== undefined) {
      assertPositiveInteger(allocation.sourceUnitPriceAmount, '商品原始单价')
    }
    const key = `${allocation.orderId}\u0000${allocation.orderItemId}`
    if (allocationKeys.has(key)) throw new Error('支付商品明细不能重复')
    allocationKeys.add(key)
    const paidAmount = safeMultiply(allocation.quantity, allocation.unitPaidAmount, '商品实付金额')
    allocatedAmount = safeAdd(allocatedAmount, paidAmount, '支付分摊总额')
    return { ...allocation, paidAmount }
  })
  if (allocatedAmount !== command.amount) throw new Error('支付金额必须等于明确关联的商品实付金额')

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'payment.create_intent.v1',
    command,
    'payment_intent',
    (id) => state.paymentIntents.find((item) => item.id === id),
    () => {
      if (state.paymentIntents.some((item) => item.id === command.paymentIntentId)) {
        throw new Error('支付意图ID已存在')
      }
      const orderIds = [...new Set(lineAllocations.map((item) => item.orderId))]
      const intent: PaymentIntent = {
        id: command.paymentIntentId,
        tableSessionId: command.tableSessionId,
        orderIds,
        lineAllocations,
        amount: command.amount,
        currency: command.currency,
        channel: command.channel,
        ...(command.settlementChannel ? { settlementChannel: command.settlementChannel } : {}),
        merchantId: command.merchantId,
        status: 'pending',
        channelTransactionId: null,
        createdBy: command.createdBy,
        deviceId: command.deviceId,
        createdAt: command.occurredAt,
        expiresAt: command.expiresAt,
        paidAt: null,
        failedAt: null,
        closedAt: null,
        failureReason: null,
        ...(command.businessDate ? { businessDate: command.businessDate } : {}),
        allocationMode: command.allocationMode ?? 'all',
        ...(command.requestSelectionFingerprint
          ? { requestSelectionFingerprint: command.requestSelectionFingerprint }
          : {}),
        ...(command.sourceRefundId ? { sourceRefundId: command.sourceRefundId } : {}),
      }
      state.paymentIntents.push(intent)
      return intent
    },
    (intent) => intent.id,
  )
}

const PAYMENT_EXPIRED_REASON = '支付意图已过期'

export function expirePaymentIntents(
  state: PaymentDomainState,
  occurredAt: string,
  tableSessionId?: string,
) {
  assertTimestamp(occurredAt, '支付意图过期处理时间')
  const occurredAtMs = Date.parse(occurredAt)
  const expired = state.paymentIntents.filter((intent) => (
    ['pending', 'processing'].includes(intent.status)
    && (!tableSessionId || intent.tableSessionId === tableSessionId)
    && Date.parse(intent.expiresAt) <= occurredAtMs
  ))
  for (const intent of expired) {
    intent.status = 'closed'
    intent.closedAt = occurredAt
    intent.failureReason = PAYMENT_EXPIRED_REASON
  }
  return expired
}

function assertPaymentObservation(
  intent: PaymentIntent,
  observation: {
    channelTransactionId: string
    amount: number
    currency: string
    merchantId: string
    channelOccurredAt: string
  },
) {
  assertNonEmpty(observation.channelTransactionId, '渠道交易号')
  assertTimestamp(observation.channelOccurredAt, '渠道交易时间')
  assertPositiveInteger(observation.amount, '渠道支付金额')
  assertCurrency(observation.currency)
  if (observation.amount !== intent.amount) throw new Error('渠道支付金额与支付意图不一致')
  if (observation.currency !== intent.currency) throw new Error('渠道币种与支付意图不一致')
  if (observation.merchantId !== intent.merchantId) throw new Error('渠道商户与支付意图不一致')
  if (Date.parse(observation.channelOccurredAt) < Date.parse(intent.createdAt)) {
    throw new Error('渠道交易时间不能早于支付意图创建时间')
  }
  if (intent.channelTransactionId && intent.channelTransactionId !== observation.channelTransactionId) {
    throw new Error('支付意图已绑定其他渠道交易号')
  }
}

function applyPaymentStatus(
  state: PaymentDomainState,
  intent: PaymentIntent,
  status: ChannelPaymentStatus,
  channelTransactionId: string,
  occurredAt: string,
) {
  const conflictingIntent = state.paymentIntents.find(
    (item) => item.id !== intent.id && item.channel === intent.channel && item.channelTransactionId === channelTransactionId,
  )
  if (conflictingIntent) throw new Error('渠道交易号已绑定其他支付意图')

  if (intent.status === 'reported_pending_reconciliation') {
    throw new Error('物理POS报送不能由渠道状态覆盖')
  }
  if (intent.status === 'succeeded') {
    if (status !== 'succeeded') throw new Error('已成功支付不能回退状态')
    return
  }
  if (intent.status === 'closed') {
    const paidBeforeExpiry = status === 'succeeded'
      && intent.failureReason === PAYMENT_EXPIRED_REASON
      && Date.parse(occurredAt) <= Date.parse(intent.expiresAt)
    if (!paidBeforeExpiry) throw new Error('终态支付意图不能继续变更')
    intent.status = 'succeeded'
    intent.channelTransactionId = channelTransactionId
    intent.paidAt = occurredAt
    intent.closedAt = null
    intent.failureReason = null
    return
  }
  if (intent.status === 'failed') throw new Error('终态支付意图不能继续变更')

  intent.channelTransactionId = channelTransactionId
  switch (status) {
    case 'pending':
    case 'processing':
      intent.status = 'processing'
      return
    case 'succeeded':
      intent.status = 'succeeded'
      intent.paidAt = occurredAt
      intent.failureReason = null
      return
    case 'failed':
      intent.status = 'failed'
      intent.failedAt = occurredAt
      intent.failureReason = '渠道返回支付失败'
      return
    case 'closed':
      intent.status = 'closed'
      intent.closedAt = occurredAt
  }
}

function applySettlementChannel(
  intent: PaymentIntent,
  channel: HandlePaymentNotificationCommand['settlementChannel'],
) {
  if (!channel) return
  if (intent.settlementChannel && intent.settlementChannel !== channel) {
    throw new Error('渠道支付方式与支付意图已记录方式不一致')
  }
  intent.settlementChannel = channel
}

export function handlePaymentNotification(
  state: PaymentDomainState,
  command: HandlePaymentNotificationCommand,
) {
  assertNonEmpty(command.channel, '支付渠道')
  assertNonEmpty(command.notificationId, '渠道通知ID')
  assertNonEmpty(command.paymentIntentId, '支付意图ID')
  assertTimestamp(command.receivedAt, '通知接收时间')
  if (!command.signatureVerified) throw new Error('支付通知验签失败')

  const fingerprint = canonicalize(command)
  const existing = state.paymentNotifications.find(
    (item) => item.channel === command.channel && item.notificationId === command.notificationId,
  )
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new Error('重复支付通知内容不一致')
    return existing
  }

  const intent = findPaymentIntent(state, command.paymentIntentId)
  if (intent.channel === PHYSICAL_POS_CHANNEL) throw new Error('物理POS支付必须使用人工报送入口')
  if (command.channel !== intent.channel) throw new Error('支付通知渠道与支付意图不一致')
  assertPaymentObservation(intent, command)
  applySettlementChannel(intent, command.settlementChannel)
  applyPaymentStatus(state, intent, command.status, command.channelTransactionId, command.channelOccurredAt)

  const notification: PaymentNotification = {
    id: `notification:${command.channel}:${command.notificationId}`,
    channel: command.channel,
    notificationId: command.notificationId,
    paymentIntentId: command.paymentIntentId,
    channelTransactionId: command.channelTransactionId,
    status: command.status,
    amount: command.amount,
    currency: command.currency,
    merchantId: command.merchantId,
    channelOccurredAt: command.channelOccurredAt,
    receivedAt: command.receivedAt,
    fingerprint,
  }
  state.paymentNotifications.push(notification)
  return notification
}

export function requestPaymentStatusQuery(
  state: PaymentDomainState,
  command: RequestPaymentStatusQueryCommand,
) {
  assertNonEmpty(command.queryId, '查询ID')
  assertNonEmpty(command.paymentIntentId, '支付意图ID')
  assertNonEmpty(command.requestedBy, '查询发起人')
  assertTimestamp(command.occurredAt, '查询发起时间')

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'payment.request_query.v1',
    command,
    'payment_query',
    (id) => state.paymentStatusQueries.find((item) => item.id === id),
    () => {
      const intent = findPaymentIntent(state, command.paymentIntentId)
      if (intent.channel === PHYSICAL_POS_CHANNEL) throw new Error('物理POS支付没有渠道主动查询入口')
      if (Date.parse(command.occurredAt) < Date.parse(intent.createdAt)) throw new Error('查询时间不能早于支付意图创建时间')
      if (state.paymentStatusQueries.some((item) => item.id === command.queryId)) throw new Error('查询ID已存在')
      const query: PaymentStatusQuery = {
        id: command.queryId,
        paymentIntentId: command.paymentIntentId,
        status: 'requested',
        requestedBy: command.requestedBy,
        requestedAt: command.occurredAt,
        completedAt: null,
        resultStatus: null,
        channelTransactionId: null,
      }
      state.paymentStatusQueries.push(query)
      return query
    },
    (query) => query.id,
  )
}

export const queryPaymentStatus = requestPaymentStatusQuery

export function applyPaymentQueryResult(
  state: PaymentDomainState,
  command: ApplyPaymentQueryResultCommand,
) {
  assertNonEmpty(command.queryId, '查询ID')
  assertTimestamp(command.receivedAt, '查询结果接收时间')

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'payment.apply_query_result.v1',
    command,
    'payment_query',
    (id) => state.paymentStatusQueries.find((item) => item.id === id),
    () => {
      const query = state.paymentStatusQueries.find((item) => item.id === command.queryId)
      if (!query) throw new Error('支付状态查询不存在')
      if (query.status !== 'requested') throw new Error('支付状态查询已经完成')
      if (Date.parse(command.receivedAt) < Date.parse(query.requestedAt)) throw new Error('查询结果不能早于查询请求')
      const intent = findPaymentIntent(state, query.paymentIntentId)
      assertPaymentObservation(intent, command)
      applySettlementChannel(intent, command.settlementChannel)
      applyPaymentStatus(state, intent, command.status, command.channelTransactionId, command.channelOccurredAt)
      query.status = 'completed'
      query.completedAt = command.receivedAt
      query.resultStatus = command.status
      query.channelTransactionId = command.channelTransactionId
      return query
    },
    (query) => query.id,
  )
}

export const recordPaymentQueryResult = applyPaymentQueryResult

export function confirmCashPayment(state: PaymentDomainState, command: ConfirmCashPaymentCommand) {
  assertNonEmpty(command.confirmationId, '现金确认ID')
  assertNonEmpty(command.paymentIntentId, '支付意图ID')
  assertNonEmpty(command.confirmedBy, '现金确认人')
  assertNonEmpty(command.deviceId, '确认设备')
  assertTimestamp(command.occurredAt, '现金确认时间')
  assertPositiveInteger(command.amount, '现金实收金额')
  assertCurrency(command.currency)

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'payment.confirm_cash.v1',
    command,
    'cash_payment_confirmation',
    (id) => cashPaymentConfirmations(state).find((item) => item.id === id),
    () => {
      const intent = findPaymentIntent(state, command.paymentIntentId)
      if (intent.channel !== CASH_PAYMENT_CHANNEL) throw new Error('支付意图不是现金渠道')
      if (!['pending', 'processing'].includes(intent.status)) throw new Error('当前支付意图不能确认现金实收')
      if (command.amount !== intent.amount) throw new Error('现金实收金额与支付意图不一致')
      if (command.currency !== intent.currency) throw new Error('现金实收币种与支付意图不一致')
      if (Date.parse(command.occurredAt) < Date.parse(intent.createdAt)) throw new Error('现金确认时间不能早于支付意图')
      if (cashPaymentConfirmations(state).some((item) => item.id === command.confirmationId)) {
        throw new Error('现金确认ID已存在')
      }
      const confirmation = {
        id: command.confirmationId,
        paymentIntentId: intent.id,
        tableSessionId: intent.tableSessionId,
        amount: command.amount,
        currency: command.currency,
        confirmedBy: command.confirmedBy,
        deviceId: command.deviceId,
        confirmedAt: command.occurredAt,
      }
      cashPaymentConfirmations(state).push(confirmation)
      intent.status = 'succeeded'
      intent.channelTransactionId = command.confirmationId
      intent.paidAt = command.occurredAt
      intent.failureReason = null
      return confirmation
    },
    (confirmation) => confirmation.id,
  )
}

export function reportPhysicalPosPayment(
  state: PaymentDomainState,
  command: ReportPhysicalPosPaymentCommand,
) {
  assertNonEmpty(command.reportId, '物理POS报送ID')
  assertNonEmpty(command.paymentIntentId, '支付意图ID')
  assertNonEmpty(command.terminalId, '终端编号')
  assertNonEmpty(command.terminalTransactionId, '终端交易号')
  assertNonEmpty(command.paymentMethod, '支付方式')
  assertNonEmpty(command.reportedBy, '报送员工')
  assertNonEmpty(command.deviceId, '报送设备')
  assertTimestamp(command.paidAt, '物理POS支付时间')
  assertTimestamp(command.occurredAt, '报送时间')
  assertPositiveInteger(command.amount, '物理POS实收金额')
  assertCurrency(command.currency)

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'payment.report_physical_pos.v1',
    command,
    'physical_pos_report',
    (id) => state.physicalPosReports.find((item) => item.id === id),
    () => {
      const intent = findPaymentIntent(state, command.paymentIntentId)
      if (intent.channel !== PHYSICAL_POS_CHANNEL) throw new Error('支付意图不是物理POS渠道')
      if (!['pending', 'processing'].includes(intent.status)) throw new Error('当前支付意图不能报送物理POS交易')
      if (command.amount !== intent.amount) throw new Error('物理POS实收金额与支付意图不一致')
      if (command.currency !== intent.currency) throw new Error('物理POS币种与支付意图不一致')
      if (Date.parse(command.paidAt) < Date.parse(intent.createdAt)) throw new Error('物理POS支付时间不能早于支付意图')
      if (Date.parse(command.occurredAt) < Date.parse(command.paidAt)) throw new Error('报送时间不能早于支付时间')
      if (state.physicalPosReports.some((item) => item.id === command.reportId)) throw new Error('物理POS报送ID已存在')
      const terminalTransactionExists = state.physicalPosReports.some(
        (item) => item.terminalId === command.terminalId && item.terminalTransactionId === command.terminalTransactionId,
      )
      if (terminalTransactionExists) throw new Error('终端交易号已被报送')

      const report = {
        id: command.reportId,
        paymentIntentId: intent.id,
        tableSessionId: intent.tableSessionId,
        orderIds: [...intent.orderIds],
        terminalId: command.terminalId,
        terminalTransactionId: command.terminalTransactionId,
        paymentMethod: command.paymentMethod,
        amount: command.amount,
        currency: command.currency,
        paidAt: command.paidAt,
        reportedBy: command.reportedBy,
        deviceId: command.deviceId,
        receiptReference: command.receiptReference?.trim() || null,
        status: 'reported_pending_reconciliation' as const,
        reportedAt: command.occurredAt,
      }
      state.physicalPosReports.push(report)
      intent.status = 'reported_pending_reconciliation'
      intent.channelTransactionId = command.terminalTransactionId
      intent.paidAt = command.paidAt
      return report
    },
    (report) => report.id,
  )
}

function refundableRefundStatuses(status: Refund['status']) {
  // A failed channel attempt remains retryable, so it must keep the original
  // item quantity reserved. Only an explicitly rejected request releases it.
  return status !== 'rejected'
}

function usedRefundQuantityAndAmount(
  state: PaymentDomainState,
  paymentIntentId: string,
  orderId: string,
  orderItemId: string,
) {
  let quantity = 0
  let amount = 0
  for (const refund of state.refunds) {
    if (refund.paymentIntentId !== paymentIntentId || !refundableRefundStatuses(refund.status)) continue
    const item = refund.items.find((candidate) => candidate.orderId === orderId && candidate.orderItemId === orderItemId)
    if (!item) continue
    quantity = safeAdd(quantity, item.quantity, '累计退款数量')
    amount = safeAdd(amount, item.amount, '累计退款金额')
  }
  return { quantity, amount }
}

export function requestRefund(state: PaymentDomainState, command: RequestRefundCommand) {
  assertNonEmpty(command.refundId, '退款申请ID')
  assertNonEmpty(command.paymentIntentId, '原支付意图ID')
  assertNonEmpty(command.reason, '退款原因')
  assertNonEmpty(command.requestedBy, '退款申请人')
  assertTimestamp(command.occurredAt, '退款申请时间')
  if (command.items.length === 0) throw new Error('退款必须选择原订单商品')
  const orderDisposition = command.orderDisposition ?? 'cancel_items'
  const receivableDisposition = command.receivableDisposition ?? 'reduce_receivable'
  if (orderDisposition === 'cancel_items' && receivableDisposition === 'reopen_receivable') {
    throw new Error('退掉商品后不能恢复同一笔应收；如需重新收款，请选择保留订单')
  }

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'refund.request.v1',
    command,
    'refund',
    (id) => state.refunds.find((item) => item.id === id),
    () => {
      const intent = findPaymentIntent(state, command.paymentIntentId)
      if (!['succeeded', 'reported_pending_reconciliation'].includes(intent.status)) {
        throw new Error('只有已支付交易可以申请退款')
      }
      if (Date.parse(command.occurredAt) < Date.parse(intent.paidAt ?? intent.createdAt)) {
        throw new Error('退款申请时间不能早于支付时间')
      }
      if (state.refunds.some((item) => item.id === command.refundId)) throw new Error('退款申请ID已存在')

      const itemKeys = new Set<string>()
      let amount = 0
      const items = command.items.map((requested): RefundItem => {
        assertNonEmpty(requested.orderId, '退款订单ID')
        assertNonEmpty(requested.orderItemId, '退款订单明细ID')
        assertPositiveInteger(requested.quantity, '退款数量')
        const key = `${requested.orderId}\u0000${requested.orderItemId}`
        if (itemKeys.has(key)) throw new Error('退款商品明细不能重复')
        itemKeys.add(key)

        const allocation = intent.lineAllocations.find(
          (candidate) => candidate.orderId === requested.orderId && candidate.orderItemId === requested.orderItemId,
        )
        if (!allocation) throw new Error('退款商品不属于原支付意图')
        const used = usedRefundQuantityAndAmount(
          state,
          intent.id,
          requested.orderId,
          requested.orderItemId,
        )
        const itemAmount = safeMultiply(requested.quantity, allocation.unitPaidAmount, '退款商品金额')
        if (safeAdd(used.quantity, requested.quantity, '累计退款数量') > allocation.quantity) {
          throw new Error('商品累计退款数量超过原支付数量')
        }
        if (safeAdd(used.amount, itemAmount, '累计退款金额') > allocation.paidAmount) {
          throw new Error('商品累计退款金额超过原实付金额')
        }
        amount = safeAdd(amount, itemAmount, '退款申请金额')
        return {
          orderId: requested.orderId,
          orderItemId: requested.orderItemId,
          quantity: requested.quantity,
          unitPaidAmount: allocation.unitPaidAmount,
          amount: itemAmount,
        }
      })

      const refund: Refund = {
        id: command.refundId,
        paymentIntentId: intent.id,
        tableSessionId: intent.tableSessionId,
        items,
        amount,
        currency: intent.currency,
        reason: command.reason.trim(),
        orderDisposition,
        receivableDisposition,
        status: 'requested',
        requestedBy: command.requestedBy,
        requestedAt: command.occurredAt,
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        channelRefundId: null,
        processingAt: null,
        channelRefundTransactionId: null,
        succeededAt: null,
        failedAt: null,
        failureReason: null,
      }
      state.refunds.push(refund)
      return refund
    },
    (refund) => refund.id,
  )
}

export function approveRefund(state: PaymentDomainState, command: ApproveRefundCommand) {
  assertNonEmpty(command.refundId, '退款申请ID')
  assertNonEmpty(command.approvedBy, '退款审批人')
  assertTimestamp(command.occurredAt, '退款审批时间')

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'refund.approve.v1',
    command,
    'refund',
    (id) => state.refunds.find((item) => item.id === id),
    () => {
      const refund = findRefund(state, command.refundId)
      if (refund.status !== 'requested') throw new Error('只有待审批退款可以批准')
      if (Date.parse(command.occurredAt) < Date.parse(refund.requestedAt)) throw new Error('审批时间不能早于申请时间')
      refund.status = 'approved'
      refund.decidedBy = command.approvedBy
      refund.decidedAt = command.occurredAt
      refund.decisionReason = command.reason.trim() || null
      return refund
    },
    (refund) => refund.id,
  )
}

export function rejectRefund(state: PaymentDomainState, command: RejectRefundCommand) {
  assertNonEmpty(command.refundId, '退款申请ID')
  assertNonEmpty(command.rejectedBy, '退款审批人')
  assertNonEmpty(command.reason, '拒绝原因')
  assertTimestamp(command.occurredAt, '退款审批时间')

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'refund.reject.v1',
    command,
    'refund',
    (id) => state.refunds.find((item) => item.id === id),
    () => {
      const refund = findRefund(state, command.refundId)
      if (refund.status !== 'requested') throw new Error('只有待审批退款可以拒绝')
      if (Date.parse(command.occurredAt) < Date.parse(refund.requestedAt)) throw new Error('审批时间不能早于申请时间')
      refund.status = 'rejected'
      refund.decidedBy = command.rejectedBy
      refund.decidedAt = command.occurredAt
      refund.decisionReason = command.reason.trim()
      return refund
    },
    (refund) => refund.id,
  )
}

export function startRefund(state: PaymentDomainState, command: StartRefundCommand) {
  assertNonEmpty(command.refundId, '退款申请ID')
  assertNonEmpty(command.channelRefundId, '渠道退款单号')
  assertNonEmpty(command.actorId, '退款操作人')
  assertTimestamp(command.occurredAt, '退款处理时间')

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'refund.start.v1',
    command,
    'refund',
    (id) => state.refunds.find((item) => item.id === id),
    () => {
      const refund = findRefund(state, command.refundId)
      if (!['approved', 'failed'].includes(refund.status)) throw new Error('只有已批准或渠道失败的退款可以提交渠道')
      if (Date.parse(command.occurredAt) < Date.parse(refund.decidedAt ?? refund.requestedAt)) {
        throw new Error('退款处理时间不能早于审批时间')
      }
      const duplicateChannelRefund = state.refunds.find(
        (item) => item.id !== refund.id && item.channelRefundId === command.channelRefundId,
      )
      if (duplicateChannelRefund) throw new Error('渠道退款单号已被使用')
      refund.status = 'processing'
      refund.channelRefundId = command.channelRefundId
      refund.processingAt = command.occurredAt
      refund.channelRefundTransactionId = null
      refund.succeededAt = null
      refund.failedAt = null
      refund.failureReason = null
      return refund
    },
    (refund) => refund.id,
  )
}

export function markRefundSucceeded(
  state: PaymentDomainState,
  command: MarkRefundSucceededCommand,
) {
  assertNonEmpty(command.refundId, '退款申请ID')
  assertNonEmpty(command.channelRefundTransactionId, '渠道退款交易号')
  assertTimestamp(command.occurredAt, '退款成功时间')
  assertPositiveInteger(command.refundedAmount, '渠道退款金额')
  assertCurrency(command.currency)

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'refund.succeed.v1',
    command,
    'refund',
    (id) => state.refunds.find((item) => item.id === id),
    () => {
      const refund = findRefund(state, command.refundId)
      if (refund.status !== 'processing') throw new Error('只有渠道处理中的退款可以成功')
      if (command.refundedAmount !== refund.amount) throw new Error('渠道退款金额与商品退款金额不一致')
      if (command.currency !== refund.currency) throw new Error('渠道退款币种不一致')
      if (Date.parse(command.occurredAt) < Date.parse(refund.processingAt ?? refund.requestedAt)) {
        throw new Error('退款成功时间不能早于渠道处理时间')
      }
      const duplicateTransaction = state.refunds.find(
        (item) => item.id !== refund.id && item.channelRefundTransactionId === command.channelRefundTransactionId,
      )
      if (duplicateTransaction) throw new Error('渠道退款交易号已被使用')
      refund.status = 'succeeded'
      refund.channelRefundTransactionId = command.channelRefundTransactionId
      refund.succeededAt = command.occurredAt
      return refund
    },
    (refund) => refund.id,
  )
}

export function markRefundFailed(state: PaymentDomainState, command: MarkRefundFailedCommand) {
  assertNonEmpty(command.refundId, '退款申请ID')
  assertNonEmpty(command.reason, '退款失败原因')
  assertTimestamp(command.occurredAt, '退款失败时间')

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'refund.fail.v1',
    command,
    'refund',
    (id) => state.refunds.find((item) => item.id === id),
    () => {
      const refund = findRefund(state, command.refundId)
      if (refund.status !== 'processing') throw new Error('只有渠道处理中的退款可以失败')
      if (Date.parse(command.occurredAt) < Date.parse(refund.processingAt ?? refund.requestedAt)) {
        throw new Error('退款失败时间不能早于渠道处理时间')
      }
      refund.status = 'failed'
      refund.failedAt = command.occurredAt
      refund.failureReason = command.reason.trim()
      return refund
    },
    (refund) => refund.id,
  )
}

export interface SettlementBusinessTime {
  timeZone?: string
  rolloverHour?: number
}

function settlementBusinessDate(value: string, time: SettlementBusinessTime = {}) {
  return venueBusinessDateKey(value, time.timeZone ?? 'Asia/Shanghai', time.rolloverHour ?? 6)
}

function settlementChannelForIntent(intent: PaymentIntent): SettlementChannel | null {
  if (intent.settlementChannel) return intent.settlementChannel
  const channel = intent.channel.toLowerCase()
  if (channel === CASH_PAYMENT_CHANNEL) return 'cash'
  if (channel === PHYSICAL_POS_CHANNEL) return 'physical_pos'
  if (channel.includes('wechat') || channel.includes('weixin')) return 'wechat'
  if (channel.includes('alipay')) return 'alipay'
  return null
}

function intentBusinessDate(intent: PaymentIntent, time: SettlementBusinessTime) {
  return intent.businessDate ?? settlementBusinessDate(intent.paidAt ?? intent.createdAt, time)
}

export function buildSettlementChannelSummaries(
  state: PaymentDomainState,
  businessDate: string,
  confirmedActualAmounts: Partial<Record<SettlementChannel, number>> = {},
  time: SettlementBusinessTime = {},
) {
  assertBusinessDate(businessDate)
  const totals = new Map<SettlementChannel, { system: number; pending: number }>(
    SETTLEMENT_CHANNELS.map((channel) => [channel, { system: 0, pending: 0 }]),
  )

  for (const intent of state.paymentIntents) {
    const channel = settlementChannelForIntent(intent)
    if (!channel || intentBusinessDate(intent, time) !== businessDate) continue
    if (['succeeded', 'reported_pending_reconciliation'].includes(intent.status)) {
      const total = totals.get(channel)!
      total.system = safeAdd(total.system, intent.amount, '渠道系统应收')
    }
  }

  for (const refund of state.refunds) {
    if (refund.status !== 'succeeded' || !refund.succeededAt || settlementBusinessDate(refund.succeededAt, time) !== businessDate) continue
    const intent = state.paymentIntents.find((item) => item.id === refund.paymentIntentId)
    const channel = intent && settlementChannelForIntent(intent)
    if (!channel) continue
    const total = totals.get(channel)!
    total.system = safeAdd(total.system, -refund.amount, '渠道退款后系统应收')
  }

  for (const report of state.physicalPosReports) {
    const intent = state.paymentIntents.find((item) => item.id === report.paymentIntentId)
    const reportBusinessDate = intent?.businessDate ?? settlementBusinessDate(report.paidAt, time)
    if (report.status !== 'reported_pending_reconciliation' || reportBusinessDate !== businessDate) continue
    const total = totals.get('physical_pos')!
    total.pending = safeAdd(total.pending, report.amount, '物理POS待对账金额')
  }

  return SETTLEMENT_CHANNELS.map((channel): SettlementChannelSummary => {
    const total = totals.get(channel)!
    const confirmedActualAmount = confirmedActualAmounts[channel] ?? 0
    if (!Number.isSafeInteger(confirmedActualAmount) || confirmedActualAmount < 0) {
      throw new Error('确认实收必须是非负安全整数')
    }
    return {
      channel,
      systemReceivableAmount: total.system,
      confirmedActualAmount,
      pendingReconciliationAmount: total.pending,
      differenceAmount: confirmedActualAmount - total.system,
    }
  })
}

export function latestCashierHandover(state: PaymentDomainState, businessDate: string) {
  return cashierHandovers(state)
    .filter((handover) => handover.businessDate === businessDate)
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))[0] ?? null
}

export function handoverSnapshotMatches(
  state: PaymentDomainState,
  handover: CashierHandover,
  time: SettlementBusinessTime = {},
) {
  const current = buildSettlementChannelSummaries(state, handover.businessDate, {}, time)
  return SETTLEMENT_CHANNELS.every((channel) => {
    const submitted = handover.channels.find((item) => item.channel === channel)
    const live = current.find((item) => item.channel === channel)!
    return submitted?.systemReceivableAmount === live.systemReceivableAmount
      && submitted.pendingReconciliationAmount === live.pendingReconciliationAmount
  })
}

export function submitCashierHandover(state: PaymentDomainState, command: SubmitCashierHandoverCommand) {
  assertNonEmpty(command.handoverId, '交班ID')
  assertBusinessDate(command.businessDate)
  assertNonEmpty(command.shiftId, '收银班次ID')
  assertNonEmpty(command.submittedBy, '交班提交人')
  assertNonEmpty(command.deviceId, '交班设备')
  assertTimestamp(command.occurredAt, '交班提交时间')

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'payment.cashier_handover.submit.v1',
    command,
    'cashier_handover',
    (id) => cashierHandovers(state).find((item) => item.id === id),
    () => {
      if (cashierHandovers(state).some((item) => item.id === command.handoverId)) throw new Error('交班ID已存在')
      const active = latestCashierHandover(state, command.businessDate)
      if (active && active.status !== 'rejected') throw new Error('当前营业日已有未驳回的收银交班')

      const channelMap = new Map(command.channels.map((item) => [item.channel, item]))
      if (channelMap.size !== SETTLEMENT_CHANNELS.length) throw new Error('交班必须包含全部结算渠道且不能重复')
      const channels = SETTLEMENT_CHANNELS.map((channel) => {
        const summary = channelMap.get(channel)
        if (!summary) throw new Error(`交班缺少${channel}渠道`)
        for (const amount of [
          summary.systemReceivableAmount,
          summary.confirmedActualAmount,
          summary.pendingReconciliationAmount,
          summary.differenceAmount,
        ]) {
          if (!Number.isSafeInteger(amount)) throw new Error('交班金额必须是安全整数')
        }
        if (summary.confirmedActualAmount < 0 || summary.pendingReconciliationAmount < 0) {
          throw new Error('确认实收和待对账金额不能为负数')
        }
        if (summary.differenceAmount !== summary.confirmedActualAmount - summary.systemReceivableAmount) {
          throw new Error('交班差异计算不一致')
        }
        return { ...summary }
      })

      const unresolved = new Set(channels
        .filter((item) => item.pendingReconciliationAmount > 0 || item.differenceAmount !== 0)
        .map((item) => item.channel))
      const issueMap = new Map<SettlementChannel, SubmitCashierHandoverCommand['issues'][number]>()
      for (const issue of command.issues) {
        assertNonEmpty(issue.reason, '未对账原因')
        assertNonEmpty(issue.nextDayOwnerId, '次日责任人')
        if (issueMap.has(issue.channel)) throw new Error('同一渠道只能登记一项未对账原因')
        if (!unresolved.has(issue.channel)) throw new Error('无差异且无待对账金额的渠道不能登记未对账项')
        issueMap.set(issue.channel, issue)
      }
      for (const channel of unresolved) {
        if (!issueMap.has(channel)) throw new Error(`${channel}渠道未对账，必须填写原因和次日责任人`)
      }
      const issues = [...unresolved].map((channel) => {
        const issue = issueMap.get(channel)!
        const summary = channelMap.get(channel)!
        return {
          channel,
          amount: Math.max(Math.abs(summary.differenceAmount), summary.pendingReconciliationAmount),
          reason: issue.reason.trim(),
          nextDayOwnerId: issue.nextDayOwnerId,
        }
      })
      const handover: CashierHandover = {
        id: command.handoverId,
        businessDate: command.businessDate,
        shiftId: command.shiftId,
        submittedBy: command.submittedBy,
        submittedAt: command.occurredAt,
        deviceId: command.deviceId,
        note: command.note?.trim() || null,
        status: 'submitted',
        channels,
        issues,
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
        closedAt: null,
      }
      cashierHandovers(state).push(handover)
      return handover
    },
    (handover) => handover.id,
  )
}

export function reviewCashierHandover(state: PaymentDomainState, command: ReviewCashierHandoverCommand) {
  assertNonEmpty(command.handoverId, '交班ID')
  assertNonEmpty(command.reviewedBy, '复核人')
  assertTimestamp(command.occurredAt, '复核时间')
  if (command.decision === 'reject') assertNonEmpty(command.note ?? '', '驳回说明')

  return executeIdempotent(
    state,
    command.idempotencyKey,
    'payment.cashier_handover.review.v1',
    command,
    'cashier_handover',
    (id) => cashierHandovers(state).find((item) => item.id === id),
    () => {
      const handover = cashierHandovers(state).find((item) => item.id === command.handoverId)
      if (!handover) throw new Error('收银交班不存在')
      if (handover.status !== 'submitted') throw new Error('只有待复核交班可以处理')
      if (handover.submittedBy === command.reviewedBy) throw new Error('交班提交人与经理复核人必须为不同员工')
      if (Date.parse(command.occurredAt) < Date.parse(handover.submittedAt)) throw new Error('复核时间不能早于交班提交时间')
      handover.status = command.decision === 'approve' ? 'approved' : 'rejected'
      handover.reviewedBy = command.reviewedBy
      handover.reviewedAt = command.occurredAt
      handover.reviewNote = command.note?.trim() || null
      return handover
    },
    (handover) => handover.id,
  )
}

export function closeCashierHandover(handover: CashierHandover, occurredAt: string) {
  assertTimestamp(occurredAt, '关账时间')
  if (handover.status !== 'approved') throw new Error('只有经理复核通过的交班可以关账')
  handover.status = 'closed'
  handover.closedAt = occurredAt
  return handover
}

export function resolvePaymentDomainResult(
  state: PaymentDomainState,
  resultType: PaymentDomainResultType,
  resultId: string,
) {
  return findResult(state, resultType, resultId)
}
