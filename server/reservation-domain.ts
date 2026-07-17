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
  UpdateReservationCommand,
  DecideLateReservationHoldCommand,
} from '../src/shared/reservation-contracts.js'
import { CHINA_TIME_ZONE } from '../src/shared/china-time.js'

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
  lateHoldMinutes: 30,
  waitlistResponseMinutes: 10,
  businessHours: {
    timeZone: 'Asia/Shanghai',
    openingTime: '12:00',
    closingTime: '02:00',
    slotMinutes: 30,
    closedWeekdays: [],
  },
  capacity: {
    defaultDailyCapacity: 120,
    defaultSlotCapacity: 20,
    dateOverrides: [],
  },
  publicRules: {
    minimumLeadMinutes: 15,
    maximumAdvanceDays: 180,
    duplicateWindowMinutes: 60,
    acceptedContactMethods: ['phone', 'wechat'],
    createRateLimit: { limit: 5, windowMinutes: 10 },
  },
}

export function normalizeReservationConfig(config: ReservationConfig): ReservationConfig {
  const candidate = config as Partial<ReservationConfig>
  return {
    ...DEFAULT_RESERVATION_CONFIG,
    ...config,
    businessHours: {
      ...DEFAULT_RESERVATION_CONFIG.businessHours,
      ...(candidate.businessHours ?? {}),
      closedWeekdays: [...(candidate.businessHours?.closedWeekdays ?? DEFAULT_RESERVATION_CONFIG.businessHours.closedWeekdays)],
    },
    capacity: {
      ...DEFAULT_RESERVATION_CONFIG.capacity,
      ...(candidate.capacity ?? {}),
      dateOverrides: (candidate.capacity?.dateOverrides ?? DEFAULT_RESERVATION_CONFIG.capacity.dateOverrides).map((item) => ({
        ...item,
        slotCapacities: item.slotCapacities.map((slot) => ({ ...slot })),
      })),
    },
    publicRules: {
      ...DEFAULT_RESERVATION_CONFIG.publicRules,
      ...(candidate.publicRules ?? {}),
      acceptedContactMethods: [...(candidate.publicRules?.acceptedContactMethods ?? DEFAULT_RESERVATION_CONFIG.publicRules.acceptedContactMethods)],
      createRateLimit: {
        ...DEFAULT_RESERVATION_CONFIG.publicRules.createRateLimit,
        ...(candidate.publicRules?.createRateLimit ?? {}),
      },
    },
  }
}

export function createReservationState(
  scope: ReservationScope,
  config: ReservationConfig = DEFAULT_RESERVATION_CONFIG,
): ReservationState {
  assertNonEmpty(scope.tenantId, '租户ID')
  assertNonEmpty(scope.storeId, '门店ID')
  const normalizedConfig = normalizeReservationConfig(config)
  validateConfig(normalizedConfig)
  return {
    ...scope,
    config: structuredClone(normalizedConfig),
    reservations: [],
    auditEvents: [],
    idempotencyRecords: [],
  }
}

export function updateReservationConfig(state: ReservationState, config: ReservationConfig) {
  const normalizedConfig = normalizeReservationConfig({
    ...state.config,
    ...config,
    businessHours: config.businessHours ?? state.config.businessHours,
    capacity: config.capacity ?? state.config.capacity,
    publicRules: config.publicRules ?? state.config.publicRules,
  })
  validateConfig(normalizedConfig)
  if (normalizedConfig.version <= state.config.version) throw new Error('预约配置版本必须高于当前版本')
  state.config = structuredClone(normalizedConfig)
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
  if (!Number.isSafeInteger(config.lateHoldMinutes) || config.lateHoldMinutes < 0 || config.lateHoldMinutes > 240) {
    throw new Error('预约迟到保留分钟数不合法')
  }
  if (!Number.isSafeInteger(config.waitlistResponseMinutes) || config.waitlistResponseMinutes < 1 || config.waitlistResponseMinutes > 120) {
    throw new Error('候补响应分钟数不合法')
  }
  validateTimeZone(config.businessHours.timeZone)
  if (config.businessHours.timeZone !== CHINA_TIME_ZONE) throw new Error('M-BOX陆家嘴预约时区必须使用Asia/Shanghai（北京时间）')
  const openingMinutes = parseClock(config.businessHours.openingTime, '营业开始时间')
  const closingMinutes = parseClock(config.businessHours.closingTime, '营业结束时间')
  if (openingMinutes === closingMinutes) throw new Error('营业开始和结束时间不能相同')
  if (!Number.isSafeInteger(config.businessHours.slotMinutes) || config.businessHours.slotMinutes < 5 || config.businessHours.slotMinutes > 240) {
    throw new Error('预约时段分钟数必须在5至240之间')
  }
  if (new Set(config.businessHours.closedWeekdays).size !== config.businessHours.closedWeekdays.length
    || config.businessHours.closedWeekdays.some((day) => !Number.isSafeInteger(day) || day < 0 || day > 6)) {
    throw new Error('每周闭店日期配置不合法')
  }
  if (!Number.isSafeInteger(config.capacity.defaultDailyCapacity) || config.capacity.defaultDailyCapacity < 1 || config.capacity.defaultDailyCapacity > 10_000) {
    throw new Error('营业日预约容量必须在1至10000之间')
  }
  if (!Number.isSafeInteger(config.capacity.defaultSlotCapacity) || config.capacity.defaultSlotCapacity < 1 || config.capacity.defaultSlotCapacity > 1_000) {
    throw new Error('时段预约容量必须在1至1000之间')
  }
  const overrideDates = config.capacity.dateOverrides.map((item) => item.date)
  if (new Set(overrideDates).size !== overrideDates.length) throw new Error('指定日期容量不能重复')
  for (const override of config.capacity.dateOverrides) {
    assertDate(override.date, '指定营业日期')
    if (!Number.isSafeInteger(override.totalCapacity) || override.totalCapacity < 0 || override.totalCapacity > 10_000) {
      throw new Error('指定日期预约容量必须在0至10000之间')
    }
    if (override.enabled && override.totalCapacity < 1) throw new Error('营业日期的预约容量至少为1')
    const slotTimes = override.slotCapacities.map((item) => item.time)
    if (new Set(slotTimes).size !== slotTimes.length) throw new Error('指定日期时段容量不能重复')
    for (const slot of override.slotCapacities) {
      parseClock(slot.time, '指定时段')
      if (!Number.isSafeInteger(slot.capacity) || slot.capacity < 0 || slot.capacity > 1_000) {
        throw new Error('指定时段预约容量必须在0至1000之间')
      }
    }
  }
  if (!Number.isSafeInteger(config.publicRules.minimumLeadMinutes) || config.publicRules.minimumLeadMinutes < 0 || config.publicRules.minimumLeadMinutes > 10_080) {
    throw new Error('预约提前分钟数必须在0至10080之间')
  }
  if (!Number.isSafeInteger(config.publicRules.maximumAdvanceDays) || config.publicRules.maximumAdvanceDays < 1 || config.publicRules.maximumAdvanceDays > 730) {
    throw new Error('最远预约天数必须在1至730之间')
  }
  if (!Number.isSafeInteger(config.publicRules.duplicateWindowMinutes) || config.publicRules.duplicateWindowMinutes < 0 || config.publicRules.duplicateWindowMinutes > 1_440) {
    throw new Error('防重复时间窗口必须在0至1440分钟之间')
  }
  if (config.publicRules.acceptedContactMethods.length < 1
    || new Set(config.publicRules.acceptedContactMethods).size !== config.publicRules.acceptedContactMethods.length
    || config.publicRules.acceptedContactMethods.some((method) => !['phone', 'wechat'].includes(method))) {
    throw new Error('至少需要启用一种公开预约联系方式')
  }
  if (!Number.isSafeInteger(config.publicRules.createRateLimit.limit) || config.publicRules.createRateLimit.limit < 1 || config.publicRules.createRateLimit.limit > 100) {
    throw new Error('公开预约创建限流次数必须在1至100之间')
  }
  if (!Number.isSafeInteger(config.publicRules.createRateLimit.windowMinutes) || config.publicRules.createRateLimit.windowMinutes < 1 || config.publicRules.createRateLimit.windowMinutes > 1_440) {
    throw new Error('公开预约限流窗口必须在1至1440分钟之间')
  }
  for (const collection of [config.sources, config.areaPreferences, config.occasions]) {
    const codes = collection.map((item) => item.code)
    if (new Set(codes).size !== codes.length) throw new Error('预约配置代码不能重复')
    collection.forEach((item) => assertNonEmpty(item.code, '预约配置代码'))
  }
}

function parseClock(value: string, label: string) {
  if (!/^\d{2}:\d{2}$/.test(value)) throw new Error(`${label}必须使用HH:mm格式`)
  const [hour, minute] = value.split(':').map(Number)
  if (hour === undefined || minute === undefined || hour > 23 || minute > 59) throw new Error(`${label}不合法`)
  return hour * 60 + minute
}

function assertDate(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`${label}必须使用YYYY-MM-DD格式`)
  }
}

function validateTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
  } catch {
    throw new Error('预约营业时区不合法')
  }
}

function zonedParts(timestamp: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp))
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  const date = `${value('year')}-${value('month')}-${value('day')}`
  return { date, minutes: Number(value('hour')) * 60 + Number(value('minute')) }
}

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function weekday(date: string) {
  return new Date(`${date}T12:00:00.000Z`).getUTCDay()
}

function businessSlot(config: ReservationConfig, scheduledAt: string) {
  assertTimestamp(scheduledAt, '预约时间')
  const local = zonedParts(scheduledAt, config.businessHours.timeZone)
  const opening = parseClock(config.businessHours.openingTime, '营业开始时间')
  const closing = parseClock(config.businessHours.closingTime, '营业结束时间')
  const crossesMidnight = closing < opening
  const inHours = crossesMidnight
    ? local.minutes >= opening || local.minutes < closing
    : local.minutes >= opening && local.minutes < closing
  if (!inHours) throw new Error(`可预约时间为${config.businessHours.openingTime}至${crossesMidnight ? '次日' : ''}${config.businessHours.closingTime}`)
  const businessDate = crossesMidnight && local.minutes < closing ? shiftDate(local.date, -1) : local.date
  if (config.businessHours.closedWeekdays.includes(weekday(businessDate))) throw new Error('所选日期暂停接受预约')
  const elapsed = local.minutes >= opening ? local.minutes - opening : 1_440 - opening + local.minutes
  if (elapsed % config.businessHours.slotMinutes !== 0) {
    throw new Error(`预约时间需按${config.businessHours.slotMinutes}分钟时段选择`)
  }
  const slotTime = `${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')}`
  return { businessDate, slotTime }
}

function contactIdentities(value: string) {
  const identities = value.split('|').map((item) => item.trim().toLocaleLowerCase('en-US')).filter(Boolean)
  return identities.length > 0 ? identities : [value.trim().toLocaleLowerCase('en-US')]
}

export function assertPublicReservationAvailability(state: ReservationState, input: {
  scheduledAt: string
  occurredAt: string
  contactReference: string
  excludeReservationId?: string
}) {
  const config = normalizeReservationConfig(state.config)
  const scheduledAt = Date.parse(input.scheduledAt)
  const occurredAt = Date.parse(input.occurredAt)
  if (!Number.isFinite(scheduledAt) || !Number.isFinite(occurredAt)) throw new Error('预约时间无效')
  const minimum = occurredAt + config.publicRules.minimumLeadMinutes * 60_000
  const maximum = occurredAt + config.publicRules.maximumAdvanceDays * 24 * 60 * 60_000
  if (scheduledAt < minimum || scheduledAt > maximum) {
    throw new Error(`请至少提前${config.publicRules.minimumLeadMinutes}分钟预约，最远可预约未来${config.publicRules.maximumAdvanceDays}天`)
  }
  const target = businessSlot(config, input.scheduledAt)
  const dateOverride = config.capacity.dateOverrides.find((item) => item.date === target.businessDate)
  if (dateOverride && !dateOverride.enabled) throw new Error('所选日期暂停接受预约，换一天再来吧')
  const active = state.reservations.filter((reservation) =>
    reservation.id !== input.excludeReservationId && !['cancelled', 'no_show'].includes(reservation.status),
  )
  const identities = new Set(contactIdentities(input.contactReference))
  const duplicateWindowMs = config.publicRules.duplicateWindowMinutes * 60_000
  const duplicate = active.find((reservation) =>
    contactIdentities(reservation.contactReference).some((identity) => identities.has(identity))
    && Math.abs(Date.parse(reservation.scheduledAt) - scheduledAt) <= duplicateWindowMs,
  )
  if (duplicate) throw new Error('这个联系方式在相近时间已经有预约啦，可以在“我的预约”里修改')

  const placed = active.flatMap((reservation) => {
    try { return [{ reservation, slot: businessSlot(config, reservation.scheduledAt) }] } catch { return [] }
  })
  const dailyCount = placed.filter((item) => item.slot.businessDate === target.businessDate).length
  const dailyCapacity = dateOverride?.totalCapacity ?? config.capacity.defaultDailyCapacity
  if (dailyCount >= dailyCapacity) throw new Error('这一天的预约已经满啦，换一天看看吧')
  const slotCount = placed.filter((item) => item.slot.businessDate === target.businessDate && item.slot.slotTime === target.slotTime).length
  const slotCapacity = dateOverride?.slotCapacities.find((item) => item.time === target.slotTime)?.capacity
    ?? config.capacity.defaultSlotCapacity
  if (slotCount >= slotCapacity) throw new Error('这个时段已经约满啦，换个时间更从容')
  return target
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
      expectedArrivalAt: null,
      lateContactReference: null,
      holdStatus: 'none',
      holdUntil: null,
      holdDecidedBy: null,
      holdDecidedAt: null,
      holdReason: null,
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

export function updateReservationDetails(state: ReservationState, command: UpdateReservationCommand) {
  assertAction(command)
  assertTimestamp(command.scheduledAt, '预约时间')
  assertNonEmpty(command.reason, '修改原因')
  if (command.customerName !== undefined) assertNonEmpty(command.customerName, '顾客称呼')
  if (command.contactReference !== undefined) assertNonEmpty(command.contactReference, '联系方式引用')
  if (!Number.isSafeInteger(command.partySize) || command.partySize < state.config.minimumPartySize || command.partySize > state.config.maximumPartySize) {
    throw new Error(`预约人数必须在${state.config.minimumPartySize}至${state.config.maximumPartySize}之间`)
  }
  if (command.areaPreferenceCode && !state.config.areaPreferences.some((item) => item.code === command.areaPreferenceCode && item.enabled)) {
    throw new Error('区域偏好未配置或已停用')
  }
  if (command.occasionCode && !state.config.occasions.some((item) => item.code === command.occasionCode && item.enabled)) {
    throw new Error('特殊场景未配置或已停用')
  }
  return executeIdempotent(state, command.idempotencyKey, 'reservation.update_details', command, command.reservationId, () => {
    const reservation = findReservation(state, command.reservationId)
    if (!['requested', 'confirmed', 'arrived'].includes(reservation.status)) throw new Error('已入座或已结束预约不能修改人数和时间')
    const before = {
      customerName: reservation.customerName,
      contactReference: reservation.contactReference,
      partySize: reservation.partySize,
      scheduledAt: reservation.scheduledAt,
      areaPreferenceCode: reservation.areaPreferenceCode,
      occasionCode: reservation.occasionCode,
      occasionNote: reservation.occasionNote,
    }
    if (command.customerName !== undefined) reservation.customerName = command.customerName.trim()
    if (command.contactReference !== undefined) reservation.contactReference = command.contactReference.trim()
    reservation.partySize = command.partySize
    reservation.scheduledAt = command.scheduledAt
    reservation.areaPreferenceCode = command.areaPreferenceCode?.trim() || null
    if (command.occasionCode !== undefined) reservation.occasionCode = command.occasionCode
    if (command.occasionNote !== undefined) reservation.occasionNote = command.occasionNote.trim()
    touch(reservation, command.occurredAt)
    audit(state, reservation, 'reservation.details_updated.v1', command.actorId, command.occurredAt, reservation.status, reservation.deposit.status, command.reason, {
      beforePartySize: before.partySize,
      afterPartySize: reservation.partySize,
      contactChanged: before.contactReference !== reservation.contactReference,
      customerNameChanged: before.customerName !== reservation.customerName,
      beforeScheduledAt: before.scheduledAt,
      afterScheduledAt: reservation.scheduledAt,
      beforeAreaPreferenceCode: before.areaPreferenceCode,
      afterAreaPreferenceCode: reservation.areaPreferenceCode,
      beforeOccasionCode: before.occasionCode,
      afterOccasionCode: reservation.occasionCode,
      occasionNoteChanged: before.occasionNote !== reservation.occasionNote,
    })
    return reservation
  })
}

export function decideLateReservationHold(state: ReservationState, command: DecideLateReservationHoldCommand) {
  assertAction(command)
  assertTimestamp(command.expectedArrivalAt, '预计到店时间')
  assertNonEmpty(command.contactReference, '联系记录')
  assertNonEmpty(command.reason, '决定原因')
  return executeIdempotent(state, command.idempotencyKey, 'reservation.decide_late_hold', command, command.reservationId, () => {
    const reservation = findReservation(state, command.reservationId)
    if (reservation.status !== 'confirmed') throw new Error('只有已确认且未到店预约可以处理迟到保留')
    if (Date.parse(command.expectedArrivalAt) < Date.parse(reservation.scheduledAt)) throw new Error('预计到店时间不能早于预约时间')
    reservation.expectedArrivalAt = command.expectedArrivalAt
    reservation.lateContactReference = command.contactReference
    reservation.holdStatus = command.decision === 'hold' ? 'held' : 'released'
    reservation.holdUntil = command.decision === 'hold'
      ? new Date(Date.parse(command.expectedArrivalAt) + state.config.lateHoldMinutes * 60_000).toISOString()
      : null
    reservation.holdDecidedBy = command.actorId
    reservation.holdDecidedAt = command.occurredAt
    reservation.holdReason = command.reason
    touch(reservation, command.occurredAt)
    audit(state, reservation, 'reservation.late_hold_decided.v1', command.actorId, command.occurredAt, reservation.status, reservation.deposit.status, command.reason, {
      decision: command.decision,
      expectedArrivalAt: command.expectedArrivalAt,
      contactReference: command.contactReference,
      holdUntil: reservation.holdUntil,
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
