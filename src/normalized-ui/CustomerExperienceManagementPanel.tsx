import { useEffect, useState, type FormEvent } from 'react'
import { Clock3, UsersRound } from 'lucide-react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import { useConfirmationDialog } from './ConfirmationDialog'
import { ActivityOperationsPanel } from './ActivityOperationsPanel'
import { CustomerExperienceAnalyticsPanel } from './CustomerExperienceAnalyticsPanel'
import { LoyaltyEmergencyControlPanel } from './LoyaltyEmergencyControlPanel'
import { PromotionalLoyaltyPanel } from './PromotionalLoyaltyPanel'
import { CheckoutUpgradeManagementPanel } from './CheckoutUpgradeManagementPanel'
import { RecommendationPolicyManagementPanel } from './RecommendationPolicyManagementPanel'
import { MembershipConfigurationCenterPanel } from './MembershipConfigurationCenterPanel'
import { PersonalContactGovernancePanel } from './PersonalContactGovernancePanel'
import { HomeContentManagementPanel } from './HomeContentManagementPanel'
import { AnnualBenefitManagementPanel } from './AnnualBenefitManagementPanel'

interface ActivitySummary {
  publicId: string
  title: string
  status: string
  startsAt: string
  registrations: number
  feeAmountMinor: number
  depositAmountMinor: number
  feeBasis: 'per_person' | 'per_registration'
  paymentMode: 'none' | 'deposit_optional' | 'deposit_required' | 'full_required'
  paymentDeadlineMinutes: number
  paymentRuleText: string
}

interface LoyaltyPolicyView {
  id: string
  policyCode: string
  version: number
  status: string
  pointsNumerator: number
  pointsDenominatorMinor: number
  growthNumerator: number
  growthDenominatorMinor: number
  roundingMode: string
  pointsValidityMonths: number
  effectiveFrom: string | null
  effectiveUntil: string | null
  draftedByEmployeeId: string
  approvedByEmployeeId: string | null
  approvedAt: string | null
  publishedByEmployeeId: string | null
  publishedAt: string | null
  publicationMode: string
  reason: string
}

interface LoyaltyReconciliationView {
  orderPublicId: string
  memberNo: string
  eligibleAmountMinor: number
  expectedPoints: number
  expectedGrowth: number
  existingPoints: number
  existingGrowth: number
  status: string
}

interface LoyaltySupplementView {
  publicId: string
  orderPublicId: string
  memberNo: string
  requestedPoints: number
  requestedGrowth: number
  status: string
  reason: string
  requestedByEmployeeId: string
  requestedByName: string
  approvedByName: string | null
  decisionReason: string | null
  createdAt: string
}

interface LoyaltyTierPolicyView {
  id: string; version: number; status: string; evaluationWindowMonths: number
  tierPeriodMonths: number; downgradeGraceDays: number
  silverUpgradeGrowth: number; silverRetainGrowth: number
  goldUpgradeGrowth: number; goldRetainGrowth: number
  silverPointsMultiplierNumerator: number; silverPointsMultiplierDenominator: number
  goldPointsMultiplierNumerator: number; goldPointsMultiplierDenominator: number
  effectiveFrom: string | null; effectiveUntil: string | null
  draftedByEmployeeId: string; approvedByEmployeeId: string | null
  approvedAt: string | null; publishedByEmployeeId: string | null
  publishedAt: string | null; publicationMode: string; reason: string
}

interface RedemptionCatalogItemAdmin {
  catalogId: string; catalogVersion: number; catalogStatus: string
  publicId: string; itemCode: string; name: string
  fulfillmentKind: 'product' | 'benefit' | 'activity' | 'service'
  productId: string | null; productName: string | null
  benefitDefinitionId: string | null; activityId: string | null
  pointsRequired: number; costAmountMinor: number; currency: string
  totalInventory: number | null; dailyInventory: number | null
  memberDailyLimit: number; memberRolling30DayLimit: number; memberLifetimeLimit: number | null
  minimumTier: 'member' | 'silver' | 'gold'; availableFrom: string; availableUntil: string | null
  requiresTableSession: boolean; requiresEmployeeFulfillment: boolean
  cancellationAllowedBeforeFulfillment: boolean; restoreExpiredPointsDays: number
  fulfillmentTimeoutMinutes: number; status: string; display: Record<string, unknown>
}

interface RedemptionConfigurationView {
  control: { state: string; pilotStartsAt: string | null; pilotEndsAt: string | null; reason: string }
  versions: Array<{ id: string; version: number; status: string; draftedByEmployeeId: string; approvedByEmployeeId: string | null; publishedByEmployeeId: string | null; itemCount: number; reason: string }>
  items: RedemptionCatalogItemAdmin[]
}

interface PendingRedemptionView {
  publicId: string; memberNo: string; itemName: string; pointsUsed: number
  fulfillmentKind: string; expiresAt: string; failureCode: string | null
  recoveryState: string; recoveryRequestedAt: string | null; pointsRestored: number
}

interface RedemptionProductOption { id: string; name: string; code: string; costAmountMinor: number }

interface MembershipRecoveryCaseView {
  casePublicId: string
  status: 'manual_review' | 'pending_review'
  candidateCount: number
  maskedPhone: string
  selectedCandidatePublicId: string | null
  maskedMemberNo: string | null
  createdAt: string
}

interface MembershipRecoveryCandidateView {
  candidatePublicId: string
  maskedMemberNo: string
  joinedDate: string
  maskedPhone: string
}

interface MembershipTermsVersionView {
  publicId: string
  version: number
  status: 'draft' | 'approved' | 'published'
  title: string
  summary: string
  content: string
  effectiveFrom: string | null
  effectiveUntil: string | null
  draftedByEmployeeId: string
  approvedByEmployeeId: string | null
  publishedByEmployeeId: string | null
  createdAt: string
}

interface TierBenefitRuleAdmin {
  id?: string
  ruleCode: string
  eligibleTier: 'member' | 'silver' | 'gold'
  inheritToHigherTiers: boolean
  grantOnEntry: boolean
  grantOnRetention: boolean
  benefitDefinitionId: string
  benefitName?: string
  quantity: number
  validityDays: number
  revocationPolicy: 'revoke_unreserved' | 'protect_until_expiry'
  enabled: boolean
}

interface TierBenefitConfigurationView {
  policies: Array<{
    id: string; tierPolicyVersionId: string; tierPolicyVersion: number; version: number; status: string
    effectiveFrom: string | null; effectiveUntil: string | null
    draftedByEmployeeId: string; approvedByEmployeeId: string | null; publishedByEmployeeId: string | null
    reason: string; rules: TierBenefitRuleAdmin[]
  }>
  definitions: Array<{ id: string; name: string; benefitKind: string; validityDays: number; status: string }>
  tierPolicies: Array<{ id: string; version: number; status: string; effectiveFrom: string | null; effectiveUntil: string | null }>
}

export interface CustomerExperienceDashboard {
  activePlanCount: number
  cueQueue: Array<{ id: string; tableCode: string; station: string; instruction: string; status: string }>
  followups: Array<{ publicId: string; priority: string; action: string; channel: string; dueAt: string; status: string }>
  activities: ActivitySummary[]
}

export type CustomerExperiencePanelMode = 'experience' | 'member-fulfillment' | 'member-exceptions'
  | 'member-overview' | 'member-rule-drafts' | 'member-rule-approvals' | 'member-rule-publish'
  | 'member-accounts' | 'member-management'

export function CustomerExperienceManagementPanel({ api, auth, dashboard, mode = 'experience' }: {
  api: NormalizedApiClient
  auth: StaffAuthView
  dashboard: CustomerExperienceDashboard | null
  mode?: CustomerExperiencePanelMode
}) {
  if (mode === 'member-fulfillment') return <div className="staff-module-body customer-experience-management">
    <section className="customer-experience-publishing-intro"><strong>当前桌次会员权益待办</strong><small>只显示当前岗位可确认的赠送、核销与出品事项；每次操作记录当前员工并执行防重复校验。</small></section>
    <LoyaltyTierAndRedemptionPanel api={api} auth={auth} />
    <AnnualBenefitManagementPanel api={api} auth={auth} />
  </div>
  if (mode === 'member-exceptions') return <div className="staff-module-body customer-experience-management">
    <section className="customer-experience-publishing-intro"><strong>会员权益异常</strong><small>处理过期、缺货、结果未知和已制作后的补偿；终态记录不能直接改回可用。</small></section>
    <LoyaltyTierAndRedemptionPanel api={api} auth={auth} />
    <AnnualBenefitManagementPanel api={api} auth={auth} />
  </div>
  if (mode === 'member-overview') return <div className="staff-module-body customer-experience-management">
    <section className="customer-experience-publishing-intro"><strong>会员等级与权益</strong><small>只读查看当前已发布的积分、成长值、等级与等级权益规则；本入口不能起草、审批或发布。</small></section>
    <LoyaltyPolicyPanel api={api} auth={auth} />
    <TierBenefitPolicyPanel api={api} auth={auth} />
  </div>
  if (mode === 'member-rule-drafts' || mode === 'member-rule-approvals' || mode === 'member-rule-publish') {
    const presentation = mode === 'member-rule-drafts'
      ? ['会员规则草稿', '建立规则草稿并查看服务端影响预览；保存不会直接生效。']
      : mode === 'member-rule-approvals'
        ? ['待审批会员规则', '复核他人起草且影响预览仍有效的会员规则；审批人与起草人必须不同。']
        : ['会员规则发布', '为已独立审批的规则安排生效时间；发布人与起草、审批人员必须不同。']
    return <div className="staff-module-body customer-experience-management">
      <section className="customer-experience-publishing-intro"><strong>{presentation[0]}</strong><small>{presentation[1]}</small></section>
      <MembershipConfigurationCenterPanel api={api} auth={auth} />
      <LoyaltyPolicyPanel api={api} auth={auth} />
    </div>
  }
  if (mode === 'member-accounts') return <div className="staff-module-body customer-experience-management">
    <section className="customer-experience-publishing-intro"><strong>会员账户查询</strong><small>按会员号读取积分、成长值和流水；不显示手机号、微信身份或其他无关个人资料。</small></section>
    <MemberAccountLookupPanel api={api} auth={auth} />
  </div>
  if (mode === 'member-management') return <div className="staff-module-body customer-experience-management">
    <section className="customer-experience-publishing-intro"><strong>其他会员经营配置</strong><small>年度礼遇、兑换目录、活动、会员条款与账户恢复按各自最终权限显示。</small></section>
    <LoyaltyEmergencyControlPanel api={api} auth={auth} />
    <MembershipConfigurationCenterPanel api={api} auth={auth} />
    <PromotionalLoyaltyPanel api={api} auth={auth} />
    <LoyaltyTierAndRedemptionPanel api={api} auth={auth} />
    <TierBenefitPolicyPanel api={api} auth={auth} />
    <AnnualBenefitManagementPanel api={api} auth={auth} />
    <MembershipTermsManagementPanel api={api} auth={auth} />
    <MembershipRecoveryPanel api={api} auth={auth} />
  </div>
  return <div className="staff-module-body customer-experience-management">
    {dashboard !== null && <div className="staff-metric-grid">
      <article><small>进行中的桌台体验</small><strong>{dashboard.activePlanCount}</strong></article>
      <article><small>待执行体验节点</small><strong>{dashboard.cueQueue.length}</strong></article>
      <article><small>待跟进客户</small><strong>{dashboard.followups.length}</strong></article>
      <article><small>待办/已发布活动</small><strong>{dashboard.activities.length}</strong></article>
    </div>}
    <section className="customer-experience-publishing-intro">
      <strong>超嗨发布工作台</strong>
      <small>先上传并选择图片，再保存草稿；活动和首页内容都必须由拥有发布权限的员工复核后才会在小程序展示。</small>
    </section>
    <ActivityOperationsPanel api={api} auth={auth} />
    <HomeContentManagementPanel api={api} auth={auth} />
    <CustomerExperienceAnalyticsPanel api={api} auth={auth} />
    <CheckoutUpgradeManagementPanel api={api} auth={auth} />
    <RecommendationPolicyManagementPanel api={api} auth={auth} />
    <PersonalContactGovernancePanel api={api} auth={auth} />
    <section className="staff-module-summary"><span><Clock3 size={18} /></span><div><strong>待付款名额自动释放</strong><small>达到付款时限后，未创建付款或付款已关闭的报名自动取消；支付结果仍未知时保持人工复核，不擅自释放。</small></div></section>
    <section className="staff-module-summary"><span><UsersRound size={18} /></span><div><strong>权限分开</strong><small>活动管理者可以建草稿；只有拥有活动发布权限的人可以让客户看到，避免一线人员随意承诺定金与退款。</small></div></section>
  </div>
}

interface StaffMemberAccountView {
  memberNo: string
  membershipStatus: string
  tier: 'member' | 'silver' | 'gold'
  availablePoints: number
  pendingRecoveryPoints: number
  lifetimeGrowth: number
  qualificationGrowth: number
  tierQualificationGrowth: number | null
  tierPeriodEndsAt: string | null
  updatedAt: string
  pointEntries: Array<{ entryType: string; delta: number; balanceAfter: number; reason: string; occurredAt: string }>
  growthEntries: Array<{ entryType: string; delta: number; balanceAfter: number; reason: string; occurredAt: string }>
}

function MemberAccountLookupPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const canView = auth.permissions.includes('loyalty.account.view')
  const [memberNo, setMemberNo] = useState('')
  const [account, setAccount] = useState<StaffMemberAccountView | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  if (!canView) return null

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (memberNo.trim().length < 3 || busy) return
    setBusy(true); setNotice(''); setAccount(null)
    try {
      const response = await api.getEndpoint<{ data: StaffMemberAccountView }>(`/api/staff/loyalty/accounts?memberNo=${encodeURIComponent(memberNo.trim())}`)
      setAccount(response.data)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '会员账户暂时无法读取')
    } finally { setBusy(false) }
  }

  return <section className="staff-module-summary"><div>
    <strong>会员账户查询</strong><small>按完整会员号查询积分、三种成长值口径和最近流水；本入口不显示手机号或微信身份。</small>
    <form className="staff-module-form" onSubmit={(event) => void submit(event)}>
      <label>会员号<input minLength={3} maxLength={64} value={memberNo} placeholder="请输入完整会员号" onChange={(event) => setMemberNo(event.target.value)} /></label>
      <button type="submit" disabled={busy || memberNo.trim().length < 3}>{busy ? '正在查询' : '查询账户'}</button>
    </form>
    {notice && <p className="staff-module-notice" role="status">{notice}</p>}
    {account !== null && <>
      <div className="staff-metric-grid">
        <article><small>当前等级</small><strong>{({ member: '普卡', silver: '银卡', gold: '金卡' } as const)[account.tier]}</strong></article>
        <article><small>可用积分</small><strong>{account.availablePoints}</strong></article>
        <article><small>资格成长值</small><strong>{account.qualificationGrowth}</strong></article>
        <article><small>累计成长值</small><strong>{account.lifetimeGrowth}</strong></article>
        <article><small>等级周期资格快照</small><strong>{account.tierQualificationGrowth ?? '暂无'}</strong></article>
        <article><small>待追回积分</small><strong>{account.pendingRecoveryPoints}</strong></article>
      </div>
      <p className="staff-module-footnote">会员号 {account.memberNo} · {account.membershipStatus === 'active' ? '有效会员' : '会员状态受限'} · 数据更新 {new Date(account.updatedAt).toLocaleString('zh-CN')}</p>
      <div className="activity-admin-list"><header><strong>最近积分流水</strong><small>最多20条</small></header>{account.pointEntries.length === 0 ? <p>暂无积分流水。</p> : account.pointEntries.map((entry, index) => <article key={`point-${entry.occurredAt}-${index}`}><div><strong>{entry.delta > 0 ? '+' : ''}{entry.delta}积分 · 余额{entry.balanceAfter}</strong><small>{entry.reason} · {new Date(entry.occurredAt).toLocaleString('zh-CN')}</small></div></article>)}</div>
      <div className="activity-admin-list"><header><strong>最近成长值流水</strong><small>最多20条</small></header>{account.growthEntries.length === 0 ? <p>暂无成长值流水。</p> : account.growthEntries.map((entry, index) => <article key={`growth-${entry.occurredAt}-${index}`}><div><strong>{entry.delta > 0 ? '+' : ''}{entry.delta}成长值 · 累计{entry.balanceAfter}</strong><small>{entry.reason} · {new Date(entry.occurredAt).toLocaleString('zh-CN')}</small></div></article>)}</div>
    </>}
  </div></section>
}

function TierBenefitPolicyPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const { promptAction } = useConfirmationDialog()
  const canView = auth.permissions.includes('loyalty.policy.view')
  const canManage = auth.permissions.includes('loyalty.policy.manage')
  const canApprove = auth.permissions.includes('loyalty.policy.approve')
  const canPublish = auth.permissions.includes('loyalty.policy.publish')
  const canRead = canView || canManage || canApprove || canPublish
  const [configuration, setConfiguration] = useState<TierBenefitConfigurationView | null>(null)
  const [rules, setRules] = useState<TierBenefitRuleAdmin[]>([])
  const [form, setForm] = useState({
    tierPolicyVersionId: '', reason: '', ruleCode: '', eligibleTier: 'silver' as TierBenefitRuleAdmin['eligibleTier'],
    benefitDefinitionId: '', quantity: '1', validityDays: '30',
    inheritToHigherTiers: true, grantOnEntry: true, grantOnRetention: false,
    revocationPolicy: 'revoke_unreserved' as TierBenefitRuleAdmin['revocationPolicy'], enabled: true,
  })
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')

  async function load() {
    if (!canRead) return
    try {
      const response = await api.getEndpoint<{ data: TierBenefitConfigurationView }>('/api/staff/loyalty/tier-benefits')
      setConfiguration(response.data)
      setForm((current) => ({
        ...current,
        tierPolicyVersionId: current.tierPolicyVersionId || response.data.tierPolicies[0]?.id || '',
        benefitDefinitionId: current.benefitDefinitionId
          || response.data.definitions.find((item) => item.status === 'active')?.id || '',
      }))
    } catch (error) { setNotice(error instanceof Error ? error.message : '等级权益配置暂时无法读取') }
  }

  useEffect(() => { void load() }, [canRead])
  if (!canView && !canManage && !canApprove && !canPublish) return null

  function addRule() {
    const code = form.ruleCode.trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) return setNotice('规则代码需为3至64位大写字母、数字或下划线。')
    if (!form.benefitDefinitionId) return setNotice('请选择权益定义。')
    if (!form.grantOnEntry && !form.grantOnRetention) return setNotice('请至少选择“进入等级发放”或“保级发放”。')
    if (rules.some((item) => item.ruleCode === code)) return setNotice('规则代码不能重复。')
    const quantity = positiveInteger(form.quantity, '发放数量')
    const validityDays = positiveInteger(form.validityDays, '有效天数')
    if (quantity > 100 || validityDays > 366) return setNotice('发放数量不能超过100，有效期不能超过366天。')
    setRules((current) => [...current, {
      ruleCode: code, eligibleTier: form.eligibleTier,
      inheritToHigherTiers: form.inheritToHigherTiers,
      grantOnEntry: form.grantOnEntry, grantOnRetention: form.grantOnRetention,
      benefitDefinitionId: form.benefitDefinitionId, quantity, validityDays,
      revocationPolicy: form.revocationPolicy, enabled: form.enabled,
    }])
    setForm((current) => ({ ...current, ruleCode: '' }))
    setNotice('已加入待保存规则。')
  }

  async function saveDraft(event: FormEvent) {
    event.preventDefault()
    if (!canManage || busy) return
    if (!form.tierPolicyVersionId || rules.length === 0 || form.reason.trim().length < 2) {
      return setNotice('请选择已发布等级规则、加入至少一条权益规则并填写起草原因。')
    }
    setBusy('draft'); setNotice('')
    try {
      await api.postEndpoint('/api/staff/loyalty/tier-benefit-policies', {
        tierPolicyVersionId: form.tierPolicyVersionId, reason: form.reason.trim(), rules,
      }, { idempotencyKey: `tier-benefit-draft-${crypto.randomUUID()}` })
      setRules([]); setForm((current) => ({ ...current, reason: '' }))
      setNotice('等级权益政策已保存为草稿，必须独立审批后再发布。')
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '等级权益政策草稿未保存') }
    finally { setBusy('') }
  }

  function approve(_policy: TierBenefitConfigurationView['policies'][number]) {
    setNotice('审批已移至上方“会员经营配置中心”：先生成服务端影响预览，再由未参与编辑的人审批。')
    window.dispatchEvent(new Event('mbox:open-membership-configuration'))
  }

  async function publish(policy: TierBenefitConfigurationView['policies'][number]) {
    const effectiveFrom = (await promptAction({
      title: '排期发布等级权益',
      description: '请输入 ISO 格式的生效时间。',
      label: '生效时间',
      confirmLabel: '继续',
      multiline: false,
    }))?.trim()
    if (!effectiveFrom || !Number.isFinite(Date.parse(effectiveFrom))) return setNotice('生效时间格式不正确，未发布。')
    const reason = (await promptAction({
      title: '填写发布说明',
      description: '至少填写 2 个字，便于后续审计。',
      label: '发布说明',
      confirmLabel: '确认发布',
    }))?.trim() ?? ''
    if (reason.length < 2) return setNotice('发布说明不足，未发布。')
    setBusy(`publish-${policy.id}`); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/loyalty/tier-benefit-policies/${policy.id}/publish`, {
        effectiveFrom: new Date(effectiveFrom).toISOString(), effectiveUntil: null, reason,
      }, { idempotencyKey: `tier-benefit-publish-${crypto.randomUUID()}` })
      setNotice('等级权益政策已排期发布，到期回收由后台定时任务独立处理。'); await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '等级权益政策未发布') }
    finally { setBusy('') }
  }

  return <section className="staff-module-summary tier-benefit-panel"><div>
    <strong>等级自动权益</strong><small>店长配置发放时机、数量、有效期与降级处理；运营审批，最高授权人员发布。</small>
    {notice && <p className="staff-module-notice" role="status">{notice}</p>}
    {canManage && <form className="staff-module-form" onSubmit={(event) => void saveDraft(event)}>
      <label>关联已发布等级规则<select required value={form.tierPolicyVersionId} onChange={(event) => setForm({ ...form, tierPolicyVersionId: event.target.value })}><option value="">请选择</option>{configuration?.tierPolicies.map((item) => <option key={item.id} value={item.id}>第{item.version}版</option>)}</select></label>
      <label>规则代码<input value={form.ruleCode} onChange={(event) => setForm({ ...form, ruleCode: event.target.value.toUpperCase() })} placeholder="SILVER_WELCOME" /></label>
      <label>适用等级<select value={form.eligibleTier} onChange={(event) => setForm({ ...form, eligibleTier: event.target.value as TierBenefitRuleAdmin['eligibleTier'] })}><option value="member">普通会员</option><option value="silver">银卡</option><option value="gold">金卡</option></select></label>
      <label>权益定义<select required value={form.benefitDefinitionId} onChange={(event) => setForm({ ...form, benefitDefinitionId: event.target.value })}><option value="">请选择</option>{configuration?.definitions.filter((item) => item.status === 'active').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>发放数量<input type="number" min="1" max="100" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} /></label>
      <label>有效天数<input type="number" min="1" max="366" value={form.validityDays} onChange={(event) => setForm({ ...form, validityDays: event.target.value })} /></label>
      <label>降级处理<select value={form.revocationPolicy} onChange={(event) => setForm({ ...form, revocationPolicy: event.target.value as TierBenefitRuleAdmin['revocationPolicy'] })}><option value="revoke_unreserved">撤回未预留权益</option><option value="protect_until_expiry">保留至自然到期</option></select></label>
      <label className="catalog-check"><input type="checkbox" checked={form.inheritToHigherTiers} onChange={(event) => setForm({ ...form, inheritToHigherTiers: event.target.checked })} />高等级继承</label>
      <label className="catalog-check"><input type="checkbox" checked={form.grantOnEntry} onChange={(event) => setForm({ ...form, grantOnEntry: event.target.checked })} />进入等级时发放</label>
      <label className="catalog-check"><input type="checkbox" checked={form.grantOnRetention} onChange={(event) => setForm({ ...form, grantOnRetention: event.target.checked })} />保级时发放</label>
      <button type="button" onClick={addRule}>加入当前规则</button>
      <label className="activity-wide">起草原因<input minLength={2} maxLength={500} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} /></label>
      <div className="activity-wide tier-benefit-draft-list">{rules.length === 0 ? <small>还没有待保存规则</small> : rules.map((item) => <span key={item.ruleCode}>{item.ruleCode} · {item.eligibleTier} · {item.quantity}份/{item.validityDays}天 <button type="button" onClick={() => setRules((current) => current.filter((candidate) => candidate.ruleCode !== item.ruleCode))}>移除</button></span>)}</div>
      <button type="submit" disabled={Boolean(busy)}>保存政策草稿</button>
    </form>}
    <div className="activity-admin-list"><header><strong>政策版本</strong><small>生效运行完全使用强类型规则</small></header>
      {(configuration?.policies.length ?? 0) === 0 && <p>尚未配置等级自动权益。</p>}
      {configuration?.policies.map((policy) => <article key={policy.id}><div><strong>等级策略{policy.tierPolicyVersion}·权益版本{policy.version} · {releaseStatusLabel(policy.status)}</strong><small>{policy.rules.map((rule) => `${rule.benefitName || rule.ruleCode}×${rule.quantity}`).join(' · ')}</small><small>{policy.reason}</small></div><div className="staff-inline-actions">{policy.status === 'draft' && canApprove && policy.draftedByEmployeeId !== auth.employee.id && <button type="button" disabled={Boolean(busy)} onClick={() => void approve(policy)}>前往配置中心审批</button>}{policy.status === 'approved' && canPublish && policy.draftedByEmployeeId !== auth.employee.id && policy.approvedByEmployeeId !== auth.employee.id && <button type="button" disabled={Boolean(busy)} onClick={() => void publish(policy)}>排期发布</button>}</div></article>)}
    </div>
  </div></section>
}

function MembershipTermsManagementPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const { promptAction } = useConfirmationDialog()
  const canView = auth.permissions.includes('membership.terms.view')
  const canManage = auth.permissions.includes('membership.terms.manage')
  const canApprove = auth.permissions.includes('membership.terms.approve')
  const canPublish = auth.permissions.includes('membership.terms.publish')
  const [versions, setVersions] = useState<MembershipTermsVersionView[]>([])
  const [form, setForm] = useState({ title: '', summary: '', content: '', reason: '' })
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')

  async function load() {
    if (!canView) return
    try {
      const response = await api.getEndpoint<{ data: MembershipTermsVersionView[] }>('/api/staff/membership-terms')
      setVersions(Array.isArray(response.data) ? response.data : [])
    } catch (error) { setNotice(error instanceof Error ? error.message : '入会条款暂时无法读取') }
  }

  useEffect(() => { void load() }, [canView])
  if (!canView && !canManage && !canApprove && !canPublish) return null

  async function createDraft(event: FormEvent) {
    event.preventDefault()
    if (!canManage || busy) return
    setBusy('draft'); setNotice('')
    try {
      await api.postEndpoint('/api/staff/membership-terms/drafts', {
        title: form.title.trim(), summary: form.summary.trim(),
        content: form.content.trim(), reason: form.reason.trim(),
      }, { idempotencyKey: `membership-terms-draft-${crypto.randomUUID()}` })
      setForm({ title: '', summary: '', content: '', reason: '' })
      setNotice('条款草稿已保存，须由其他授权人员审批，再由第三人发布。')
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '入会条款草稿未保存') }
    finally { setBusy('') }
  }

  function approve(_version: MembershipTermsVersionView) {
    setNotice('审批已移至上方“会员经营配置中心”：服务端会核对条款影响和全部编辑者。')
    window.dispatchEvent(new Event('mbox:open-membership-configuration'))
  }

  async function publish(version: MembershipTermsVersionView) {
    const requestedTimeValue = await promptAction({
      title: '发布入会条款',
      description: '填写 ISO 格式生效时间；留空表示立即生效。',
      label: '生效时间（可留空）',
      confirmLabel: '继续',
      multiline: false,
    })
    if (requestedTimeValue === null) return
    const requestedTime = requestedTimeValue.trim()
    if (requestedTime && !Number.isFinite(Date.parse(requestedTime))) return setNotice('生效时间格式不正确，未发布。')
    const reason = (await promptAction({
      title: '填写发布说明',
      description: '至少填写 2 个字，便于后续审计。',
      label: '发布说明',
      confirmLabel: '确认发布',
    }))?.trim() ?? ''
    if (reason.length < 2) return setNotice('发布说明不足，未发布。')
    setBusy(`publish-${version.version}`); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/membership-terms/${version.version}/publish`, {
        effectiveFrom: requestedTime ? new Date(requestedTime).toISOString() : null, reason,
      }, { idempotencyKey: `membership-terms-publish-${crypto.randomUUID()}` })
      setNotice('条款已发布；未到生效时间前，当前版本依然有效。')
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '入会条款未发布') }
    finally { setBusy('') }
  }

  return <section className="staff-module-summary membership-terms-panel"><div>
    <strong>入会条款与顾客确认</strong>
    <small>李艳/店长可起草，运营独立审批，最高授权人员发布；已有会员不因条款换版被停用。</small>
    {notice && <p className="staff-module-notice" role="status">{notice}</p>}
    {canManage && <form className="staff-module-form" onSubmit={(event) => void createDraft(event)}>
      <label>条款标题<input required minLength={2} maxLength={120} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
      <label className="activity-wide">顾客摘要<input required minLength={2} maxLength={500} value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} /></label>
      <label className="activity-wide">条款全文<textarea required minLength={10} maxLength={12000} rows={8} value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} /></label>
      <label className="activity-wide">起草说明<input required minLength={2} maxLength={500} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} /></label>
      <button type="submit" disabled={Boolean(busy)}>{busy === 'draft' ? '正在保存' : '保存新版本草稿'}</button>
    </form>}
    <div className="activity-admin-list">
      <header><strong>条款版本</strong><small>顾客只能确认当前生效的完整版本</small></header>
      {versions.length === 0 && <p>尚未建立入会条款，新入会将安全关闭，点单不受影响。</p>}
      {versions.map((version) => <article key={version.publicId}>
        <div><strong>第{version.version}版 · {releaseStatusLabel(version.status)}</strong><small>{version.title} · {version.summary}</small><small>{version.effectiveFrom ? `生效 ${new Date(version.effectiveFrom).toLocaleString('zh-CN')}` : '尚未生效'}</small><details><summary>查看全文</summary><p>{version.content}</p></details></div>
        <div className="staff-inline-actions">
          {version.status === 'draft' && canApprove && version.draftedByEmployeeId !== auth.employee.id && <button type="button" disabled={Boolean(busy)} onClick={() => void approve(version)}>前往配置中心审批</button>}
          {version.status === 'approved' && canPublish && version.draftedByEmployeeId !== auth.employee.id && version.approvedByEmployeeId !== auth.employee.id && <button type="button" disabled={Boolean(busy)} onClick={() => void publish(version)}>排期发布</button>}
        </div>
      </article>)}
    </div>
  </div></section>
}

function MembershipRecoveryPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const { promptAction } = useConfirmationDialog()
  const canVerify = auth.permissions.includes('customer.membership.recovery.verify')
  const canApprove = auth.permissions.includes('customer.membership.merge.approve')
  const [cases, setCases] = useState<MembershipRecoveryCaseView[]>([])
  const [candidates, setCandidates] = useState<Record<string, MembershipRecoveryCandidateView[]>>({})
  const [contact, setContact] = useState({ memberNo: '', phone: '', reason: '' })
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')

  async function load() {
    if (!canVerify && !canApprove) return
    try {
      const response = await api.getEndpoint<{ data: MembershipRecoveryCaseView[] }>('/api/staff/membership-recovery/cases')
      setCases(response.data)
    } catch (error) { setNotice(error instanceof Error ? error.message : '会员找回队列暂时无法读取') }
  }

  useEffect(() => { void load() }, [canVerify, canApprove])
  if (!canVerify && !canApprove) return null

  async function saveVerifiedContact(event: FormEvent) {
    event.preventDefault()
    if (!canVerify || busy) return
    setBusy('contact'); setNotice('')
    try {
      await api.postEndpoint('/api/staff/membership-recovery/verified-contacts', {
        memberNo: contact.memberNo.trim(), phone: contact.phone.trim(), reason: contact.reason.trim(),
      }, { idempotencyKey: `membership-recovery-contact-${crypto.randomUUID()}` })
      setContact({ memberNo: '', phone: '', reason: '' })
      setNotice('历史会员联系方式已按受控流程核验；不会因此开启营销通知。')
    } catch (error) { setNotice(error instanceof Error ? error.message : '联系方式核验没有完成') }
    finally { setBusy('') }
  }

  async function loadCandidates(item: MembershipRecoveryCaseView) {
    setBusy(`candidates-${item.casePublicId}`); setNotice('')
    try {
      const response = await api.getEndpoint<{ data: MembershipRecoveryCandidateView[] }>(
        `/api/staff/membership-recovery/cases/${encodeURIComponent(item.casePublicId)}/candidates`,
      )
      setCandidates((current) => ({ ...current, [item.casePublicId]: response.data }))
    } catch (error) { setNotice(error instanceof Error ? error.message : '候选会员暂时无法读取') }
    finally { setBusy('') }
  }

  async function selectCandidate(item: MembershipRecoveryCaseView, candidate: MembershipRecoveryCandidateView) {
    const reason = (await promptAction({
      title: '选择核验候选',
      description: `请填写核验 ${candidate.maskedMemberNo} 的依据，至少 2 个字。`,
      label: '核验依据',
      confirmLabel: '确认选择',
    }))?.trim() ?? ''
    if (reason.length < 2) return setNotice('核验依据不足，未选择候选。')
    setBusy(`select-${item.casePublicId}`); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/membership-recovery/cases/${encodeURIComponent(item.casePublicId)}/select`, {
        candidatePublicId: candidate.candidatePublicId, reason,
      }, { idempotencyKey: `membership-recovery-select-${crypto.randomUUID()}` })
      setNotice('候选已核验，须由另一名有合并复核权限的员工处理。')
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '候选没有选定') }
    finally { setBusy('') }
  }

  async function decide(item: MembershipRecoveryCaseView, decision: 'approve' | 'reject') {
    const label = decision === 'approve' ? '合并复核说明' : '驳回说明'
    const reason = (await promptAction({
      title: decision === 'approve' ? '复核合并' : '驳回找回申请',
      description: `${label}至少填写 2 个字。`,
      label,
      confirmLabel: decision === 'approve' ? '确认合并' : '确认驳回',
    }))?.trim() ?? ''
    if (reason.length < 2) return setNotice(`${label}不足，未处理。`)
    setBusy(`${decision}-${item.casePublicId}`); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/membership-recovery/cases/${encodeURIComponent(item.casePublicId)}/${decision}`, {
        reason,
      }, { idempotencyKey: `membership-recovery-${decision}-${crypto.randomUUID()}` })
      setNotice(decision === 'approve' ? '会员关系已合并；来源账户、积分流水和权益历史仍保留。' : '找回申请已驳回并留存审计。')
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '找回申请没有处理') }
    finally { setBusy('') }
  }

  return <section className="staff-module-summary membership-recovery-panel">
    <div>
      <strong>历史会员找回与合并</strong>
      <small>顾客手机号仅用于本次核验；多候选必须人工选择，核验人与复核人不能是同一人。</small>
      {notice && <p className="staff-module-notice" role="status">{notice}</p>}
      {canVerify && <form className="staff-module-form" onSubmit={(event) => void saveVerifiedContact(event)}>
        <label>历史会员号<input required minLength={8} maxLength={64} value={contact.memberNo} onChange={(event) => setContact({ ...contact, memberNo: event.target.value })} /></label>
        <label>已现场核验手机号<input required inputMode="tel" minLength={8} maxLength={24} value={contact.phone} onChange={(event) => setContact({ ...contact, phone: event.target.value })} placeholder="例如 +8613800138000" /></label>
        <label>核验依据<input required minLength={2} maxLength={500} value={contact.reason} onChange={(event) => setContact({ ...contact, reason: event.target.value })} /></label>
        <button type="submit" disabled={Boolean(busy)}>{busy === 'contact' ? '正在保存' : '保存受控核验'}</button>
      </form>}
      <div className="activity-admin-list">
        <header><strong>待处理找回申请</strong><small>只显示掩码信息，不展示候选账户的订单或完整手机号</small></header>
        {cases.length === 0 && <p>当前没有待处理的会员找回申请。</p>}
        {cases.map((item) => <article key={item.casePublicId}>
          <div><strong>{item.maskedPhone} · {item.status === 'manual_review' ? '待核验候选' : '待独立复核'}</strong><small>{item.candidateCount} 个匹配 · {item.maskedMemberNo || '尚未选择会员'} · {new Date(item.createdAt).toLocaleString('zh-CN')}</small></div>
          <div className="staff-inline-actions">
            {item.status === 'manual_review' && canVerify && <button type="button" disabled={Boolean(busy)} onClick={() => void loadCandidates(item)}>查看候选</button>}
            {item.status === 'pending_review' && canApprove && <button type="button" disabled={Boolean(busy)} onClick={() => void decide(item, 'approve')}>复核合并</button>}
            {canApprove && <button type="button" className="is-danger" disabled={Boolean(busy)} onClick={() => void decide(item, 'reject')}>驳回</button>}
          </div>
          {(candidates[item.casePublicId] ?? []).map((candidate) => <div className="membership-recovery-candidate" key={candidate.candidatePublicId}><span>{candidate.maskedMemberNo}</span><small>入会日期 {candidate.joinedDate} · {candidate.maskedPhone}</small><button type="button" disabled={Boolean(busy)} onClick={() => void selectCandidate(item, candidate)}>选择此会员</button></div>)}
        </article>)}
      </div>
    </div>
  </section>
}

function LoyaltyTierAndRedemptionPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const { confirmAction, promptAction } = useConfirmationDialog()
  const canView = auth.permissions.includes('loyalty.policy.view')
  const canManage = auth.permissions.includes('loyalty.policy.manage')
  const canApprove = auth.permissions.includes('loyalty.policy.approve')
  const canPublish = auth.permissions.includes('loyalty.policy.publish')
  const canManageCatalog = auth.permissions.includes('loyalty.redemption.catalog.manage')
  const canApproveCatalog = auth.permissions.includes('loyalty.redemption.catalog.approve')
  const canPublishCatalog = auth.permissions.includes('loyalty.redemption.catalog.publish')
  const canControl = auth.permissions.includes('loyalty.redemption.control')
  const canFulfill = auth.permissions.includes('loyalty.redemption.fulfill')
  const canHandleException = auth.permissions.includes('loyalty.redemption.exception')
  const canReadConfiguration = canView || canManageCatalog || canApproveCatalog || canPublishCatalog || canControl
  const canReadPending = canFulfill || canHandleException
  const [tiers, setTiers] = useState<LoyaltyTierPolicyView[]>([])
  const [config, setConfig] = useState<RedemptionConfigurationView | null>(null)
  const [pending, setPending] = useState<PendingRedemptionView[]>([])
  const [products, setProducts] = useState<RedemptionProductOption[]>([])
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [tierForm, setTierForm] = useState({
    silverUpgradeGrowth: '5000', silverRetainGrowth: '3000',
    goldUpgradeGrowth: '20000', goldRetainGrowth: '12000',
    evaluationWindowMonths: '12', tierPeriodMonths: '12', downgradeGraceDays: '60',
    silverMultiplier: '1.10', goldMultiplier: '1.20', reason: '',
  })
  const [itemForm, setItemForm] = useState({
    productId: '', pointsRequired: '', totalInventory: '', dailyInventory: '',
    memberDailyLimit: '1', memberRolling30DayLimit: '4', minimumTier: 'member',
    availableFrom: '', availableUntil: '', description: '', reason: '',
  })

  async function load() {
    try {
      const [tierResponse, configurationResponse, productResponse, pendingResponse] = await Promise.all([
        (canView
          ? api.getEndpoint<{ data: LoyaltyTierPolicyView[] }>('/api/staff/loyalty/tier-policies')
          : Promise.resolve({ data: [] as LoyaltyTierPolicyView[] })),
        (canReadConfiguration
          ? api.getEndpoint<{ data: RedemptionConfigurationView }>('/api/staff/loyalty/redemption-configuration')
          : Promise.resolve({ data: null })),
        (canManageCatalog
          ? api.getEndpoint<{ data: unknown }>('/api/catalog/products?status=active&limit=100')
          : Promise.resolve({ data: [] })),
        (canReadPending
          ? api.getEndpoint<{ data: PendingRedemptionView[] }>('/api/staff/loyalty/redemptions/pending')
          : Promise.resolve({ data: [] as PendingRedemptionView[] })),
      ])
      setTiers(Array.isArray(tierResponse.data) ? tierResponse.data : [])
      setConfig(configurationResponse.data)
      setProducts(redemptionProducts(productResponse.data))
      setPending(Array.isArray(pendingResponse.data) ? pendingResponse.data : [])
    } catch (error) { setNotice(error instanceof Error ? error.message : '等级与兑换配置读取失败') }
  }

  useEffect(() => { void load() }, [canView, canManageCatalog, canReadConfiguration, canReadPending])
  if (!canView && !canManage && !canApprove && !canPublish && !canManageCatalog
    && !canApproveCatalog && !canPublishCatalog && !canControl && !canFulfill && !canHandleException) return null

  async function draftTier(event: FormEvent) {
    event.preventDefault(); if (busy) return
    const silver = decimalRatio(tierForm.silverMultiplier, '银卡积分倍率')
    const gold = decimalRatio(tierForm.goldMultiplier, '金卡积分倍率')
    setBusy('tier-draft'); setNotice('')
    try {
      await api.postEndpoint('/api/staff/loyalty/tier-policies', {
        evaluationWindowMonths: positiveInteger(tierForm.evaluationWindowMonths, '评估窗口'),
        tierPeriodMonths: positiveInteger(tierForm.tierPeriodMonths, '等级周期'),
        downgradeGraceDays: nonNegativeIntegerText(tierForm.downgradeGraceDays, '降级宽限'),
        silverUpgradeGrowth: positiveInteger(tierForm.silverUpgradeGrowth, '银卡升级值'),
        silverRetainGrowth: nonNegativeIntegerText(tierForm.silverRetainGrowth, '银卡保级值'),
        goldUpgradeGrowth: positiveInteger(tierForm.goldUpgradeGrowth, '金卡升级值'),
        goldRetainGrowth: nonNegativeIntegerText(tierForm.goldRetainGrowth, '金卡保级值'),
        silverPointsMultiplierNumerator: silver.numerator,
        silverPointsMultiplierDenominator: silver.denominator,
        goldPointsMultiplierNumerator: gold.numerator,
        goldPointsMultiplierDenominator: gold.denominator,
        reason: tierForm.reason.trim(),
      }, { idempotencyKey: `loyalty-tier-draft-${crypto.randomUUID()}` })
      setNotice('等级规则已保存为草稿，需另一名授权人员复核。'); await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '等级规则草稿未保存') }
    finally { setBusy('') }
  }

  function approveTier(_policy: LoyaltyTierPolicyView) {
    setNotice('审批已移至上方“会员经营配置中心”：客户端勾选“已看影响”不再具有审批效力。')
    window.dispatchEvent(new Event('mbox:open-membership-configuration'))
  }

  async function publishTier(policy: LoyaltyTierPolicyView) {
    const effectiveFrom = (await promptAction({
      title: '排期发布等级规则',
      description: '请输入 ISO 格式的生效时间。',
      label: '生效时间',
      confirmLabel: '继续',
      multiline: false,
    }))?.trim() ?? ''
    const reason = (await promptAction({
      title: '填写复核说明',
      description: '至少填写 2 个字，便于后续审计。',
      label: '复核说明',
      confirmLabel: '确认发布',
    }))?.trim() ?? ''
    if (!Number.isFinite(Date.parse(effectiveFrom)) || reason.length < 2) return setNotice('生效时间或复核说明不正确。')
    setBusy(`tier-${policy.id}`); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/loyalty/tier-policies/${encodeURIComponent(policy.id)}/publish`, {
        effectiveFrom: new Date(effectiveFrom).toISOString(), effectiveUntil: null,
        reason,
      }, { idempotencyKey: `loyalty-tier-publish-${crypto.randomUUID()}` })
      setNotice('等级规则已由第三名发布人排期；生效前旧规则继续运行。'); await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '等级规则未发布') }
    finally { setBusy('') }
  }

  async function draftCatalog(event: FormEvent) {
    event.preventDefault(); if (!config || busy) return
    const product = products.find((item) => item.id === itemForm.productId)
    if (!product) return setNotice('请选择有效商品。')
    const latestVersion = Math.max(0, ...config.items.map((item) => item.catalogVersion))
    const previous = config.items.filter((item) => item.catalogVersion === latestVersion && item.productId !== product.id)
    const now = new Date().toISOString()
    const publicId = `RED-${crypto.randomUUID()}`
    const items = [...previous.map(redemptionDraftItem), {
      publicId, itemCode: `ITEM_${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      name: product.name, fulfillmentKind: 'product', productId: product.id,
      benefitDefinitionId: null, activityId: null,
      pointsRequired: positiveInteger(itemForm.pointsRequired, '所需积分'),
      costAmountMinor: product.costAmountMinor, currency: 'CNY',
      totalInventory: optionalInteger(itemForm.totalInventory, '总库存'),
      dailyInventory: optionalInteger(itemForm.dailyInventory, '每日库存'),
      memberDailyLimit: positiveInteger(itemForm.memberDailyLimit, '每日个人上限'),
      memberRolling30DayLimit: positiveInteger(itemForm.memberRolling30DayLimit, '30天个人上限'),
      memberLifetimeLimit: null, minimumTier: itemForm.minimumTier,
      requiresTableSession: true, requiresEmployeeFulfillment: true,
      cancellationAllowedBeforeFulfillment: true, restoreExpiredPointsDays: 7,
      availableFrom: itemForm.availableFrom ? localDateTimeIso(itemForm.availableFrom, '开始时间') : now,
      availableUntil: itemForm.availableUntil ? localDateTimeIso(itemForm.availableUntil, '结束时间') : null,
      fulfillmentTimeoutMinutes: 240, display: { description: itemForm.description.trim() },
    }]
    setBusy('catalog-draft'); setNotice('')
    try {
      await api.postEndpoint('/api/staff/loyalty/redemption-catalogs', {
        reason: itemForm.reason.trim(), items,
      }, { idempotencyKey: `loyalty-redemption-catalog-${crypto.randomUUID()}` })
      setNotice('已生成包含现有兑换项的新目录草稿，旧发布版本未改变。'); await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '兑换目录草稿未保存') }
    finally { setBusy('') }
  }

  function approveCatalog(_version: RedemptionConfigurationView['versions'][number]) {
    setNotice('审批已移至上方“会员经营配置中心”：系统会重新计算成本、库存和履约影响。')
    window.dispatchEvent(new Event('mbox:open-membership-configuration'))
  }

  async function publishCatalog(version: RedemptionConfigurationView['versions'][number]) {
    const effectiveFrom = (await promptAction({
      title: '排期发布兑换目录',
      description: '请输入 ISO 格式的目录生效时间。',
      label: '生效时间',
      confirmLabel: '继续',
      multiline: false,
    }))?.trim() ?? ''
    const reason = (await promptAction({
      title: '填写复核说明',
      description: '请确认已复核积分、成本、库存和履约，并填写说明。',
      label: '复核说明',
      confirmLabel: '确认发布',
    }))?.trim() ?? ''
    if (!Number.isFinite(Date.parse(effectiveFrom)) || reason.length < 2) return setNotice('生效时间或复核说明不正确。')
    setBusy(`catalog-${version.id}`); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/loyalty/redemption-catalogs/${encodeURIComponent(version.id)}/publish`, {
        effectiveFrom: new Date(effectiveFrom).toISOString(), effectiveUntil: null,
        reason,
      }, { idempotencyKey: `loyalty-redemption-publish-${crypto.randomUUID()}` })
      setNotice('兑换目录已由第三名发布人排期，仍需单独开放运行开关。'); await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '兑换目录未发布') }
    finally { setBusy('') }
  }

  async function setControl(state: 'disabled' | 'pilot' | 'enabled' | 'paused') {
    const stateLabel = state === 'enabled' ? '正式开放' : state === 'pilot' ? '试点开放' : '暂停/关闭'
    const reason = (await promptAction({
      title: `变更为${stateLabel}`,
      description: '请填写变更原因，至少 2 个字。',
      label: '变更原因',
      confirmLabel: '继续',
    }))?.trim() ?? ''
    if (reason.length < 2) return setNotice('变更原因不足。')
    const pilotStartsAt = state === 'pilot' ? (await promptAction({
      title: '设置试点开始时间', description: '请输入 ISO 格式的时间。', label: '开始时间', confirmLabel: '继续', multiline: false,
    }))?.trim() ?? '' : null
    const pilotEndsAt = state === 'pilot' ? (await promptAction({
      title: '设置试点结束时间', description: '请输入 ISO 格式的时间。', label: '结束时间', confirmLabel: '确认变更', multiline: false,
    }))?.trim() ?? '' : null
    if (state === 'pilot' && (!Number.isFinite(Date.parse(pilotStartsAt!)) || !Number.isFinite(Date.parse(pilotEndsAt!)))) return setNotice('试点时间不正确。')
    setBusy(`control-${state}`); setNotice('')
    try {
      await api.putEndpoint('/api/staff/loyalty/redemption-control', {
        state, pilotStartsAt: pilotStartsAt ? new Date(pilotStartsAt).toISOString() : null,
        pilotEndsAt: pilotEndsAt ? new Date(pilotEndsAt).toISOString() : null, reason,
      }, { idempotencyKey: `loyalty-redemption-control-${crypto.randomUUID()}` })
      setNotice('兑换运行状态已更新，历史兑换记录不受影响。'); await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '兑换状态未更新') }
    finally { setBusy('') }
  }

  async function fulfill(publicId: string) {
    const reason = (await promptAction({
      title: '确认实际交付',
      description: '请填写实际交付说明，至少 2 个字。',
      label: '交付说明',
      confirmLabel: '确认交付',
    }))?.trim() ?? ''
    if (reason.length < 2) return setNotice('交付说明不足。')
    setBusy(`fulfill-${publicId}`); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/loyalty/redemptions/${encodeURIComponent(publicId)}/fulfill`, { reason }, {
        idempotencyKey: `loyalty-redemption-fulfill-${crypto.randomUUID()}`,
      })
      setNotice('已记录实际交付及对应商品、活动、服务或权益事实。'); await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '兑换未完成交付') }
    finally { setBusy('') }
  }

  async function failRedemption(item: PendingRedemptionView) {
    if (busy) return
    const failureCode = ({
      product: 'product_unavailable', benefit: 'benefit_unavailable',
      activity: 'activity_unavailable', service: 'service_unavailable',
    } as Record<string,string>)[item.fulfillmentKind] ?? 'technical_failure'
    const reason = (await promptAction({
      title: '处理未履约兑换',
      description: `仅当“${item.itemName}”确认尚未制作、发放或交付时才能返还积分。`,
      label: '无法履约的具体原因',
      confirmLabel: '继续',
    }))?.trim() ?? ''
    if (reason.length<2) return setNotice('失败说明不足，未处理。')
    if (!(await confirmAction({title:'确认按原批次返还积分',description:`${item.memberNo} 的“${item.itemName}”尚未履约，系统将按原批次返还积分。`,confirmLabel:'确认返还',tone:'danger'}))) return
    setBusy(`fail-${item.publicId}`); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/loyalty/redemptions/${encodeURIComponent(item.publicId)}/fail`, {
        failureCode, reason, confirmedUnfulfilled: true,
      }, { idempotencyKey: `loyalty-redemption-fail-${crypto.randomUUID()}` })
      setNotice('已记录门店无法履约；只有确认尚未履约的兑换会按原批次返还。'); await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '兑换失败处理没有完成') }
    finally { setBusy('') }
  }

  return <section className="staff-module-summary loyalty-policy-panel"><div>
    <strong>等级与积分兑换</strong>
    <small>店长起草、运营复核、老板发布；未来版本生效前旧规则继续运行。兑换开关和实际交付另行控制。</small>
    {notice && <p className="staff-module-notice" role="status">{notice}</p>}
    {canManage && <form className="staff-module-form" onSubmit={(event) => void draftTier(event)}>
      <label>银卡升级成长值<input type="number" min="1" value={tierForm.silverUpgradeGrowth} onChange={(event) => setTierForm({ ...tierForm, silverUpgradeGrowth: event.target.value })} /></label>
      <label>银卡保级成长值<input type="number" min="0" value={tierForm.silverRetainGrowth} onChange={(event) => setTierForm({ ...tierForm, silverRetainGrowth: event.target.value })} /></label>
      <label>金卡升级成长值<input type="number" min="1" value={tierForm.goldUpgradeGrowth} onChange={(event) => setTierForm({ ...tierForm, goldUpgradeGrowth: event.target.value })} /></label>
      <label>金卡保级成长值<input type="number" min="0" value={tierForm.goldRetainGrowth} onChange={(event) => setTierForm({ ...tierForm, goldRetainGrowth: event.target.value })} /></label>
      <label>银卡积分倍率<input inputMode="decimal" value={tierForm.silverMultiplier} onChange={(event) => setTierForm({ ...tierForm, silverMultiplier: event.target.value })} /></label>
      <label>金卡积分倍率<input inputMode="decimal" value={tierForm.goldMultiplier} onChange={(event) => setTierForm({ ...tierForm, goldMultiplier: event.target.value })} /></label>
      <label>评估窗口（月）<input type="number" min="1" max="36" value={tierForm.evaluationWindowMonths} onChange={(event) => setTierForm({ ...tierForm, evaluationWindowMonths: event.target.value })} /></label>
      <label>等级周期（月）<input type="number" min="1" max="36" value={tierForm.tierPeriodMonths} onChange={(event) => setTierForm({ ...tierForm, tierPeriodMonths: event.target.value })} /></label>
      <label>降级宽限（天）<input type="number" min="0" max="180" value={tierForm.downgradeGraceDays} onChange={(event) => setTierForm({ ...tierForm, downgradeGraceDays: event.target.value })} /></label>
      <label>配置原因<input required minLength={2} maxLength={500} value={tierForm.reason} onChange={(event) => setTierForm({ ...tierForm, reason: event.target.value })} /></label>
      <button type="submit" disabled={Boolean(busy)}>保存等级草稿</button>
    </form>}
    <div className="activity-admin-list">{tiers.map((policy) => <article key={policy.id}><div><strong>等级版本 {policy.version} · {releaseStatusLabel(policy.status)}</strong><small>银卡 {policy.silverUpgradeGrowth}/{policy.silverRetainGrowth}；金卡 {policy.goldUpgradeGrowth}/{policy.goldRetainGrowth}；宽限 {policy.downgradeGraceDays} 天</small><small>{policy.effectiveFrom ? `生效 ${new Date(policy.effectiveFrom).toLocaleString('zh-CN')} · ` : ''}{policy.reason}</small></div><div className="staff-inline-actions">{policy.status === 'draft' && canApprove && policy.draftedByEmployeeId !== auth.employee.id && <button type="button" onClick={() => void approveTier(policy)}>前往配置中心审批</button>}{policy.status === 'approved' && canPublish && policy.draftedByEmployeeId !== auth.employee.id && policy.approvedByEmployeeId !== auth.employee.id && <button type="button" onClick={() => void publishTier(policy)}>排期发布</button>}</div></article>)}</div>
    {canManageCatalog && <form className="staff-module-form" onSubmit={(event) => void draftCatalog(event)}>
      <label>兑换商品<select required value={itemForm.productId} onChange={(event) => setItemForm({ ...itemForm, productId: event.target.value })}><option value="">请选择</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name} · 成本{money(product.costAmountMinor)}</option>)}</select></label>
      <label>所需积分<input required type="number" min="1" value={itemForm.pointsRequired} onChange={(event) => setItemForm({ ...itemForm, pointsRequired: event.target.value })} /></label>
      <label>总库存（留空不限）<input type="number" min="0" value={itemForm.totalInventory} onChange={(event) => setItemForm({ ...itemForm, totalInventory: event.target.value })} /></label>
      <label>每日库存（留空不限）<input type="number" min="0" value={itemForm.dailyInventory} onChange={(event) => setItemForm({ ...itemForm, dailyInventory: event.target.value })} /></label>
      <label>每日个人上限<input type="number" min="1" max="100" value={itemForm.memberDailyLimit} onChange={(event) => setItemForm({ ...itemForm, memberDailyLimit: event.target.value })} /></label>
      <label>30天个人上限<input type="number" min="1" max="500" value={itemForm.memberRolling30DayLimit} onChange={(event) => setItemForm({ ...itemForm, memberRolling30DayLimit: event.target.value })} /></label>
      <label>最低等级<select value={itemForm.minimumTier} onChange={(event) => setItemForm({ ...itemForm, minimumTier: event.target.value })}><option value="member">普通会员</option><option value="silver">银卡</option><option value="gold">金卡</option></select></label>
      <label>开始时间<input type="datetime-local" value={itemForm.availableFrom} onChange={(event) => setItemForm({ ...itemForm, availableFrom: event.target.value })} /></label>
      <label>结束时间（可选）<input type="datetime-local" value={itemForm.availableUntil} onChange={(event) => setItemForm({ ...itemForm, availableUntil: event.target.value })} /></label>
      <label>客户说明<input maxLength={300} value={itemForm.description} onChange={(event) => setItemForm({ ...itemForm, description: event.target.value })} /></label>
      <label>配置原因<input required minLength={2} maxLength={500} value={itemForm.reason} onChange={(event) => setItemForm({ ...itemForm, reason: event.target.value })} /></label>
      <button type="submit" disabled={Boolean(busy)}>保存完整目录草稿</button>
    </form>}
    <div className="activity-admin-list"><header><strong>兑换目录与开关</strong><small>当前状态：{config?.control.state ?? 'disabled'}；{config?.control.reason ?? '尚未配置'}</small></header>
      {config?.versions.map((version) => <article key={version.id}><div><strong>目录版本 {version.version} · {releaseStatusLabel(version.status)}</strong><small>{version.itemCount}项 · {version.reason}</small></div><div className="staff-inline-actions">{version.status === 'draft' && canApproveCatalog && version.draftedByEmployeeId !== auth.employee.id && <button type="button" onClick={() => void approveCatalog(version)}>前往配置中心审批</button>}{version.status === 'approved' && canPublishCatalog && version.draftedByEmployeeId !== auth.employee.id && version.approvedByEmployeeId !== auth.employee.id && <button type="button" onClick={() => void publishCatalog(version)}>排期发布</button>}</div></article>)}
      {canControl && <div className="staff-module-actions"><button type="button" onClick={() => void setControl('pilot')}>试点开放</button><button type="button" onClick={() => void setControl('enabled')}>正式开放</button><button type="button" onClick={() => void setControl('paused')}>暂停</button><button type="button" onClick={() => void setControl('disabled')}>关闭</button></div>}
    </div>
    {(canFulfill || canHandleException) && <div className="activity-admin-list"><header><strong>待实际交付</strong><small>商品须到KDS完成；确认尚未履约的门店失败才允许按原积分批次返还</small></header>{pending.length === 0 && <p>当前没有待交付兑换。</p>}{pending.map((item) => <article key={item.publicId}><div><strong>{item.memberNo} · {item.itemName}</strong><small>{item.pointsUsed}积分 · {item.fulfillmentKind} · 截止{new Date(item.expiresAt).toLocaleString('zh-CN')}</small></div><div className="staff-inline-actions">{canFulfill && <button type="button" disabled={Boolean(busy)} onClick={() => void fulfill(item.publicId)}>确认已交付</button>}{canHandleException && <button type="button" className="is-danger" disabled={Boolean(busy)} onClick={() => void failRedemption(item)}>确认未履约并返还</button>}</div></article>)}</div>}
  </div></section>
}

function LoyaltyPolicyPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const { promptAction } = useConfirmationDialog()
  const canView = auth.permissions.includes('loyalty.policy.view')
  const canManage = auth.permissions.includes('loyalty.policy.manage')
  const canApprove = auth.permissions.includes('loyalty.policy.approve')
  const canPublish = auth.permissions.includes('loyalty.policy.publish')
  const canRead = canView || canManage || canApprove || canPublish
  const canViewExceptions = auth.permissions.includes('loyalty.accrual.exception.view')
  const canRequestSupplement = auth.permissions.includes('loyalty.accrual.request')
  const canApproveSupplement = auth.permissions.includes('loyalty.accrual.approve')
  const [policies, setPolicies] = useState<LoyaltyPolicyView[]>([])
  const [reconciliation, setReconciliation] = useState<LoyaltyReconciliationView[]>([])
  const [supplements, setSupplements] = useState<LoyaltySupplementView[]>([])
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState({
    pointsNumerator: '1', pointsDenominatorMinor: '100',
    growthNumerator: '1', growthDenominatorMinor: '100',
    roundingMode: 'floor', pointsValidityMonths: '18', reason: '',
  })

  async function load() {
    try {
      const [policyResponse, reconciliationResponse, supplementResponse] = await Promise.all([
        canRead
          ? api.getEndpoint<{ data: LoyaltyPolicyView[] }>('/api/staff/loyalty/policies')
          : Promise.resolve({ data: [] }),
        canViewExceptions
          ? api.getEndpoint<{ data: LoyaltyReconciliationView[] }>('/api/staff/loyalty/reconciliation')
          : Promise.resolve({ data: [] }),
        canViewExceptions
          ? api.getEndpoint<{ data: LoyaltySupplementView[] }>('/api/staff/loyalty/supplement-requests')
          : Promise.resolve({ data: [] }),
      ])
      setPolicies(Array.isArray(policyResponse.data) ? policyResponse.data : [])
      setReconciliation(Array.isArray(reconciliationResponse.data) ? reconciliationResponse.data : [])
      setSupplements(Array.isArray(supplementResponse.data) ? supplementResponse.data : [])
    } catch (error) { setNotice(error instanceof Error ? error.message : '会员规则读取失败') }
  }

  useEffect(() => { void load() }, [canRead, canViewExceptions])
  if (!canView && !canManage && !canApprove && !canPublish && !canViewExceptions) return null

  async function draft(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy('draft'); setNotice('')
    try {
      await api.postEndpoint('/api/staff/loyalty/policies', {
        policyCode: 'BASE',
        pointsNumerator: nonNegativeIntegerText(form.pointsNumerator, '积分比例分子'),
        pointsDenominatorMinor: positiveInteger(form.pointsDenominatorMinor, '积分比例分母'),
        growthNumerator: nonNegativeIntegerText(form.growthNumerator, '成长值比例分子'),
        growthDenominatorMinor: positiveInteger(form.growthDenominatorMinor, '成长值比例分母'),
        roundingMode: form.roundingMode,
        pointsValidityMonths: positiveInteger(form.pointsValidityMonths, '积分有效月数'),
        reason: form.reason.trim(),
      }, { idempotencyKey: `loyalty-policy-draft-${crypto.randomUUID()}` })
      setNotice('新规则已保存为草稿，必须由另一名授权人员复核后才会生效。')
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '会员规则草稿未保存') }
    finally { setBusy('') }
  }

  function approve(_policy: LoyaltyPolicyView) {
    setNotice('审批已移至上方“会员经营配置中心”：必须使用服务端持久化的限时影响预览。')
    window.dispatchEvent(new Event('mbox:open-membership-configuration'))
  }

  async function publish(policy: LoyaltyPolicyView) {
    const effectiveFrom = (await promptAction({
      title: '排期发布积分规则',
      description: '请输入 ISO 格式的生效时间，例如 2026-08-20T12:00:00+08:00。',
      label: '生效时间',
      confirmLabel: '继续',
      multiline: false,
    }))?.trim()
    if (!effectiveFrom || !Number.isFinite(Date.parse(effectiveFrom))) return setNotice('生效时间格式不正确，未发布。')
    const reason = (await promptAction({
      title: '填写发布说明',
      description: '至少填写 2 个字，便于后续审计。',
      label: '发布说明',
      confirmLabel: '确认发布',
    }))?.trim() ?? ''
    if (reason.length < 2) return setNotice('发布说明不足，未发布。')
    setBusy(policy.id); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/loyalty/policies/${encodeURIComponent(policy.id)}/publish`, {
        effectiveFrom: new Date(effectiveFrom).toISOString(), effectiveUntil: null, reason,
      }, { idempotencyKey: `loyalty-policy-publish-${crypto.randomUUID()}` })
      setNotice('规则已由第三名发布人排期；生效前旧规则继续运行，历史订单仍使用原规则版本。')
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '会员规则未发布') }
    finally { setBusy('') }
  }

  async function requestSupplement(item: LoyaltyReconciliationView) {
    const reason = (await promptAction({
      title: '申请积分补发',
      description: `请填写订单 ${item.orderPublicId} 的补发原因，至少 2 个字。`,
      label: '申请原因',
      confirmLabel: '提交申请',
    }))?.trim() ?? ''
    if (reason.length < 2) return setNotice('申请原因不足，未提交。')
    setBusy(`request-${item.orderPublicId}`); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/loyalty/accrual-exceptions/${encodeURIComponent(item.orderPublicId)}/requests`, {
        reason,
      }, { idempotencyKey: `loyalty-supplement-request-${crypto.randomUUID()}` })
      setNotice('补发申请已提交，必须由另一名授权人员复核。')
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '补发申请未提交') }
    finally { setBusy('') }
  }

  async function decideSupplement(item: LoyaltySupplementView, decision: 'approve' | 'reject') {
    const label = decision === 'approve' ? '复核说明' : '驳回原因'
    const reason = (await promptAction({
      title: decision === 'approve' ? '复核补发申请' : '驳回补发申请',
      description: `${label}至少填写 2 个字。`,
      label,
      confirmLabel: decision === 'approve' ? '确认复核' : '确认驳回',
    }))?.trim() ?? ''
    if (reason.length < 2) return setNotice(`${label}不足，未处理。`)
    setBusy(`${decision}-${item.publicId}`); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/loyalty/supplement-requests/${encodeURIComponent(item.publicId)}/${decision}`, {
        reason,
      }, { idempotencyKey: `loyalty-supplement-${decision}-${crypto.randomUUID()}` })
      setNotice(decision === 'approve' ? '补发已复核并原子入账。' : '补发申请已驳回。')
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '补发申请未处理') }
    finally { setBusy('') }
  }

  return <section className="staff-module-summary loyalty-policy-panel">
    <div>
      <strong>积分与成长值规则</strong>
      <small>积分与成长值分账；起草、审批、发布由不同人员完成，未来排期不会让当前规则提前失效。</small>
      {notice && <p className="staff-module-notice" role="status">{notice}</p>}
      {canManage && <form className="staff-module-form" onSubmit={(event) => void draft(event)}>
        <label>每多少分消费<input type="number" min="1" value={form.pointsDenominatorMinor} onChange={(event) => setForm({ ...form, pointsDenominatorMinor: event.target.value })} /></label>
        <label>获得积分<input type="number" min="0" value={form.pointsNumerator} onChange={(event) => setForm({ ...form, pointsNumerator: event.target.value })} /></label>
        <label>每多少分消费获得成长值<input type="number" min="1" value={form.growthDenominatorMinor} onChange={(event) => setForm({ ...form, growthDenominatorMinor: event.target.value })} /></label>
        <label>成长值<input type="number" min="0" value={form.growthNumerator} onChange={(event) => setForm({ ...form, growthNumerator: event.target.value })} /></label>
        <label>取整方式<select value={form.roundingMode} onChange={(event) => setForm({ ...form, roundingMode: event.target.value })}><option value="floor">向下取整</option><option value="nearest">四舍五入</option></select></label>
        <label>积分有效期（月）<input type="number" min="1" max="120" value={form.pointsValidityMonths} onChange={(event) => setForm({ ...form, pointsValidityMonths: event.target.value })} /></label>
        <label>配置原因<input required minLength={2} maxLength={500} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} /></label>
        <button type="submit" disabled={busy === 'draft'}>{busy === 'draft' ? '正在保存' : '保存新版本草稿'}</button>
      </form>}
      <div className="activity-admin-list">
        {policies.map((policy) => <article key={policy.id}>
          <div><strong>版本 {policy.version} · {releaseStatusLabel(policy.status)}</strong><small>{policy.pointsDenominatorMinor}分消费得{policy.pointsNumerator}积分；{policy.growthDenominatorMinor}分消费得{policy.growthNumerator}成长值；有效{policy.pointsValidityMonths}个月</small><small>{policy.effectiveFrom ? `生效 ${new Date(policy.effectiveFrom).toLocaleString('zh-CN')} · ` : ''}{policy.reason}</small></div>
          <div className="staff-inline-actions">{policy.status === 'draft' && canApprove && policy.draftedByEmployeeId !== auth.employee.id && <button type="button" disabled={Boolean(busy)} onClick={() => void approve(policy)}>前往配置中心审批</button>}{policy.status === 'approved' && canPublish && policy.draftedByEmployeeId !== auth.employee.id && policy.approvedByEmployeeId !== auth.employee.id && <button type="button" disabled={Boolean(busy)} onClick={() => void publish(policy)}>排期发布</button>}</div>
        </article>)}
      </div>
      {canViewExceptions && <div className="activity-admin-list">
        <header><strong>自动积分对账</strong><small>只按已付款订单、冻结计分资格和原规则版本计算</small></header>
        {reconciliation.filter((item) => item.status !== 'matched').length === 0 && <p>当前没有待补发差异。</p>}
        {reconciliation.filter((item) => item.status !== 'matched').map((item) => <article key={item.orderPublicId}>
          <div><strong>{item.memberNo} · {item.orderPublicId}</strong><small>应发 {item.expectedPoints} 积分 / {item.expectedGrowth} 成长值；已发 {item.existingPoints} / {item.existingGrowth}</small></div>
          <div>{canRequestSupplement && <button type="button" disabled={busy === `request-${item.orderPublicId}`} onClick={() => void requestSupplement(item)}>申请补发</button>}</div>
        </article>)}
      </div>}
      {canViewExceptions && <div className="activity-admin-list">
        <header><strong>补发审批</strong><small>申请人与复核人必须是不同员工</small></header>
        {supplements.length === 0 && <p>还没有补发申请。</p>}
        {supplements.map((item) => <article key={item.publicId}>
          <div><strong>{item.memberNo} · {item.status === 'requested' ? '待复核' : item.status === 'executed' ? '已入账' : item.status === 'rejected' ? '已驳回' : item.status}</strong><small>{item.requestedByName}申请：{item.requestedPoints}积分 / {item.requestedGrowth}成长值</small><small>{item.reason}</small></div>
          <div>{item.status === 'requested' && canApproveSupplement && item.requestedByEmployeeId !== auth.employee.id && <><button type="button" disabled={Boolean(busy)} onClick={() => void decideSupplement(item, 'approve')}>复核通过</button><button type="button" disabled={Boolean(busy)} onClick={() => void decideSupplement(item, 'reject')}>驳回</button></>}</div>
        </article>)}
      </div>}
    </div>
  </section>
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
    paymentMode: mode as ActivitySummary['paymentMode'], paymentDeadlineMinutes: nonNegativeInteger(row.paymentDeadlineMinutes), paymentRuleText: text(row.paymentRuleText),
  }
}
function releaseStatusLabel(value: string) {
  return ({
    draft: '草稿', approved: '已审批', published: '已发布/已排期',
    paused: '已暂停', retired: '已停用',
  } as Record<string, string>)[value] ?? value
}
function positiveInteger(value: string, label: string) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label}必须是正整数`); return number }
function nonNegativeIntegerText(value: string, label: string) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label}必须是非负整数`); return number }
function optionalInteger(value: string, label: string) { if (value.trim() === '') return null; return nonNegativeIntegerText(value, label) }
function decimalRatio(value: string, label: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(value)) throw new Error(`${label}最多保留三位小数`)
  const fraction = value.split('.')[1]?.length ?? 0
  const denominator = 10 ** fraction
  const numerator = Math.round(Number(value) * denominator)
  if (numerator < 1) throw new Error(`${label}必须大于0`)
  return { numerator, denominator }
}
function redemptionProducts(value: unknown): RedemptionProductOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return []
    const row = candidate as Record<string, unknown>
    return typeof row.id === 'string' && typeof row.name === 'string' && typeof row.code === 'string'
      && Number.isSafeInteger(row.costAmountMinor) && Number(row.costAmountMinor) >= 0
      && row.status === 'active'
      ? [{ id: row.id, name: row.name, code: row.code, costAmountMinor: Number(row.costAmountMinor) }] : []
  })
}
function redemptionDraftItem(item: RedemptionCatalogItemAdmin) {
  return {
    publicId: item.publicId, itemCode: item.itemCode, name: item.name,
    fulfillmentKind: item.fulfillmentKind, productId: item.productId,
    benefitDefinitionId: item.benefitDefinitionId, activityId: item.activityId,
    pointsRequired: item.pointsRequired, costAmountMinor: item.costAmountMinor, currency: item.currency,
    totalInventory: item.totalInventory, dailyInventory: item.dailyInventory,
    memberDailyLimit: item.memberDailyLimit,
    memberRolling30DayLimit: item.memberRolling30DayLimit,
    memberLifetimeLimit: item.memberLifetimeLimit, minimumTier: item.minimumTier,
    requiresTableSession: item.requiresTableSession,
    requiresEmployeeFulfillment: item.requiresEmployeeFulfillment,
    cancellationAllowedBeforeFulfillment: item.cancellationAllowedBeforeFulfillment,
    restoreExpiredPointsDays: item.restoreExpiredPointsDays,
    availableFrom: item.availableFrom, availableUntil: item.availableUntil,
    fulfillmentTimeoutMinutes: item.fulfillmentTimeoutMinutes, display: item.display,
  }
}
function localDateTimeIso(value: string, label: string) { const timestamp = Date.parse(value); if (!Number.isFinite(timestamp)) throw new Error(`${label}不正确`); return new Date(timestamp).toISOString() }
function money(value: number) { return `¥${(value / 100).toFixed(value % 100 === 0 ? 0 : 2)}` }
function record(value: unknown): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('客户体验数据格式不正确'); return value as Record<string, unknown> }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error('客户体验列表格式不正确'); return value }
function text(value: unknown): string { if (typeof value !== 'string') throw new Error('客户体验文字格式不正确'); return value }
function nonNegativeInteger(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('客户体验数字格式不正确'); return Number(value) }
