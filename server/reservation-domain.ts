import type {
  CancelReservationCommand,
  CompleteReservationDepositRefundCommand,
  ConfirmReservationDepositCommand,
  CreateReservationCommand,
  FailReservationDepositRefundCommand,
  MarkReservationNoShowCommand,
  RecordReservationDepositIntentCommand,
  Reservation,
  ReservationActionCommand,
  ReservationAuditEvent,
  ReservationAuditEventType,
  ReservationConfig,
  ReservationDepositStatus,
  ReservationScope,
  ReservationState,
  ReservationStatus,
  SeatReservationCommand,
  StartReservationDepositRefundCommand,
} from '../src/shared/reservation-contracts.js'

export const DEFAULT_RESERVATION_CONFIG: ReservationConfig = {
  version: 1,
  minimumPartySize: 1,
  maximumPartySize: 30,
  sources: [
    { code: 'phone', name: '电话', enabled: true, sortOrder: 10 },
    { code: 'wechat', name: '微信', enabled: true, sortOrder: 20 },
    { code: 'walk_in', name: '现场', enabled: true, sortOrder: 30 },
  ],
  areaPreferences: [],
  occasions: [
    { code: 'birthday', name: '生日', enabled: true, serviceScript: ['确认生日称呼与时间', '通知值班经理准备生日权益'] },
    { code: 'anniversary', name: '纪念日', enabled: true, serviceScript: [] },
    { code: 'business', name: '商务接待', enabled: true, serviceScript: [] },
    { code: 'other', name: '其他', enabled: true, serviceScript: [] },
  ],
}

export function createReservationState(
  scope: ReservationScope,
  config: ReservationConfig = DEFAULT_RESERVATION_CONFIG,
): ReservationState {
  assertNonEmpty(scope.tenantId, '租户ID')
  assertNonEmpty(scope.storeId, '门店ID')
  validateConfig(config)
  return {
    ...scope,
    config: structuredClone(config),
    reservations: [],
    auditEvents: [],
    idempotencyRecords: [],
  }
}

export function updateReservationConfig(state: ReservationState, config: ReservationConfig) {
  validateConfig(config)
  if (config.version <= state.config.version) throw new Error('预约配置版本必须高于当前版本')
  state.config = structuredClone(config)
  return state.config
}

function assertNonEmpty(value: string, label: string) {
  if (value.trim().length === 0) throw new Error(`${label}不能为空`)
}

function assertTimestamp(value: string, label = '时间') {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label}必须是有效的ISO时间`)
}

function assertMoney(value: number, label: string, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`${label}必须是${allowZero ? '非负' : '正'}安全整数`)
  }
}

function assertCurrency(value: string) {
  if (!/^[A-Z]{3}$/.test(value)) throw new Error('币种必须是三位大写代码')
}

function validateConfig(config: ReservationConfig) {
  if (!Number.isSafeInteger(config.version) || config.version < 1) throw new Error('预约配置版本不合法')
  if (!Number.isSafeInteger(config.minimumPartySize) || config.minimumPartySize < 1) throw new Error('最小预约人数不合法')
  if (!Number.isSafeInteger(config.maximumPartySize) || config.maximumPartySize < config.minimumPartySize) {
    throw new Error('最大预约人数不合法')
  }
  for (const collection of [config.sources, config.areaPreferences, config.occasions]) {
    const codes = collection.map((item) => item.code)
    if (new Set(codes).size !== codes.length) throw new Error('预约配置代码不能重复')
    collection.forEach((item) => assertNonEmpty(item.code, '预约配置代码'))
  }
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

function executeIdempotent(
  state: ReservationState,
  key: string,
  operation: string,
  payload: unknown,
  reservationId: string,
  execute: () => Reservation,
) {
  assertNonEmpty(key, '幂等键')
  const fingerprintPayload = typeof payload === 'object' && payload !== null
    ? Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'occurredAt'))
    : payload
  const fingerprint = canonicalize(fingerprintPayload)
  const existing = state.idempotencyRecords.find((record) => record.key === key)
  if (existing) {
    if (existing.operation !== operation || existing.fingerprint !== fingerprint) {
      throw new Error('幂等键已用于不同请求')
    }
    const reservation = state.reservations.find((item) => item.id === existing.reservationId)
    if (!reservation) throw new Error('幂等记录指向的预约不存在')
    return reservation
  }
  const result = execute()
  state.idempotencyRecords.push({ key, operation, fingerprint, reservationId })
  return result
}

function findReservation(state: ReservationState, reservationId: string) {
  const reservation = state.reservations.find((item) => item.id === reservationId)
  if (!reservation) throw new Error('预约不存在')
  return reservation
}

function audit(
  state: ReservationState,
  reservation: Reservation,
  type: ReservationAuditEventType,
  actorId: string,
  occurredAt: string,
  fromStatus: ReservationStatus | null,
  depositFromStatus: ReservationDepositStatus | null,
  reason: string | null,
  details: ReservationAuditEvent['details'] = {},
) {
  state.auditEvents.push({
    ...scope(state),
    id: `reservation-event:${reservation.id}:${state.auditEvents.length + 1}`,
    reservationId: reservation.id,
    type,
    actorId,
    fromStatus,
    toStatus: reservation.status,
    depositFromStatus,
    depositToStatus: reservation.deposit.status,
    occurredAt,
    reason,
    details,
  })
}

function scope(state: ReservationState): ReservationScope {
  return { tenantId: state.tenantId, storeId: state.storeId }
}

function assertAction(command: ReservationActionCommand) {
  assertNonEmpty(command.reservationId, '预约ID')
  assertNonEmpty(command.actorId, '操作人')
  assertTimestamp(command.occurredAt)
}

function touch(reservation: Reservation, occurredAt: string) {
  reservation.updatedAt = occurredAt
  reservation.revision += 1
}

export function createReservation(state: ReservationState, command: CreateReservationCommand) {
  assertNonEmpty(command.reservationId, '预约ID')
  assertNonEmpty(command.customerReference, '顾客引用')
  assertNonEmpty(command.customerName, '顾客称呼')
  assertNonEmpty(command.contactReference, '联系方式引用')
  assertNonEmpty(command.actorId, '操作人')
  assertTimestamp(command.scheduledAt, '预约时间')
  assertTimestamp(command.occurredAt)
  if (!Number.isSafeInteger(command.partySize) || command.partySize < state.config.minimumPartySize || command.partySize > state.config.maximumPartySize) {
    throw new Error(`预约人数必须在${state.config.minimumPartySize}至${state.config.maximumPartySize}之间`)
  }
  const source = state.config.sources.find((item) => item.code === command.sourceCode && item.enabled)
  if (!source) throw new Error('预约来源未配置或已停用')
  if (command.areaPreferenceCode && !state.config.areaPreferences.some((item) => item.code === command.areaPreferenceCode && item.enabled)) {
    throw new Error('区域偏好未配置或已停用')
  }
  if (command.occasionCode && !state.config.occasions.some((item) => item.code === command.occasionCode && item.enabled)) {
    throw new Error('特殊场景未配置或已停用')
  }
  assertMoney(command.depositRequiredAmount, '订金金额', true)
  assertCurrency(command.depositCurrency)

  return executeIdempotent(state, command.idempotencyKey, 'reservation.create', command, command.reservationId, () => {
    if (state.reservations.some((item) => item.id === command.reservationId)) throw new Error('预约ID已存在')
    const depositStatus: ReservationDepositStatus = command.depositRequiredAmount === 0 ? 'not_required' : 'payment_required'
    const reservation: Reservation = {
      ...scope(state),
      id: command.reservationId,
      customerReference: command.customerReference,
      customerName: command.customerName,
      contactReference: command.contactReference,
      sourceCode: command.sourceCode,
      partySize: command.partySize,
      areaPreferenceCode: command.areaPreferenceCode?.trim() || null,
      occasionCode: command.occasionCode ?? null,
      occasionNote: command.occasionNote?.trim() ?? '',
      scheduledAt: command.scheduledAt,
      status: 'requested',
      deposit: {
        requiredAmount: command.depositRequiredAmount,
        currency: command.depositCurrency,
        status: depositStatus,
        paymentIntentReference: null,
        paymentIntentRecordedAt: null,
        paymentConfirmationReference: null,
        paymentConfirmedAt: null,
        refundRequestReference: null,
        refundRequestedAt: null,
        refundConfirmationReference: null,
        refundedAt: null,
        refundFailureReason: null,
      },
      tableId: null,
      tableCode: null,
      tableSessionId: null,
      requestedAt: command.occurredAt,
      confirmedAt: null,
      arrivedAt: null,
      seatedAt: null,
      cancelledAt: null,
      noShowAt: null,
      cancellationReason: null,
      createdBy: command.actorId,
      updatedAt: command.occurredAt,
      revision: 1,
      configVersion: state.config.version,
    }
    state.reservations.push(reservation)
    audit(state, reservation, 'reservation.requested.v1', command.actorId, command.occurredAt, null, null, null, {
      sourceCode: command.sourceCode,
      partySize: command.partySize,
      birthday: command.occasionCode === 'birthday',
    })
    return reservation
  })
}

export function recordReservationDepositIntent(state: ReservationState, command: RecordReservationDepositIntentCommand) {
  assertAction(command)
  assertNonEmpty(command.paymentIntentReference, '支付意图引用')
  return executeIdempotent(state, command.idempotencyKey, 'reservation.deposit.record_intent', command, command.reservationId, () => {
    const reservation = findReservation(state, command.reservationId)
    if (reservation.status !== 'requested') throw new Error('只有待确认预约可以记录订金支付意图')
    if (reservation.deposit.requiredAmount <= 0) throw new Error('该预约不要求订金')
    if (reservation.deposit.status !== 'payment_required' || reservation.deposit.paymentIntentReference) {
      throw new Error('订金支付意图已经记录或当前状态不允许记录')
    }
    const previous = reservation.deposit.status
    reservation.deposit.status = 'payment_intent_recorded'
    reservation.deposit.paymentIntentReference = command.paymentIntentReference
    reservation.deposit.paymentIntentRecordedAt = command.occurredAt
    touch(reservation, command.occurredAt)
    audit(state, reservation, 'reservation.deposit_intent_recorded.v1', command.actorId, command.occurredAt, reservation.status, previous, null, {
      paymentIntentReference: command.paymentIntentReference,
    })
    return reservation
  })
}

export function confirmReservationDeposit(state: ReservationState, command: ConfirmReservationDepositCommand) {
  assertAction(command)
  assertNonEmpty(command.paymentIntentReference, '支付意图引用')
  assertNonEmpty(command.paymentConfirmationReference, '支付确认引用')
  assertMoney(command.confirmedAmount, '支付确认金额')
  assertCurrency(command.currency)
  return executeIdempotent(state, command.idempotencyKey, 'reservation.deposit.confirm', command, command.reservationId, () => {
    const reservation = findReservation(state, command.reservationId)
    if (reservation.status !== 'requested') throw new Error('只有待确认预约可以确认订金')
    if (reservation.deposit.status !== 'payment_intent_recorded' || reservation.deposit.paymentIntentReference !== command.paymentIntentReference) {
      throw new Error('支付确认与已记录的支付意图不匹配')
    }
    if (reservation.deposit.requiredAmount !== command.confirmedAmount || reservation.deposit.currency !== command.currency) {
      throw new Error('支付确认金额或币种不匹配')
    }
    const previous = reservation.deposit.status
    reservation.deposit.status = 'payment_confirmed'
    reservation.deposit.paymentConfirmationReference = command.paymentConfirmationReference
    reservation.deposit.paymentConfirmedAt = command.occurredAt
    touch(reservation, command.occurredAt)
    audit(state, reservation, 'reservation.deposit_confirmed.v1', command.actorId, command.occurredAt, reservation.status, previous, null, {
      paymentConfirmationReference: command.paymentConfirmationReference,
      confirmedAmount: command.confirmedAmount,
      currency: command.currency,
    })
    return reservation
  })
}

export function confirmReservation(state: ReservationState, command: ReservationActionCommand) {
  return transitionReservation(state, command, 'reservation.confirm', ['requested'], 'confirmed', 'reservation.confirmed.v1')
}

export function markReservationArrived(state: ReservationState, command: ReservationActionCommand) {
  return transitionReservation(state, command, 'reservation.arrive', ['confirmed'], 'arrived', 'reservation.arrived.v1')
}

function transitionReservation(
  state: ReservationState,
  command: ReservationActionCommand,
  operation: string,
  from: ReservationStatus[],
  to: ReservationStatus,
  eventType: ReservationAuditEventType,
) {
  assertAction(command)
  return executeIdempotent(state, command.idempotencyKey, operation, command, command.reservationId, () => {
    const reservation = findReservation(state, command.reservationId)
    if (!from.includes(reservation.status)) throw new Error(`预约状态不能从${reservation.status}变为${to}`)
    if (to === 'confirmed' && reservation.deposit.requiredAmount > 0 && reservation.deposit.status !== 'payment_confirmed') {
      throw new Error('订金尚未收到外部支付确认，不能确认预约')
    }
    const previous = reservation.status
    reservation.status = to
    if (to === 'confirmed') reservation.confirmedAt = command.occurredAt
    if (to === 'arrived') reservation.arrivedAt = command.occurredAt
    touch(reservation, command.occurredAt)
    audit(state, reservation, eventType, command.actorId, command.occurredAt, previous, reservation.deposit.status, null)
    return reservation
  })
}

export function seatReservation(state: ReservationState, command: SeatReservationCommand) {
  assertAction(command)
  assertNonEmpty(command.tableId, '桌台ID')
  assertNonEmpty(command.tableCode, '桌台号')
  assertNonEmpty(command.tableSessionId, '桌台会话ID')
  return executeIdempotent(state, command.idempotencyKey, 'reservation.seat', command, command.reservationId, () => {
    const reservation = findReservation(state, command.reservationId)
    if (reservation.status !== 'arrived') throw new Error(`预约状态不能从${reservation.status}变为seated`)
    if (state.reservations.some((item) => item.id !== reservation.id && item.tableSessionId === command.tableSessionId)) {
      throw new Error('桌台会话已经绑定其他预约')
    }
    const previous = reservation.status
    reservation.status = 'seated'
    reservation.tableId = command.tableId
    reservation.tableCode = command.tableCode
    reservation.tableSessionId = command.tableSessionId
    reservation.seatedAt = command.occurredAt
    touch(reservation, command.occurredAt)
    audit(state, reservation, 'reservation.seated.v1', command.actorId, command.occurredAt, previous, reservation.deposit.status, null, {
      tableId: command.tableId,
      tableCode: command.tableCode,
      tableSessionId: command.tableSessionId,
    })
    return reservation
  })
}

export function cancelReservation(state: ReservationState, command: CancelReservationCommand) {
  assertAction(command)
  assertNonEmpty(command.reason, '取消原因')
  return executeIdempotent(state, command.idempotencyKey, 'reservation.cancel', command, command.reservationId, () => {
    const reservation = findReservation(state, command.reservationId)
    if (!['requested', 'confirmed', 'arrived'].includes(reservation.status)) throw new Error(`预约状态不能从${reservation.status}变为cancelled`)
    const previous = reservation.status
    const depositPrevious = reservation.deposit.status
    reservation.status = 'cancelled'
    reservation.cancelledAt = command.occurredAt
    reservation.cancellationReason = command.reason
    if (reservation.deposit.status === 'payment_confirmed') reservation.deposit.status = 'refund_required'
    touch(reservation, command.occurredAt)
    audit(state, reservation, 'reservation.cancelled.v1', command.actorId, command.occurredAt, previous, depositPrevious, command.reason)
    if (depositPrevious === 'payment_confirmed') {
      audit(state, reservation, 'reservation.deposit_refund_required.v1', command.actorId, command.occurredAt, reservation.status, depositPrevious, command.reason)
    }
    return reservation
  })
}

export function markReservationNoShow(state: ReservationState, command: MarkReservationNoShowCommand) {
  assertAction(command)
  assertNonEmpty(command.reason, '未到店原因')
  return executeIdempotent(state, command.idempotencyKey, 'reservation.no_show', command, command.reservationId, () => {
    const reservation = findReservation(state, command.reservationId)
    if (reservation.status !== 'confirmed') throw new Error(`预约状态不能从${reservation.status}变为no_show`)
    if (Date.parse(command.occurredAt) < Date.parse(reservation.scheduledAt)) throw new Error('预约时间未到，不能标记未到店')
    const previous = reservation.status
    reservation.status = 'no_show'
    reservation.noShowAt = command.occurredAt
    touch(reservation, command.occurredAt)
    audit(state, reservation, 'reservation.no_show.v1', command.actorId, command.occurredAt, previous, reservation.deposit.status, command.reason)
    return reservation
  })
}

export function startReservationDepositRefund(state: ReservationState, command: StartReservationDepositRefundCommand) {
  assertAction(command)
  assertNonEmpty(command.refundRequestReference, '退款请求引用')
  return executeIdempotent(state, command.idempotencyKey, 'reservation.deposit.start_refund', command, command.reservationId, () => {
    const reservation = findReservation(state, command.reservationId)
    if (!['cancelled', 'no_show'].includes(reservation.status)) throw new Error('只有已取消或未到店预约可以申请订金退款')
    if (reservation.deposit.status !== 'refund_required' && reservation.deposit.status !== 'refund_failed') {
      throw new Error('订金当前不处于待退款状态')
    }
    const previous = reservation.deposit.status
    reservation.deposit.status = 'refund_processing'
    reservation.deposit.refundRequestReference = command.refundRequestReference
    reservation.deposit.refundRequestedAt = command.occurredAt
    reservation.deposit.refundFailureReason = null
    touch(reservation, command.occurredAt)
    audit(state, reservation, 'reservation.deposit_refund_started.v1', command.actorId, command.occurredAt, reservation.status, previous, null, {
      refundRequestReference: command.refundRequestReference,
    })
    return reservation
  })
}

export function completeReservationDepositRefund(state: ReservationState, command: CompleteReservationDepositRefundCommand) {
  assertAction(command)
  assertNonEmpty(command.refundRequestReference, '退款请求引用')
  assertNonEmpty(command.refundConfirmationReference, '退款确认引用')
  assertMoney(command.refundedAmount, '退款确认金额')
  assertCurrency(command.currency)
  return executeIdempotent(state, command.idempotencyKey, 'reservation.deposit.complete_refund', command, command.reservationId, () => {
    const reservation = findReservation(state, command.reservationId)
    if (reservation.deposit.status !== 'refund_processing' || reservation.deposit.refundRequestReference !== command.refundRequestReference) {
      throw new Error('退款确认与退款请求不匹配')
    }
    if (reservation.deposit.requiredAmount !== command.refundedAmount || reservation.deposit.currency !== command.currency) {
      throw new Error('退款确认金额或币种不匹配')
    }
    const previous = reservation.deposit.status
    reservation.deposit.status = 'refunded'
    reservation.deposit.refundConfirmationReference = command.refundConfirmationReference
    reservation.deposit.refundedAt = command.occurredAt
    touch(reservation, command.occurredAt)
    audit(state, reservation, 'reservation.deposit_refunded.v1', command.actorId, command.occurredAt, reservation.status, previous, null, {
      refundConfirmationReference: command.refundConfirmationReference,
      refundedAmount: command.refundedAmount,
      currency: command.currency,
    })
    return reservation
  })
}

export function failReservationDepositRefund(state: ReservationState, command: FailReservationDepositRefundCommand) {
  assertAction(command)
  assertNonEmpty(command.refundRequestReference, '退款请求引用')
  assertNonEmpty(command.reason, '退款失败原因')
  return executeIdempotent(state, command.idempotencyKey, 'reservation.deposit.fail_refund', command, command.reservationId, () => {
    const reservation = findReservation(state, command.reservationId)
    if (reservation.deposit.status !== 'refund_processing' || reservation.deposit.refundRequestReference !== command.refundRequestReference) {
      throw new Error('退款失败通知与退款请求不匹配')
    }
    const previous = reservation.deposit.status
    reservation.deposit.status = 'refund_failed'
    reservation.deposit.refundFailureReason = command.reason
    touch(reservation, command.occurredAt)
    audit(state, reservation, 'reservation.deposit_refund_failed.v1', command.actorId, command.occurredAt, reservation.status, previous, command.reason, {
      refundRequestReference: command.refundRequestReference,
    })
    return reservation
  })
}
