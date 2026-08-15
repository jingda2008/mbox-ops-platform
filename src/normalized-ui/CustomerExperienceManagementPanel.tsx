import { useMemo, useState, type FormEvent } from 'react'
import { CalendarPlus, CheckCircle2, Clock3, UsersRound } from 'lucide-react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'

type PaymentMode = 'none' | 'deposit_optional' | 'deposit_required' | 'full_required'

interface ActivitySummary {
  publicId: string
  title: string
  status: string
  startsAt: string
  registrations: number
  feeAmountMinor: number
  depositAmountMinor: number
  feeBasis: 'per_person' | 'per_registration'
  paymentMode: PaymentMode
  paymentDeadlineMinutes: number
  paymentRuleText: string
}

export interface CustomerExperienceDashboard {
  activePlanCount: number
  cueQueue: Array<{ id: string; tableCode: string; station: string; instruction: string; status: string }>
  followups: Array<{ publicId: string; priority: string; action: string; channel: string; dueAt: string; status: string }>
  activities: ActivitySummary[]
}

export function CustomerExperienceManagementPanel({ api, auth, dashboard, onChanged }: {
  api: NormalizedApiClient
  auth: StaffAuthView
  dashboard: CustomerExperienceDashboard
  onChanged(): Promise<void>
}) {
  const [showCreate, setShowCreate] = useState(false)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState({
    title: '', summary: '', kind: 'member_night', startsAt: '', endsAt: '', assemblyLocation: 'M-BOX陆家嘴店',
    capacity: '20', feeYuan: '0', depositYuan: '0', feeBasis: 'per_registration', paymentMode: 'none' as PaymentMode,
    paymentDeadlineMinutes: '15', paymentRuleText: '本活动无需预付，到店后按活动说明结算', refundRule: '付款后如需取消，请联系活动负责人按页面公示规则处理',
  })
  const canCreate = auth.permissions.includes('community.activity.manage')
  const canPublish = auth.permissions.includes('community.activity.publish')
  const paymentNeedsDeposit = form.paymentMode === 'deposit_optional' || form.paymentMode === 'deposit_required'
  const paymentRequiresAdvance = form.paymentMode !== 'none'
  const preview = useMemo(() => paymentPreview(form), [form])

  const set = (key: keyof typeof form, value: string) => setForm((current) => ({
    ...current,
    [key]: value,
    ...(key === 'paymentMode' && value === 'none' ? { depositYuan: '0' } : {}),
    ...(key === 'paymentMode' && value === 'full_required' ? { depositYuan: '0' } : {}),
  }))

  async function createActivity(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy('create'); setNotice('')
    try {
      const feeAmountMinor = yuanToMinor(form.feeYuan, '活动费用')
      const depositAmountMinor = yuanToMinor(form.depositYuan, '订金')
      const startsAt = localDateTimeIso(form.startsAt, '开始时间')
      const endsAt = localDateTimeIso(form.endsAt, '结束时间')
      if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error('结束时间必须晚于开始时间')
      await api.postEndpoint('/api/staff/community-activities', {
        kind: form.kind,
        title: form.title.trim(),
        summary: form.summary.trim(),
        coverUrl: null,
        startsAt,
        endsAt,
        assemblyLocation: form.assemblyLocation.trim(),
        capacity: positiveInteger(form.capacity, '人数上限'),
        feeAmountMinor,
        depositAmountMinor,
        feeBasis: form.feeBasis,
        paymentMode: form.paymentMode,
        paymentDeadlineMinutes: positiveInteger(form.paymentDeadlineMinutes, '付款时限'),
        paymentRuleText: form.paymentRuleText.trim(),
        refundPolicySnapshot: { summary: form.refundRule.trim(), capturedAt: new Date().toISOString() },
        pointsReward: 0,
        visibility: 'public',
        audienceRule: {},
        safetySnapshot: {},
        salesCopy: {},
      }, { idempotencyKey: `activity-create-${crypto.randomUUID()}` })
      setNotice('活动草稿已建立。复核价格、预付和退款说明后再发布。')
      setShowCreate(false)
      await onChanged()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '活动草稿没有建立')
    } finally { setBusy('') }
  }

  async function publishActivity(activity: ActivitySummary) {
    if (busy || !window.confirm(`确认发布“${activity.title}”？发布后客户将看到费用和${paymentModeLabel(activity.paymentMode)}规则。`)) return
    setBusy(activity.publicId); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/community-activities/${encodeURIComponent(activity.publicId)}/publish`, {}, {
        idempotencyKey: `activity-publish-${crypto.randomUUID()}`,
      })
      setNotice('活动已发布，客户页将按配置显示报名和付款选择。')
      await onChanged()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '活动没有发布')
    } finally { setBusy('') }
  }

  return <div className="staff-module-body customer-experience-management">
    <div className="staff-metric-grid">
      <article><small>进行中的桌台体验</small><strong>{dashboard.activePlanCount}</strong></article>
      <article><small>待执行体验节点</small><strong>{dashboard.cueQueue.length}</strong></article>
      <article><small>待跟进客户</small><strong>{dashboard.followups.length}</strong></article>
      <article><small>待办/已发布活动</small><strong>{dashboard.activities.length}</strong></article>
    </div>
    {notice && <p className="staff-module-notice" role="status">{notice}</p>}
    {canCreate && <div className="staff-module-actions"><button type="button" onClick={() => setShowCreate((value) => !value)}><CalendarPlus size={17} /> 配置新活动</button></div>}
    {showCreate && <form className="staff-module-form activity-config-form" onSubmit={(event) => void createActivity(event)}>
      <header><strong>活动报名与付款规则</strong><small>先保存草稿。付款规则、金额、退款说明都进入报名快照，后续修改不会偷偷改变已报名客户的口径。</small></header>
      <label>活动名称<input required minLength={2} maxLength={120} value={form.title} onChange={(event) => set('title', event.target.value)} /></label>
      <label>活动类型<select value={form.kind} onChange={(event) => set('kind', event.target.value)}><option value="member_night">会员音乐夜</option><option value="city_walk">城市漫步</option><option value="hike">徒步</option><option value="camping">露营</option><option value="music_picnic">音乐野餐</option><option value="proposal">求婚活动</option><option value="other">其他</option></select></label>
      <label className="activity-wide">活动说明<input required minLength={2} maxLength={600} value={form.summary} onChange={(event) => set('summary', event.target.value)} /></label>
      <label>开始时间<input required type="datetime-local" value={form.startsAt} onChange={(event) => set('startsAt', event.target.value)} /></label>
      <label>结束时间<input required type="datetime-local" value={form.endsAt} onChange={(event) => set('endsAt', event.target.value)} /></label>
      <label>集合地点<input required value={form.assemblyLocation} onChange={(event) => set('assemblyLocation', event.target.value)} /></label>
      <label>人数上限<input required type="number" min="1" max="1000" value={form.capacity} onChange={(event) => set('capacity', event.target.value)} /></label>
      <label>计价方式<select value={form.feeBasis} onChange={(event) => set('feeBasis', event.target.value)}><option value="per_registration">每次报名/每组</option><option value="per_person">每人</option></select></label>
      <label>活动总费用（元）<input required inputMode="decimal" value={form.feeYuan} onChange={(event) => set('feeYuan', event.target.value)} /></label>
      <label>预付方式<select value={form.paymentMode} onChange={(event) => set('paymentMode', event.target.value)}><option value="none">无需预付</option><option value="deposit_optional">订金可选</option><option value="deposit_required">必须付订金</option><option value="full_required">必须全额预付</option></select></label>
      <label>订金（元）<input required={paymentNeedsDeposit} disabled={!paymentNeedsDeposit} inputMode="decimal" value={form.depositYuan} onChange={(event) => set('depositYuan', event.target.value)} /></label>
      <label>付款时限（分钟）<input required={paymentRequiresAdvance} disabled={!paymentRequiresAdvance} type="number" min="5" max="1440" value={form.paymentDeadlineMinutes} onChange={(event) => set('paymentDeadlineMinutes', event.target.value)} /></label>
      <label className="activity-wide">客户可见付款说明<input required minLength={2} maxLength={240} value={form.paymentRuleText} onChange={(event) => set('paymentRuleText', event.target.value)} /></label>
      <label className="activity-wide">退款与取消说明<input required minLength={2} maxLength={500} value={form.refundRule} onChange={(event) => set('refundRule', event.target.value)} /></label>
      <p className="activity-payment-preview"><CheckCircle2 size={16} /> {preview}</p>
      <button type="submit" disabled={busy === 'create'}>{busy === 'create' ? '正在保存' : '保存为草稿'}</button>
    </form>}
    <section className="activity-admin-list" aria-label="活动列表">
      <header><strong>活动列表</strong><small>草稿必须经过有发布权限的人员复核</small></header>
      {dashboard.activities.length === 0 && <p>还没有活动草稿。</p>}
      {dashboard.activities.map((activity) => <article key={activity.publicId}>
        <div><strong>{activity.title}</strong><small>{new Date(activity.startsAt).toLocaleString('zh-CN')} · {activity.registrations}人已占用名额</small><span>{money(activity.feeAmountMinor)}{activity.feeBasis === 'per_person' ? '/人' : '/次'} · {paymentModeLabel(activity.paymentMode)}{activity.depositAmountMinor > 0 ? ` ${money(activity.depositAmountMinor)}` : ''}</span><small>{activity.paymentRuleText}</small></div>
        <div><em>{activity.status === 'draft' ? '草稿' : '已发布'}</em>{activity.status === 'draft' && canPublish && <button type="button" disabled={busy === activity.publicId} onClick={() => void publishActivity(activity)}>复核并发布</button>}</div>
      </article>)}
    </section>
    <section className="staff-module-summary"><span><Clock3 size={18} /></span><div><strong>待付款名额自动释放</strong><small>达到付款时限后，未创建付款或付款已关闭的报名自动取消；支付结果仍未知时保持人工复核，不擅自释放。</small></div></section>
    <section className="staff-module-summary"><span><UsersRound size={18} /></span><div><strong>权限分开</strong><small>活动管理者可以建草稿；只有拥有活动发布权限的人可以让客户看到，避免一线人员随意承诺定金与退款。</small></div></section>
  </div>
}

export function customerExperienceDashboard(value: unknown): CustomerExperienceDashboard {
  const source = record(value)
  return {
    activePlanCount: nonNegativeInteger(source.activePlanCount),
    cueQueue: array(source.cueQueue).map((item) => {
      const row = record(item)
      return { id: text(row.id), tableCode: text(row.tableCode), station: text(row.station), instruction: text(row.instruction), status: text(row.status) }
    }),
    followups: array(source.followups).map((item) => {
      const row = record(item)
      return { publicId: text(row.publicId), priority: text(row.priority), action: text(row.action), channel: text(row.channel), dueAt: text(row.dueAt), status: text(row.status) }
    }),
    activities: array(source.activities).map(activitySummary),
  }
}

function activitySummary(value: unknown): ActivitySummary {
  const row = record(value)
  const mode = text(row.paymentMode)
  if (!['none', 'deposit_optional', 'deposit_required', 'full_required'].includes(mode)) throw new Error('活动付款规则无法识别')
  const basis = text(row.feeBasis)
  if (!['per_person', 'per_registration'].includes(basis)) throw new Error('活动计价方式无法识别')
  return {
    publicId: text(row.publicId), title: text(row.title), status: text(row.status), startsAt: text(row.startsAt),
    registrations: nonNegativeInteger(row.registrations), feeAmountMinor: nonNegativeInteger(row.feeAmountMinor),
    depositAmountMinor: nonNegativeInteger(row.depositAmountMinor), feeBasis: basis as ActivitySummary['feeBasis'],
    paymentMode: mode as PaymentMode, paymentDeadlineMinutes: nonNegativeInteger(row.paymentDeadlineMinutes), paymentRuleText: text(row.paymentRuleText),
  }
}

function paymentPreview(form: { paymentMode: PaymentMode; feeYuan: string; depositYuan: string; feeBasis: string; paymentDeadlineMinutes: string }) {
  const suffix = form.feeBasis === 'per_person' ? '每人' : '每次报名'
  if (form.paymentMode === 'none') return `${suffix}费用${form.feeYuan || '0'}元，不要求客户预付。`
  if (form.paymentMode === 'deposit_optional') return `${suffix}可选择先付${form.depositYuan || '0'}元订金，也可以不付订金直接确认。`
  if (form.paymentMode === 'deposit_required') return `${suffix}需先付${form.depositYuan || '0'}元订金，名额暂留${form.paymentDeadlineMinutes || '0'}分钟。`
  return `${suffix}需全额预付${form.feeYuan || '0'}元，名额暂留${form.paymentDeadlineMinutes || '0'}分钟。`
}

function paymentModeLabel(value: PaymentMode) {
  return ({ none: '无需预付', deposit_optional: '订金可选', deposit_required: '必须订金', full_required: '全额预付' } as const)[value]
}
function yuanToMinor(value: string, label: string) { const amount = Number(value); if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(amount * 100)) throw new Error(`${label}必须是最多两位小数的非负金额`); return amount * 100 }
function positiveInteger(value: string, label: string) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label}必须是正整数`); return number }
function localDateTimeIso(value: string, label: string) { const timestamp = Date.parse(value); if (!Number.isFinite(timestamp)) throw new Error(`${label}不正确`); return new Date(timestamp).toISOString() }
function money(value: number) { return `¥${(value / 100).toFixed(value % 100 === 0 ? 0 : 2)}` }
function record(value: unknown): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('客户体验数据格式不正确'); return value as Record<string, unknown> }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error('客户体验列表格式不正确'); return value }
function text(value: unknown): string { if (typeof value !== 'string') throw new Error('客户体验文字格式不正确'); return value }
function nonNegativeInteger(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('客户体验数字格式不正确'); return Number(value) }
