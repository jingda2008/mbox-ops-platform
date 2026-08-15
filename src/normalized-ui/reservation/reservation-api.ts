import { classifyZone } from './reservation-model'
import type {
  BookingMode,
  PublicDailyPerformance,
  PublicReservation,
  PublicWaitlist,
  ReservationAvailability,
  ReservationIdentity,
  SeatPreference,
  ReservationTableStatus,
} from './types'

export class PublicReservationApiError extends Error {
  readonly code: string
  readonly status: number | null
  readonly retryAt: string | null
  readonly kind: 'aborted' | 'timeout' | 'network' | 'http' | 'invalid_response'

  constructor(
    message: string,
    code: string,
    status: number | null,
    retryAt: string | null = null,
    kind: 'aborted' | 'timeout' | 'network' | 'http' | 'invalid_response' = 'http',
  ) {
    super(message)
    this.name = 'PublicReservationApiError'
    this.code = code
    this.status = status
    this.retryAt = retryAt
    this.kind = kind
  }

  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'timeout' || this.status === 429 || (this.status ?? 0) >= 500
  }

  get sessionInvalid(): boolean {
    return this.status === 401 || this.code === 'RESERVATION_SESSION_INVALID'
  }

  get seatConflict(): boolean {
    return this.code === 'TABLE_ALREADY_RESERVED'
      || this.code === 'RESERVATION_HOLD_EXPIRED'
      || this.code === 'RESERVATION_CAPACITY_FULL'
  }
}

export interface PublicReservationApiOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  createIdempotencyKey?: () => string
}

export interface ReservationMutationInput {
  customerName: string
  guestCount: number
  arrivalAt: string
  expectedEndAt?: string
  note?: string | null
  seatPreference?: SeatPreference
}

export async function withReservationSessionRecovery<Value>(
  operation: () => Promise<Value>,
  renewSession: () => Promise<void>,
): Promise<Value> {
  try {
    return await operation()
  } catch (error) {
    if (!(error instanceof PublicReservationApiError) || !error.sessionInvalid) throw error
    await renewSession()
    return operation()
  }
}

export class PublicReservationApi {
  private readonly send: typeof fetch
  private readonly timeoutMs: number
  private readonly createKey: () => string
  private deviceFingerprint: string | null = null

  constructor(options: Readonly<PublicReservationApiOptions> = {}) {
    this.send = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = validTimeout(options.timeoutMs ?? 8_000)
    this.createKey = options.createIdempotencyKey ?? (() => globalThis.crypto.randomUUID())
  }

  async issueSession(identity: Readonly<ReservationIdentity>, signal?: AbortSignal): Promise<void> {
    this.deviceFingerprint = identity.deviceFingerprint
    await this.request('/api/public/reservation/session', {
      method: 'POST',
      body: identity,
      idempotent: true,
      signal,
    })
  }

  async availability(arrivalAt: string, guestCount: number, signal?: AbortSignal): Promise<ReservationAvailability> {
    const query = new URLSearchParams({ arrivalAt, guestCount: String(guestCount) })
    const body = await this.request(`/api/public/reservation/availability?${query}`, { method: 'GET', signal })
    return parseAvailability(dataOf(body))
  }

  async performance(date: string, signal?: AbortSignal): Promise<PublicDailyPerformance> {
    const query = new URLSearchParams({ date })
    const body = await this.request(`/api/public/reservation/performances?${query}`, { method: 'GET', signal })
    return parseDailyPerformance(dataOf(body))
  }

  async createReservation(
    mode: BookingMode,
    input: ReservationMutationInput & { contact: string },
    signal?: AbortSignal,
  ): Promise<PublicReservation> {
    const body = await this.request('/api/public/reservations', {
      method: 'POST',
      body: { mode, ...input },
      idempotent: true,
      signal,
    })
    return parseReservation(dataOf(body))
  }

  async getReservation(publicId: string, signal?: AbortSignal): Promise<PublicReservation> {
    const body = await this.request(`/api/public/reservations/${encodeURIComponent(publicId)}`, { method: 'GET', signal })
    return parseReservation(dataOf(body))
  }

  async updateReservation(publicId: string, input: ReservationMutationInput, signal?: AbortSignal): Promise<PublicReservation> {
    const body = await this.request(`/api/public/reservations/${encodeURIComponent(publicId)}`, {
      method: 'PATCH', body: input, idempotent: true, signal,
    })
    return parseReservation(dataOf(body))
  }

  async cancelReservation(publicId: string, signal?: AbortSignal): Promise<PublicReservation> {
    const body = await this.request(`/api/public/reservations/${encodeURIComponent(publicId)}`, {
      method: 'DELETE', idempotent: true, signal,
    })
    return parseReservation(dataOf(body))
  }

  async createWaitlist(input: {
    customerName: string
    contact: string
    guestCount: number
    desiredArrivalAt: string
    note?: string | null
  }, signal?: AbortSignal): Promise<PublicWaitlist> {
    const body = await this.request('/api/public/waitlist', {
      method: 'POST', body: input, idempotent: true, signal,
    })
    return parseWaitlist(dataOf(body))
  }

  async cancelWaitlist(publicId: string, signal?: AbortSignal): Promise<PublicWaitlist> {
    const body = await this.request(`/api/public/waitlist/${encodeURIComponent(publicId)}`, {
      method: 'DELETE', idempotent: true, signal,
    })
    return parseWaitlist(dataOf(body))
  }

  private async request(
    url: string,
    options: Readonly<{
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
      body?: unknown
      idempotent?: boolean
      signal?: AbortSignal
    }>,
  ): Promise<unknown> {
    const controller = new AbortController()
    let timedOut = false
    const abort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    const timer = globalThis.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    const headers = new Headers({ accept: 'application/json' })
    if (this.deviceFingerprint !== null) headers.set('x-mbox-guest-device', this.deviceFingerprint)
    if (options.body !== undefined) headers.set('content-type', 'application/json')
    if (options.idempotent === true) headers.set('idempotency-key', this.createKey())

    try {
      const response = await this.send(url, {
        method: options.method,
        credentials: 'include',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      })
      const payload = await readJson(response)
      if (!response.ok) throw parseError(response, payload)
      return payload
    } catch (error) {
      if (error instanceof PublicReservationApiError) throw error
      if (timedOut) throw new PublicReservationApiError('请求超时，请重试', 'REQUEST_TIMEOUT', null, null, 'timeout')
      if (options.signal?.aborted) throw new PublicReservationApiError('操作已取消', 'REQUEST_ABORTED', null, null, 'aborted')
      throw new PublicReservationApiError('网络连接失败，请检查网络后重试', 'NETWORK_ERROR', null, null, 'network')
    } finally {
      globalThis.clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }
}

function parseAvailability(value: unknown): ReservationAvailability {
  const record = object(value, '可订座位')
  const areasValue = array(record.areas, '区域')
  return {
    arrivalAt: text(record.arrivalAt, '到店时间'),
    expectedEndAt: text(record.expectedEndAt, '预计结束时间'),
    guestCount: integer(record.guestCount, '人数'),
    acceptingReservations: boolean(record.acceptingReservations, '预约名额状态'),
    depositRule: parseDepositRule(record.depositRule),
    areas: areasValue.map((areaValue) => {
      const area = object(areaValue, '区域')
      const areaBase = {
        code: text(area.code, '区域编号'),
        name: text(area.name, '区域名称'),
        type: text(area.type, '区域类型'),
      }
      return {
        ...areaBase,
        zone: classifyZone(areaBase),
        tables: array(area.tables, '桌位').map((tableValue) => {
          const table = object(tableValue, '桌位')
          return {
            code: text(table.code, '桌号'),
            name: text(table.name, '桌名'),
            capacity: integer(table.capacity, '桌位人数'),
            minimumSpendMinor: nullableInteger(table.minimumSpendMinor, '最低消费'),
            currency: text(table.currency, '币种'),
            status: tableStatus(table),
          }
        }),
      }
    }),
  }
}

function parseDailyPerformance(value: unknown): PublicDailyPerformance {
  const record = object(value, '演出信息')
  const phase = text(record.phase, '演出状态')
  if (!['no_schedule', 'upcoming', 'live', 'between', 'ended'].includes(phase)) invalid('演出状态')
  return {
    timezone: text(record.timezone, '时区'),
    localDate: text(record.localDate, '演出日期'),
    phase: phase as PublicDailyPerformance['phase'],
    current: record.current === null ? null : parsePerformanceSchedule(record.current),
    next: record.next === null ? null : parsePerformanceSchedule(record.next),
    startsInSeconds: nullableInteger(record.startsInSeconds, '距开演时间'),
    remainingSeconds: nullableInteger(record.remainingSeconds, '剩余演出时间'),
    schedules: array(record.schedules, '演出场次').map(parsePerformanceSchedule),
  }
}

function parsePerformanceSchedule(value: unknown): PublicDailyPerformance['schedules'][number] {
  const record = object(value, '演出场次')
  const status = text(record.status, '演出场次状态')
  if (!['scheduled', 'performing', 'completed', 'cancelled'].includes(status)) invalid('演出场次状态')
  return {
    id: text(record.id, '演出场次编号'),
    performerStageName: text(record.performerStageName, '演员名称'),
    performerProfile: parsePerformerProfile(record.performerProfile),
    startsAt: text(record.startsAt, '开始时间'),
    endsAt: text(record.endsAt, '结束时间'),
    status: status as PublicDailyPerformance['schedules'][number]['status'],
    sortOrder: integer(record.sortOrder, '演出排序'),
  }
}

function parsePerformerProfile(value: unknown): PublicDailyPerformance['schedules'][number]['performerProfile'] {
  const record = object(value, '演员资料')
  const profile: PublicDailyPerformance['schedules'][number]['performerProfile'] = {}
  if (typeof record.bio === 'string') profile.bio = record.bio
  if (typeof record.imageUrl === 'string') profile.imageUrl = record.imageUrl
  for (const key of ['genres', 'styles', 'highlights'] as const) {
    if (record[key] === undefined) continue
    const values = array(record[key], '演员标签')
    if (!values.every((item) => typeof item === 'string')) invalid('演员标签')
    profile[key] = values as string[]
  }
  return profile
}

function parseDepositRule(value: unknown): ReservationAvailability['depositRule'] {
  const rule = object(value, '定金规则')
  const mode = text(rule.mode, '定金模式')
  if (!['disabled', 'flat', 'minimum_spend_ratio'].includes(mode)) invalid('定金模式')
  return {
    enabled: boolean(rule.enabled, '定金状态'),
    mode: mode as ReservationAvailability['depositRule']['mode'],
    amountMinor: integer(rule.amountMinor, '定金金额'),
    ruleText: nullableText(rule.ruleText, '定金说明'),
  }
}

function parseReservation(value: unknown): PublicReservation {
  const record = object(value, '预约')
  const arrivalState = text(record.arrivalState, '到店状态')
  if (arrivalState !== 'arrived' && arrivalState !== 'not_arrived') invalid('到店状态')
  return {
    publicId: text(record.publicId, '预约编号'),
    customerName: text(record.customerName, '预约姓名'),
    maskedContact: text(record.maskedContact, '联系方式'),
    guestCount: integer(record.guestCount, '人数'),
    arrivalAt: text(record.arrivalAt, '到店时间'),
    expectedEndAt: text(record.expectedEndAt, '预计结束时间'),
    status: text(record.status, '预约状态'),
    arrivalState,
    note: nullableText(record.note, '备注'),
    seatPreference: seatPreference(record.seatPreference),
    arrivalGraceEndsAt: text(record.arrivalGraceEndsAt, '到店锁位截止时间'),
    cancellationPolicy: object(record.cancellationPolicy, '取消规则'),
  }
}

function seatPreference(value: unknown): SeatPreference {
  if (value === 'no_preference' || value === 'stage_atmosphere' || value === 'quiet_chat'
    || value === 'comfortable_booth' || value === 'outdoor_view') return value
  return 'no_preference'
}

function parseWaitlist(value: unknown): PublicWaitlist {
  const record = object(value, '候补')
  const arrivalState = text(record.arrivalState, '到店状态')
  if (arrivalState !== 'arrived' && arrivalState !== 'not_arrived') invalid('到店状态')
  return {
    publicId: text(record.publicId, '候补编号'),
    customerName: text(record.customerName, '候补姓名'),
    maskedContact: text(record.maskedContact, '联系方式'),
    guestCount: integer(record.guestCount, '人数'),
    desiredArrivalAt: text(record.desiredArrivalAt, '到店时间'),
    status: text(record.status, '候补状态'),
    arrivalState,
    note: nullableText(record.note, '备注'),
  }
}

function tableStatus(table: Record<string, unknown>): ReservationTableStatus {
  if (table.status === 'reserved' || table.status === 'locked' || table.status === 'available') return table.status
  return table.available === true ? 'available' : table.available === false ? 'reserved' : invalid('桌位状态')
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new PublicReservationApiError('服务返回内容无法读取，请重试', 'INVALID_RESPONSE', response.status, null, 'invalid_response')
  }
}

function parseError(response: Response, value: unknown): PublicReservationApiError {
  const root = isObject(value) ? value : {}
  const error = isObject(root.error) ? root.error : {}
  return new PublicReservationApiError(
    typeof error.message === 'string' ? error.message : '预约操作失败，请重试',
    typeof error.code === 'string' ? error.code : 'HTTP_ERROR',
    response.status,
    typeof error.retryAt === 'string' ? error.retryAt : null,
  )
}

function dataOf(value: unknown): unknown {
  const record = object(value, '响应')
  if (!('data' in record)) invalid('响应')
  return record.data
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) invalid(label)
  return value
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(label)
  return value
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(label)
  return value
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null) return null
  return text(value, label)
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) invalid(label)
  return Number(value)
}

function nullableInteger(value: unknown, label: string): number | null {
  if (value === null) return null
  return integer(value, label)
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(label)
  return value
}

function invalid(label: string): never {
  throw new PublicReservationApiError(`${label}数据无法识别，请刷新后重试`, 'INVALID_RESPONSE', null, null, 'invalid_response')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 120_000) throw new TypeError('timeoutMs配置无效')
  return value
}
