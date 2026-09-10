import { createHash } from 'node:crypto'
import type { ScopedTransaction } from './transaction-runner.js'
import { appendAuditEvent } from './command-executor.js'
import { parseCouponCalendarRule, previewCouponCalendar, couponIssuanceValidity, CouponCalendarError } from './coupon-calendar.js'
import { StaffAccessRepository } from './staff-access-repository.js'

export class CouponCalendarConflictError extends Error {}
export interface CouponUsageLimits { perCustomerDay: number | null; perCustomerWeek: number | null; perCustomerCampaign: number | null }
export interface CouponCalendarWalletView {
  available: boolean; nextAvailableAt: string | null; lastAvailableUntil: string | null
  summary: string; limits: CouponUsageLimits
}
interface Row extends Record<string, unknown> {
  id: string; code: string; version: number; timezone: string; date_basis: string; business_day_start_minute: number
  date_from: string; date_through: string; valid_from: string; valid_until: string; weekdays: number[]; week_starts_on: number
  per_customer_day_limit: number | null; per_customer_week_limit: number | null; per_customer_campaign_limit: number | null
  created_by_employee_id: string; request_fingerprint: string
  relative_validity_days: number|null; relative_validity_basis: string|null
}
function limits(value: unknown): CouponUsageLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CouponCalendarError('须分别配置日、周和活动总次数，空值表示不额外限制')
  const input = value as Record<string, unknown>
  const result: CouponUsageLimits = { perCustomerDay: null, perCustomerWeek: null, perCustomerCampaign: null }
  for (const key of Object.keys(result) as Array<keyof CouponUsageLimits>) {
    const item = input[key]
    if (item !== null && (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1 || item > 1_000_000)) throw new CouponCalendarError('次数限制必须是1至1000000的整数或明确空值')
    result[key] = item as number | null
  }
  return result
}
function reason(value: string) { if (typeof value !== 'string' || value.trim().length < 2 || value.length > 500) throw new CouponCalendarError('请填写2至500字的操作原因') }
function id(value: string) { if (typeof value !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) throw new CouponCalendarError('规则版本编号无效') }
const columns = 'id,code,version,timezone,date_basis,business_day_start_minute,date_from::text,date_through::text,valid_from::text,valid_until::text,weekdays,week_starts_on,per_customer_day_limit,per_customer_week_limit,per_customer_campaign_limit,created_by_employee_id,request_fingerprint,relative_validity_days,relative_validity_basis'

export class CouponCalendarRepository {
  constructor(private readonly transaction: ScopedTransaction) {}
  private get scope() { return [this.transaction.scope.tenantId, this.transaction.scope.storeId] }
  private lock(key: string) { return this.transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`coupon-calendar:${this.scope.join(':')}:${key}`]) }
  async find(versionId: string) {
    id(versionId)
    const result = await this.transaction.query<Row>(`SELECT ${columns} FROM mbox.coupon_calendar_versions WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...this.scope, versionId])
    if (!result.rows.length) throw new CouponCalendarError('规则版本不存在或不属于当前门店')
    return (await this.hydrate(result.rows))[0]!
  }
  private async hydrate(rows: Row[]) {
    if (!rows.length) return []
    const ids = rows.map(row => row.id)
    // Batch each child relation. Do not issue four round trips for every card
    // in a wallet, or run concurrent queries on the same transaction client.
    const windows = await this.transaction.query<{ version_id: string; start_minute: number; end_minute: number }>('SELECT version_id,start_minute,end_minute FROM mbox.coupon_calendar_windows WHERE tenant_id=$1 AND store_id=$2 AND version_id=ANY($3::uuid[]) ORDER BY version_id,position', [...this.scope, ids])
    const exclusions = await this.transaction.query<{ version_id: string; excluded_date: string }>('SELECT version_id,excluded_date::text FROM mbox.coupon_calendar_exclusions WHERE tenant_id=$1 AND store_id=$2 AND version_id=ANY($3::uuid[]) ORDER BY version_id,excluded_date', [...this.scope, ids])
    const decisions = await this.transaction.query<{ version_id: string; action: string; employee_id: string }>('SELECT version_id,action,employee_id FROM mbox.coupon_calendar_decisions WHERE tenant_id=$1 AND store_id=$2 AND version_id=ANY($3::uuid[])', [...this.scope, ids])
    return rows.map(row => {
      const rowDecisions = decisions.rows.filter(item => item.version_id === row.id)
      return { id: row.id, code: row.code, version: row.version, createdByEmployeeId: row.created_by_employee_id,
      status: rowDecisions.some(item => item.action === 'stop_issuing') ? 'stopped' : rowDecisions.some(item => item.action === 'publish') ? 'published' : rowDecisions.some(item => item.action === 'approve') ? 'approved' : 'draft',
      rule: parseCouponCalendarRule({ timezone: row.timezone, dateBasis: row.date_basis, businessDayStartMinute: row.business_day_start_minute,
        dateFrom: row.date_from, dateThrough: row.date_through, validFrom: new Date(row.valid_from).toISOString(), validUntil: new Date(row.valid_until).toISOString(),
        weekdays: row.weekdays, weekStartsOn: row.week_starts_on,
        ...(row.relative_validity_days ? {relativeValidity:{days:row.relative_validity_days,basis:row.relative_validity_basis}} : {}),
        windows: windows.rows.filter(item => item.version_id === row.id).map(item => ({ startMinute: item.start_minute, endMinute: item.end_minute })), excludedDates: exclusions.rows.filter(item => item.version_id === row.id).map(item => item.excluded_date) }),
      limits: limits({ perCustomerDay: row.per_customer_day_limit, perCustomerWeek: row.per_customer_week_limit, perCustomerCampaign: row.per_customer_campaign_limit }),
      decisions: rowDecisions.map(item => ({ action: item.action, employeeId: item.employee_id })) }
    })
  }
  async list() {
    const result = await this.transaction.query<Row>(`SELECT ${columns} FROM mbox.coupon_calendar_versions WHERE tenant_id=$1 AND store_id=$2 ORDER BY created_at DESC,id DESC LIMIT 30`, this.scope)
    return this.hydrate(result.rows)
  }
  async walletViews(benefitIds: string[], at: Date): Promise<Map<string, CouponCalendarWalletView>> {
    const result = new Map<string, CouponCalendarWalletView>()
    if (!benefitIds.length) return result
    const bindings = await this.transaction.query<{ benefit_id: string; version_id: string;valid_from:string;valid_until:string|null }>(`SELECT binding.benefit_id,binding.version_id,b.valid_from::text,b.valid_until::text
      FROM mbox.benefit_coupon_calendar_bindings binding JOIN mbox.benefits b ON b.tenant_id=binding.tenant_id AND b.store_id=binding.store_id AND b.id=binding.benefit_id
      WHERE binding.tenant_id=$1 AND binding.store_id=$2 AND binding.benefit_id=ANY($3::uuid[])`, [...this.scope, benefitIds])
    if (!bindings.rows.length) return result
    const versionIds = [...new Set(bindings.rows.map(binding => binding.version_id))]
    const rows = await this.transaction.query<Row>(`SELECT ${columns} FROM mbox.coupon_calendar_versions WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[])`, [...this.scope, versionIds])
    const versions = new Map((await this.hydrate(rows.rows)).map(version => [version.id, version]))
    const cache = new Map<string, CouponCalendarWalletView>()
    for (const binding of bindings.rows) {
      const key=JSON.stringify([binding.version_id,binding.valid_from,binding.valid_until])
      let view = cache.get(key)
      if (!view) {
        const version = versions.get(binding.version_id)
        if (!version) throw new CouponCalendarError('券规则版本暂时不可读取，请稍后重试')
        const from=Math.max(Date.parse(version.rule.validFrom),binding.valid_from?Date.parse(binding.valid_from):-Infinity)
        const until=Math.min(Date.parse(version.rule.validUntil),binding.valid_until?Date.parse(binding.valid_until):Infinity)
        const calendar = until<=from?{available:false,nextAvailableAt:null,lastAvailableUntil:null}:previewCouponCalendar({...version.rule,validFrom:new Date(from).toISOString(),validUntil:new Date(until).toISOString()}, at, undefined, 1)
        const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2,'0')}:${String(minute % 60).padStart(2,'0')}`
        const days = version.rule.weekdays.map(day => ['一','二','三','四','五','六','日'][day - 1]).join('、')
        view = { available: calendar.available, nextAvailableAt: calendar.nextAvailableAt, lastAvailableUntil: calendar.lastAvailableUntil,
          limits: version.limits,
          summary: `${version.rule.dateFrom}至${version.rule.dateThrough}，周${days}；${version.rule.windows.map(window => `${clock(window.startMinute)}至${window.endMinute < window.startMinute ? '次日' : ''}${clock(window.endMinute)}`).join('、')}。${version.rule.dateBasis === 'business' ? `按营业日归属，${clock(version.rule.businessDayStartMinute)}换日` : '按自然日归属，零点换日'}。${version.rule.excludedDates.length ? `另有${version.rule.excludedDates.length}个排除日期，以下可用时间已扣除。` : ''}均为北京时间。` }
        cache.set(key, view)
      }
      result.set(binding.benefit_id, view)
    }
    return result
  }
  async save(input: { code: string; rule: unknown; limits: unknown; employeeId: string; businessDate: string; reason: string; requestKey: string; expectedVersion: number }) {
    if (typeof input.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,39}$/.test(input.code)) throw new CouponCalendarError('活动规则编号须为2至40位大写字母、数字或下划线')
    reason(input.reason)
    if (typeof input.requestKey !== 'string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(input.requestKey)) throw new CouponCalendarError('缺少有效的保存操作编号')
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion > 2147483646) throw new CouponCalendarError('版本无效')
    const rule = parseCouponCalendarRule(input.rule), usageLimits = limits(input.limits)
    const fingerprint = createHash('sha256').update(JSON.stringify({ code: input.code, rule, usageLimits, employeeId: input.employeeId, expectedVersion: input.expectedVersion, reason: input.reason.trim() })).digest('hex')
    await this.lock('versions')
    const existing = await this.transaction.query<{ id: string; request_fingerprint: string }>('SELECT id,request_fingerprint FROM mbox.coupon_calendar_versions WHERE tenant_id=$1 AND store_id=$2 AND request_key=$3', [...this.scope, input.requestKey])
    if (existing.rows[0]) {
      if (existing.rows[0].request_fingerprint !== fingerprint) throw new CouponCalendarConflictError('同一保存编号的内容已变化，请重新读取')
      return { ...await this.find(existing.rows[0].id), replayed: true }
    }
    const previous = await this.transaction.query<Row>(`SELECT ${columns} FROM mbox.coupon_calendar_versions WHERE tenant_id=$1 AND store_id=$2 AND code=$3 ORDER BY version DESC LIMIT 1`, [...this.scope, input.code])
    const last = previous.rows[0]
    if ((last?.version ?? 0) !== input.expectedVersion) throw new CouponCalendarConflictError('其他员工已保存新版本，请重新读取')
    // Counts span all versions of a campaign code; redefining their day/week
    // partitions must be a new campaign, not a way to reset the same counters.
    if (last && (last.date_basis !== rule.dateBasis || last.business_day_start_minute !== rule.businessDayStartMinute || last.week_starts_on !== rule.weekStartsOn)) throw new CouponCalendarError('同一活动的换日和周起点不可改写；请使用新活动编号')
    const inserted = await this.transaction.query<{ id: string }>(`INSERT INTO mbox.coupon_calendar_versions(
      tenant_id,store_id,code,version,timezone,date_basis,business_day_start_minute,date_from,date_through,valid_from,valid_until,
      weekdays,week_starts_on,per_customer_day_limit,per_customer_week_limit,per_customer_campaign_limit,created_by_employee_id,reason,request_key,request_fingerprint,relative_validity_days,relative_validity_basis
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
    [...this.scope, input.code, input.expectedVersion + 1, rule.timezone, rule.dateBasis, rule.businessDayStartMinute, rule.dateFrom, rule.dateThrough,
      rule.validFrom, rule.validUntil, rule.weekdays, rule.weekStartsOn, usageLimits.perCustomerDay, usageLimits.perCustomerWeek, usageLimits.perCustomerCampaign,
      input.employeeId, input.reason.trim(), input.requestKey, fingerprint, rule.relativeValidity?.days??null, rule.relativeValidity?.basis??null])
    const versionId = inserted.rows[0]!.id
    for (const [position, window] of rule.windows.entries()) await this.transaction.query('INSERT INTO mbox.coupon_calendar_windows(tenant_id,store_id,version_id,position,start_minute,end_minute) VALUES($1,$2,$3,$4,$5,$6)', [...this.scope, versionId, position, window.startMinute, window.endMinute])
    if (rule.excludedDates.length) await this.transaction.query('INSERT INTO mbox.coupon_calendar_exclusions(tenant_id,store_id,version_id,excluded_date) SELECT $1,$2,$3,unnest($4::date[])', [...this.scope, versionId, rule.excludedDates])
    await this.audit('draft_saved', versionId, input)
    return { ...await this.find(versionId), replayed: false }
  }
  async decide(input: { versionId: string; action: 'approve' | 'publish' | 'stop_issuing'; employeeId: string; businessDate: string; reason: string }) {
    id(input.versionId); reason(input.reason)
    if (!['approve','publish','stop_issuing'].includes(input.action)) throw new CouponCalendarError('不支持的规则操作')
    const permission = input.action === 'approve' ? 'loyalty.configuration.approve' : 'loyalty.policy.publish'
    await new StaffAccessRepository(this.transaction).assertPermission(input.employeeId, permission)
    await this.lock(`decision:${input.versionId}`)
    const draft = await this.find(input.versionId)
    if (draft.decisions.some(item => item.action === input.action)) return draft
    if (input.action !== 'stop_issuing') {
      if (draft.createdByEmployeeId === input.employeeId) throw new CouponCalendarError('规则编辑人不能审批或发布本人草稿')
      const now = await this.now()
      if (previewCouponCalendar(draft.rule, now).nextAvailableAt === null) throw new CouponCalendarError('没有后续可用时段，不能审批或发布')
    }
    if (input.action === 'approve' && draft.status !== 'draft') throw new CouponCalendarError('当前状态不能审批')
    if (input.action === 'publish' && (draft.status !== 'approved' || draft.decisions.some(item => item.action === 'approve' && item.employeeId === input.employeeId))) throw new CouponCalendarError('须由审批人之外的授权发布人员发布')
    if (input.action === 'stop_issuing' && draft.status !== 'published') throw new CouponCalendarError('只有已发布规则可以停发；已发券承诺不会撤销')
    await this.transaction.query('INSERT INTO mbox.coupon_calendar_decisions(tenant_id,store_id,version_id,action,employee_id,reason) VALUES($1,$2,$3,$4,$5,$6)', [...this.scope, input.versionId, input.action, input.employeeId, input.reason.trim()])
    await this.audit(input.action, input.versionId, input)
    return this.find(input.versionId)
  }
  async bindIssuedBenefit(benefitId: string, versionId: string) {
    await this.lock(`decision:${versionId}`)
    const version = await this.find(versionId)
    if (version.status !== 'published' || previewCouponCalendar(version.rule, await this.now()).nextAvailableAt === null) throw new CouponCalendarError('规则未发布、已停发或已无可用时段，不能发出新券')
    await this.transaction.query('INSERT INTO mbox.benefit_coupon_calendar_bindings(tenant_id,store_id,benefit_id,version_id) VALUES($1,$2,$3,$4)', [...this.scope, benefitId, versionId])
  }
  async issuanceValidity(versionId:string,bounds:{validFrom?:string;validUntil?:string|null}){
    id(versionId);await this.lock(`decision:${versionId}`)
    const version=await this.find(versionId)
    if(version.status!=='published')throw new CouponCalendarError('规则未发布或已停发，不能发出新券')
    return couponIssuanceValidity(version.rule,await this.now(),bounds)
  }
  async authorizeReservation(benefitId: string, customerId: string, quantity: number) {
    const binding = await this.transaction.query<{ version_id: string }>('SELECT version_id FROM mbox.benefit_coupon_calendar_bindings WHERE tenant_id=$1 AND store_id=$2 AND benefit_id=$3', [...this.scope, benefitId])
    if (!binding.rows[0]) return null
    const version = await this.find(binding.rows[0].version_id)
    await this.lock(`usage:${version.code}:${customerId}`)
    const calendar = previewCouponCalendar(version.rule, await this.now())
    if (!calendar.available) throw new CouponCalendarError('当前不在此券可用时段内，请查看券的可用日历')
    const usage = await this.transaction.query<{ day: string; week: string; campaign: string }>(`
      WITH RECURSIVE family(id) AS (
        SELECT $3::uuid UNION SELECT c.id FROM mbox.customers c JOIN family ON c.merged_into_customer_id=family.id
        WHERE c.tenant_id=$1 AND c.store_id=$2
      ) SELECT COALESCE(sum(r.quantity) FILTER (WHERE u.usage_date=$5::date),0)::text AS day,
        COALESCE(sum(r.quantity) FILTER (WHERE u.usage_week_start=$6::date),0)::text AS week,COALESCE(sum(r.quantity),0)::text AS campaign
      FROM mbox.benefit_coupon_calendar_usage u JOIN mbox.coupon_calendar_versions v ON v.tenant_id=u.tenant_id AND v.store_id=u.store_id AND v.id=u.version_id
      JOIN mbox.benefit_reservations r ON r.tenant_id=u.tenant_id AND r.store_id=u.store_id AND r.id=u.reservation_id
      WHERE u.tenant_id=$1 AND u.store_id=$2 AND u.customer_id IN (SELECT id FROM family) AND v.code=$4 AND r.status IN ('reserved','redeemed')
    `, [...this.scope, customerId, version.code, calendar.usageDate, calendar.usageWeekStart])
    const row = usage.rows[0]!
    for (const [count, limit, label] of [[row.day, version.limits.perCustomerDay, '当日'], [row.week, version.limits.perCustomerWeek, '本周'], [row.campaign, version.limits.perCustomerCampaign, '本活动']] as const) {
      if (limit !== null && BigInt(count) + BigInt(quantity) > BigInt(limit)) throw new CouponCalendarError(`已达到${label}使用上限（含占用中的券），请先核对已有预约`)
    }
    return { versionId: version.id, usageDate: calendar.usageDate, usageWeekStart: calendar.usageWeekStart }
  }
  async recordReservation(reservationId: string, customerId: string, authorization: NonNullable<Awaited<ReturnType<CouponCalendarRepository['authorizeReservation']>>>) {
    await this.transaction.query('INSERT INTO mbox.benefit_coupon_calendar_usage(tenant_id,store_id,reservation_id,version_id,customer_id,usage_date,usage_week_start) VALUES($1,$2,$3,$4,$5,$6,$7)', [...this.scope, reservationId, authorization.versionId, customerId, authorization.usageDate, authorization.usageWeekStart])
  }
  private async now() { const result = await this.transaction.query<{ now: string }>('SELECT clock_timestamp()::text AS now'); return new Date(result.rows[0]!.now) }
  private audit(action: string, objectId: string, input: { employeeId: string; businessDate: string; reason: string }) {
    return appendAuditEvent(this.transaction, { actor: { type: 'employee', employeeId: input.employeeId }, businessDate: input.businessDate, action: `coupon_calendar.${action}`, objectType: 'coupon_calendar_version', objectId, reason: input.reason.trim() })
  }
}
