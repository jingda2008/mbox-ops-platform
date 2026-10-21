// Executable WeChat subscription copy is chosen here, then stored as typed rows.
// JSON in a draft command is only the edit payload, not the send-time source.

export const WECHAT_POINTS_CHANGE_TEMPLATE_ID = 'WWUaFeNQ-mHRkwMYhEKMl_WsZ3iGyoKKHdOGbtC209I'
export const WECHAT_POINTS_EXPIRY_TEMPLATE_ID = '1oGIa4-cFg9vXfoD3hYaSpYCRITsO4isvtX1N-7GHGI'

export const wechatNotificationValueSources = [
  'store_name',
  'granted_points',
  'deducted_points',
  'membership_card_points',
  'current_points',
  'balance_after',
  'points_change_text',
  'occurred_at',
  'expires_at',
  'account_label',
  'last_month_consumed_points',
  'month_expiring_points',
  'account_points_balance',
  'points_at_risk',
] as const

export type WechatNotificationValueSource = typeof wechatNotificationValueSources[number]
export type WechatLoyaltyNotificationType =
  | 'loyalty_points_credited'
  | 'loyalty_points_reversed'
  | 'loyalty_points_expiring'

export interface WechatNotificationFieldMapping {
  dataKey: string
  valueSource: WechatNotificationValueSource
}

export const wechatNotificationValueSourceLabels: Record<WechatNotificationValueSource, string> = {
  store_name: '商家名称',
  granted_points: '本次获赠积分，冲回时为 0',
  deducted_points: '本次扣除积分，到账时为 0',
  membership_card_points: '会员卡积分（这次变动后的账户可用积分）',
  current_points: '当前积分（这次变动后的账户可用积分）',
  balance_after: '变动后余额',
  points_change_text: '兼容旧文案，例如 +10积分',
  occurred_at: '事件发生时间',
  expires_at: '积分到期时间',
  account_label: '账户（会员昵称或姓名，中间打码）',
  last_month_consumed_points: '上月消费积分',
  month_expiring_points: '当月过期积分',
  account_points_balance: '账户积分余额',
  points_at_risk: '本批即将到期积分',
}

const balanceSources = [
  'store_name', 'granted_points', 'deducted_points', 'membership_card_points', 'current_points',
  'balance_after', 'points_change_text', 'occurred_at',
] as const satisfies readonly WechatNotificationValueSource[]

const expirySources = [
  'store_name', 'account_label', 'occurred_at', 'expires_at', 'points_change_text', 'points_at_risk',
  'last_month_consumed_points', 'month_expiring_points', 'account_points_balance',
] as const satisfies readonly WechatNotificationValueSource[]

const prefixes: Record<WechatNotificationValueSource, readonly string[]> = {
  store_name: ['thing', 'phrase', 'name', 'letter', 'character_string'],
  account_label: ['thing', 'phrase', 'name', 'letter', 'character_string'],
  points_change_text: ['thing', 'phrase', 'character_string'],
  granted_points: ['number'],
  deducted_points: ['number'],
  membership_card_points: ['number'],
  current_points: ['number'],
  balance_after: ['number'],
  occurred_at: ['time', 'date'],
  expires_at: ['time', 'date'],
  last_month_consumed_points: ['thing', 'phrase', 'number', 'character_string'],
  month_expiring_points: ['thing', 'phrase', 'number', 'character_string'],
  account_points_balance: ['thing', 'phrase', 'number', 'character_string'],
  points_at_risk: ['thing', 'phrase', 'number', 'character_string'],
}

export const wechatPointsChangeFieldMappings: readonly WechatNotificationFieldMapping[] = [
  { dataKey: 'thing5', valueSource: 'store_name' },
  { dataKey: 'number2', valueSource: 'granted_points' },
  { dataKey: 'number7', valueSource: 'membership_card_points' },
  { dataKey: 'number3', valueSource: 'deducted_points' },
  { dataKey: 'number4', valueSource: 'current_points' },
]

export const wechatPointsExpiryFieldMappings: readonly WechatNotificationFieldMapping[] = [
  { dataKey: 'thing1', valueSource: 'account_label' },
  { dataKey: 'time2', valueSource: 'expires_at' },
  { dataKey: 'thing3', valueSource: 'last_month_consumed_points' },
  { dataKey: 'thing4', valueSource: 'month_expiring_points' },
  { dataKey: 'thing5', valueSource: 'account_points_balance' },
]

const dataKeyPattern = /^[a-z][a-z0-9_]{1,31}$/

export interface WechatLoyaltyTemplateFacts {
  notificationType: WechatLoyaltyNotificationType
  pointsChange: number
  pointsAtRisk: number
  balanceAfter: number | null
  eventOccurredAt: string
  expiresAt: string | null
  storeName?: string | null
  accountDisplayName?: string | null
  memberNo?: string | null
  lastMonthConsumedPoints?: number | null
  monthExpiringPoints?: number | null
  accountPointsBalance?: number | null
  storeTimeZone?: string | null
}

export interface WechatPointsNotificationPreset {
  domain: 'wechat_notifications'
  notificationType: WechatLoyaltyNotificationType
  authorizationPurpose: 'loyalty_balance_change' | 'loyalty_expiry_reminder'
  authorizationContext: 'loyalty_accrual' | 'loyalty_refund' | 'loyalty_expiry'
  templateId: string
  pagePath: string
  pointsDataKey: string
  balanceDataKey: string | null
  occurredAtDataKey: string
  expiresAtDataKey: string | null
  expiryLeadDays: number | null
  maxPerCustomerPer24h: number
  minimumIntervalMinutes: number
  quietHoursStart: null
  quietHoursEnd: null
  fieldMappings: WechatNotificationFieldMapping[]
}

export function wechatPointsNotificationPreset(
  notificationType: WechatLoyaltyNotificationType,
): WechatPointsNotificationPreset {
  const shared = {
    domain: 'wechat_notifications' as const,
    pagePath: 'pages/points/index',
    maxPerCustomerPer24h: 3,
    minimumIntervalMinutes: 10,
    quietHoursStart: null,
    quietHoursEnd: null,
  }
  if (notificationType === 'loyalty_points_expiring') {
    return {
      ...shared,
      notificationType,
      authorizationPurpose: 'loyalty_expiry_reminder',
      authorizationContext: 'loyalty_expiry',
      templateId: WECHAT_POINTS_EXPIRY_TEMPLATE_ID,
      pointsDataKey: 'thing4',
      balanceDataKey: null,
      occurredAtDataKey: 'time2',
      expiresAtDataKey: 'time2',
      expiryLeadDays: 7,
      fieldMappings: wechatPointsExpiryFieldMappings.map((field) => ({ ...field })),
    }
  }
  return {
    ...shared,
    notificationType,
    authorizationPurpose: 'loyalty_balance_change',
    authorizationContext: notificationType === 'loyalty_points_credited' ? 'loyalty_accrual' : 'loyalty_refund',
    templateId: WECHAT_POINTS_CHANGE_TEMPLATE_ID,
    // time9 is stored only so the original occurred-at column stays valid.
    // It is not one of the template keywords, and mapped sends omit it.
    pointsDataKey: 'number2',
    balanceDataKey: 'number4',
    occurredAtDataKey: 'time9',
    expiresAtDataKey: null,
    expiryLeadDays: null,
    fieldMappings: wechatPointsChangeFieldMappings.map((field) => ({ ...field })),
  }
}

export function wechatValueSourcesFor(
  notificationType: WechatLoyaltyNotificationType,
): readonly WechatNotificationValueSource[] {
  return notificationType === 'loyalty_points_expiring' ? expirySources : balanceSources
}

export function wechatNotificationFieldMappingError(input: Readonly<{
  notificationType: WechatLoyaltyNotificationType
  templateId: string
  fieldMappings?: readonly WechatNotificationFieldMapping[] | null
}>): string | null {
  const mappings = input.fieldMappings ?? []
  if (input.templateId === WECHAT_POINTS_CHANGE_TEMPLATE_ID) {
    if (input.notificationType === 'loyalty_points_expiring') return '会员卡积分变动模板只能用于积分到账或积分冲回'
    if (!sameMappings(mappings, wechatPointsChangeFieldMappings)) {
      return '会员卡积分变动模板必须映射商家名称、获赠积分、会员卡积分、扣除积分和当前积分'
    }
    return null
  }
  if (input.templateId === WECHAT_POINTS_EXPIRY_TEMPLATE_ID) {
    if (input.notificationType !== 'loyalty_points_expiring') return '会员积分过期模板只能用于积分到期'
    if (!sameMappings(mappings, wechatPointsExpiryFieldMappings)) {
      return '会员积分过期模板必须映射账户、到期时间、上月消费积分、当月过期积分和账户积分余额'
    }
    return null
  }
  if (mappings.length === 0) return null
  if (mappings.length > 10) return '微信模板字段不能超过 10 个'
  if (new Set(mappings.map((field) => field.dataKey)).size !== mappings.length) return '微信字段名不能重复'
  if (new Set(mappings.map((field) => field.valueSource)).size !== mappings.length) return '同一个取值来源不能映射两次'
  const allowed = new Set<string>(input.notificationType === 'loyalty_points_expiring' ? expirySources : balanceSources)
  for (const field of mappings) {
    if (!dataKeyPattern.test(field.dataKey)) return '微信字段名无效'
    if (!allowed.has(field.valueSource)) return '取值来源与通知类型不匹配'
    const keyPrefix = wechatDataKeyPrefix(field.dataKey)
    if (!prefixes[field.valueSource].includes(keyPrefix)) return '取值来源与微信字段类型不匹配'
  }
  return null
}

export function buildWechatLoyaltyTemplateData(
  mappings: readonly WechatNotificationFieldMapping[],
  facts: Readonly<WechatLoyaltyTemplateFacts>,
): Record<string, string> {
  if (mappings.length < 1 || mappings.length > 10) throw new TypeError('template field mappings are invalid')
  const data: Record<string, string> = {}
  for (const field of mappings) {
    if (!dataKeyPattern.test(field.dataKey) || data[field.dataKey] !== undefined) {
      throw new TypeError('template data key is invalid')
    }
    data[field.dataKey] = renderField(field, facts)
  }
  return data
}

export function maskAccountLabel(displayName: string | null | undefined, memberNo: string | null | undefined): string {
  const name = (displayName ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  const characters = [...name]
  if (characters.length === 1) return characters[0] ?? '会员'
  if (characters.length === 2) return `${characters[0]}*`
  if (characters.length > 2) {
    const masked = `${characters[0]}${'*'.repeat(Math.min(3, characters.length - 2))}${characters[characters.length - 1]}`
    return [...masked].slice(0, 20).join('')
  }
  const tail = (memberNo ?? '').replace(/[^0-9A-Za-z]/g, '').slice(-4)
  return tail ? `会员****${tail}` : '会员'
}

function renderField(
  field: Readonly<WechatNotificationFieldMapping>,
  facts: Readonly<WechatLoyaltyTemplateFacts>,
): string {
  switch (field.valueSource) {
    case 'store_name':
      return thingText(facts.storeName ?? '', '本店')
    case 'account_label':
      return thingText(maskAccountLabel(facts.accountDisplayName, facts.memberNo), '会员')
    case 'granted_points':
      return numberText(facts.notificationType === 'loyalty_points_credited' ? facts.pointsChange : 0)
    case 'deducted_points':
      return numberText(facts.notificationType === 'loyalty_points_reversed' ? Math.abs(facts.pointsChange) : 0)
    case 'membership_card_points':
    case 'current_points':
    case 'balance_after':
      return numberText(requiredBalance(facts.balanceAfter))
    case 'points_at_risk':
      return pointAmount(facts.pointsAtRisk, field.dataKey)
    case 'last_month_consumed_points':
      return pointAmount(facts.lastMonthConsumedPoints ?? 0, field.dataKey)
    case 'month_expiring_points':
      return pointAmount(facts.monthExpiringPoints ?? 0, field.dataKey)
    case 'account_points_balance':
      return pointAmount(facts.accountPointsBalance ?? 0, field.dataKey)
    case 'points_change_text':
      return thingText(legacyPointsText(facts), '0积分')
    case 'occurred_at':
      return wechatTime(facts.eventOccurredAt, facts.storeTimeZone, field.dataKey)
    case 'expires_at':
      if (facts.expiresAt === null) throw new TypeError('expiresAt is required')
      return wechatTime(facts.expiresAt, facts.storeTimeZone, field.dataKey)
    default: {
      const unknown: never = field.valueSource
      throw new TypeError(`template value source is invalid: ${unknown}`)
    }
  }
}

function requiredBalance(value: number | null): number {
  if (value === null) throw new TypeError('balanceAfter is required')
  return value
}

function pointAmount(value: number, dataKey: string): string {
  const amount = numberText(value)
  if (wechatDataKeyPrefix(dataKey) === 'number') return amount
  const text = `${amount}分`
  if ([...text].length > 20) throw new TypeError('template point text is too long')
  return text
}

function legacyPointsText(facts: Readonly<WechatLoyaltyTemplateFacts>): string {
  if (facts.notificationType === 'loyalty_points_expiring') return `${facts.pointsAtRisk}积分`
  return `${facts.pointsChange > 0 ? '+' : ''}${facts.pointsChange}积分`
}

function numberText(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('template number value is invalid')
  const text = String(value)
  if (!/^\d{1,32}$/.test(text)) throw new TypeError('template number value is invalid')
  return text
}

function thingText(value: string, fallback: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
  const text = [...(cleaned || fallback)].slice(0, 20).join('')
  if (!text.trim()) throw new TypeError('template text is empty')
  return text
}

function wechatTime(value: string, timeZone: string | null | undefined, dataKey: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('template time is invalid')
  const zone = safeTimeZone(timeZone)
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ''
  const year = part('year')
  const month = Number(part('month'))
  const day = Number(part('day'))
  if (!year || !Number.isInteger(month) || !Number.isInteger(day)) throw new TypeError('template time is invalid')
  const dateText = `${year}年${month}月${day}日`
  if (wechatDataKeyPrefix(dataKey) === 'date') return dateText
  return `${dateText} ${part('hour')}:${part('minute')}`
}

function safeTimeZone(value: string | null | undefined): string {
  const zone = value?.trim() || 'Asia/Shanghai'
  try {
    Intl.DateTimeFormat('zh-CN', { timeZone: zone }).format(0)
    return zone
  } catch {
    return 'Asia/Shanghai'
  }
}

function wechatDataKeyPrefix(dataKey: string): string {
  return (/^[a-z_]+/.exec(dataKey)?.[0] ?? '').replace(/_+$/, '')
}

function sameMappings(
  actual: readonly WechatNotificationFieldMapping[],
  expected: readonly WechatNotificationFieldMapping[],
): boolean {
  if (actual.length !== expected.length) return false
  const left = [...actual].sort((a, b) => a.dataKey.localeCompare(b.dataKey))
  const right = [...expected].sort((a, b) => a.dataKey.localeCompare(b.dataKey))
  return left.every((field, index) => field.dataKey === right[index]?.dataKey && field.valueSource === right[index]?.valueSource)
}
