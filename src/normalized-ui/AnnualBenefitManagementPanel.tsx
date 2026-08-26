import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import { useConfirmationDialog } from './ConfirmationDialog'

type RuleKind = 'birthday' | 'festival' | 'priority_seating' | 'daily_snack'
type Tier = 'member' | 'silver' | 'gold'
type AlcoholHandling = 'not_applicable' | 'non_alcoholic_only' | 'staff_compliance_required'
type InventoryRequirement = 'not_applicable' | 'strict_recipe'
type RevocationPolicy = 'cancel_before_redeem' | 'expire_only' | 'manual_compensation'
type Feb29Policy = 'feb28' | 'mar01' | 'leap_year_only'

interface Rule {
  id: string
  policyVersionId: string
  ruleCode: string
  title: string
  ruleKind: RuleKind
  eligibleTier: Tier
  inheritToHigherTiers: boolean
  benefitDefinitionId: string
  quantity: number
  validityDays: number
  windowBeforeDays: number
  windowAfterDays: number
  onSiteOnly: boolean
  requiresTableSession: boolean
  memberDailyLimit: number
  tableDailyLimit: number
  alcoholHandling: AlcoholHandling
  stackGroup: string
  priority: number
  inventoryRequirement: InventoryRequirement
  revocationPolicy: RevocationPolicy
  feb29Policy: Feb29Policy | null
  substitutes: { productId: string; priority: number; reason: string }[]
  reservationHoldMinutes: number | null
  redemptionHoldMinutes: number | null
  enabled: boolean
}

interface Policy {
  id: string
  policyCode: string
  version: number
  status: 'draft' | 'approved' | 'published' | 'paused' | 'retired'
  timezone: string
  effectiveFrom: string | null
  effectiveUntil: string | null
  draftedByEmployeeId: string
  approvedByEmployeeId: string | null
  publishedByEmployeeId: string | null
  reason: string
}

interface Occurrence { id: string; ruleId: string; cycleYear: number; startsOn: string; endsOn: string; confirmationReference: string; confirmedAt: string }
interface Definition { id: string; name: string; benefitKind: string; status: string }
interface ProductOption { id: string; name: string; status: string }
interface Configuration { policies: Policy[]; rules: Rule[]; occurrences: Occurrence[]; definitions: Definition[]; products: ProductOption[] }
interface DailySnackClaim { id: string; claimCode: string; quantity: number; status: 'reserved' | 'redeemed' | 'fulfilled' | 'cancelled' | 'expired' | 'cancelled_after_redemption' | 'compensated'; expiresAt: string | null; redeemedByEmployeeName: string | null; redeemedAt: string | null; fulfilledAt: string | null; title: string; tableCode?: string }
interface AnnualGiftReservation {
  reservationId: string; benefitId: string; customerId: string; tableSessionId: string; tableCode: string
  memberNo: string | null; customerName: string | null; ruleKind: 'birthday' | 'festival'; title: string
  quantity: number; reservedAt: string; expiresAt: string; originalProductId: string; originalProductName: string
  allowedProducts: Array<{ productId: string; name: string; isOriginal: boolean; configuredReason: string | null }>
}
interface ComplimentaryFulfillmentException {
  id:string;orderId:string;benefitId:string;tableSessionId:string;tableCode:string;orderPublicId:string
  status:'retry'|'failed';attemptCount:number;lastErrorCode:string|null;lastErrorAt:string|null
  memberNo:string|null;customerName:string|null;title:string|null;updatedAt:string
}

type RuleDraft = Omit<Rule, 'id' | 'policyVersionId'>

const tierLabels: Record<Tier, string> = { member: '普卡', silver: '银卡', gold: '金卡' }
const ruleLabels: Record<RuleKind, string> = { birthday: '生日礼遇', festival: '节日礼遇', priority_seating: '优先排座', daily_snack: '到店落座小食' }
const statusLabels: Record<Policy['status'], string> = { draft: '草稿', approved: '待发布', published: '已发布', paused: '已暂停', retired: '已停用' }

export function AnnualBenefitManagementPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const { confirmAction, promptAction } = useConfirmationDialog()
  const canView = auth.permissions.includes('loyalty.annual-benefit.view')
  const canManage = auth.permissions.includes('loyalty.annual-benefit.manage')
  const canApprove = auth.permissions.includes('loyalty.annual-benefit.approve')
  const canPublish = auth.permissions.includes('loyalty.annual-benefit.publish')
  const canConfirmOccurrence = auth.permissions.includes('loyalty.annual-benefit.occurrence.confirm')
  const canFulfill = auth.permissions.includes('loyalty.redemption.fulfill')
  const canHandleException=auth.permissions.includes('loyalty.redemption.exception')
  const canConfigure = canView || canManage || canApprove || canPublish || canConfirmOccurrence
  const [configuration, setConfiguration] = useState<Configuration | null>(null)
  const [dailySnackClaims, setDailySnackClaims] = useState<DailySnackClaim[]>([])
  const [annualGiftReservations, setAnnualGiftReservations] = useState<AnnualGiftReservation[]>([])
  const [fulfillmentExceptions,setFulfillmentExceptions]=useState<ComplimentaryFulfillmentException[]>([])
  const [giftSelections, setGiftSelections] = useState<Record<string, { productId: string; reason: string }>>({})
  const [policyCode, setPolicyCode] = useState('ANNUAL')
  const [reason, setReason] = useState('')
  const [draftRule, setDraftRule] = useState<RuleDraft>(blankRule())
  const [draftRules, setDraftRules] = useState<RuleDraft[]>([])
  const [occurrence, setOccurrence] = useState({ ruleId: '', cycleYear: String(new Date().getFullYear()), startsOn: '', endsOn: '', confirmationReference: '' })
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')

  const festivalRules = useMemo(() => (configuration?.rules ?? []).filter((rule) => rule.ruleKind === 'festival'), [configuration])
  async function load() {
    try {
      if (canView) {
        const response = await api.getEndpoint<{ data: Configuration }>('/api/staff/loyalty/annual-benefit-policies')
        setConfiguration(response.data)
        setOccurrence((current) => ({ ...current, ruleId: current.ruleId || response.data.rules.find((rule) => rule.ruleKind === 'festival')?.id || '' }))
      }
      if (canFulfill) {
        const [snacks,gifts] = await Promise.all([
          api.getEndpoint<{ data: DailySnackClaim[] }>('/api/staff/annual-daily-snack-claims'),
          api.getEndpoint<{ data: AnnualGiftReservation[] }>('/api/staff/annual-benefit-reservations'),
        ])
        setDailySnackClaims(snacks.data)
        setAnnualGiftReservations(gifts.data)
        setGiftSelections((current) => Object.fromEntries(gifts.data.map((item) => [item.reservationId,
          current[item.reservationId] ?? { productId:item.originalProductId,reason:'' }])) )
      }
      if (canHandleException) {
        const response=await api.getEndpoint<{ data:ComplimentaryFulfillmentException[] }>(
          '/api/staff/complimentary-fulfillment-exceptions',
        )
        setFulfillmentExceptions(response.data)
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : '年度礼遇配置暂时无法读取') }
  }
  useEffect(() => { void load() }, [canView,canFulfill,canHandleException])
  if (!canView && !canManage && !canApprove && !canPublish && !canConfirmOccurrence && !canFulfill && !canHandleException) return null

  function updateRule(patch: Partial<RuleDraft>) { setDraftRule((current) => ({ ...current, ...patch })) }
  function changeKind(ruleKind: RuleKind) { setDraftRule((current) => ruleForKind({ ...current, ruleKind })) }
  function addRule() {
    try {
      validateRule(draftRule)
      if (draftRules.some((rule) => rule.ruleCode === draftRule.ruleCode)) throw new Error('同一份年度礼遇草稿中规则编号不能重复。')
      setDraftRules((current) => [...current, draftRule])
      setDraftRule((current) => ({ ...blankRule(), benefitDefinitionId: current.benefitDefinitionId }))
      setNotice('规则已加入草稿；保存后还需要独立审批和发布。')
    } catch (error) { setNotice(error instanceof Error ? error.message : '规则格式不正确') }
  }
  async function saveDraft(event: FormEvent) {
    event.preventDefault()
    if (!canManage || busy) return
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(policyCode.trim()) || reason.trim().length < 2 || draftRules.length === 0) {
      return setNotice('请填写有效政策编号、起草说明，并至少加入一条完整规则。')
    }
    setBusy('draft'); setNotice('')
    try {
      await api.postEndpoint('/api/staff/loyalty/annual-benefit-policies', {
        policyCode: policyCode.trim(), timezone: 'Asia/Shanghai', reason: reason.trim(), rules: draftRules,
      }, { idempotencyKey: `annual-benefit-draft-${crypto.randomUUID()}` })
      setDraftRules([]); setReason(''); setNotice('年度礼遇草稿已保存，审批人与发布人必须分别独立。'); await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '年度礼遇草稿未保存') }
    finally { setBusy('') }
  }
  async function approve(policy: Policy) {
    const approvalReason = (await promptAction({title:'填写审批说明',description:'至少2个字，会保留在审批审计中。',label:'审批说明',confirmLabel:'继续'}))?.trim() ?? ''
    if (approvalReason.length < 2) return setNotice('审批说明不足，未审批。')
    setBusy(`approve-${policy.id}`); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/loyalty/annual-benefit-policies/${policy.id}/approve`, { reason: approvalReason }, { idempotencyKey: `annual-benefit-approve-${crypto.randomUUID()}` })
      setNotice('年度礼遇草稿已完成独立审批，仍未向顾客生效。'); await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '年度礼遇审批未完成') }
    finally { setBusy('') }
  }
  async function publish(policy: Policy) {
    const effectiveFrom = (await promptAction({title:'填写未来生效时间',description:'使用 ISO 格式。',label:'生效时间',confirmLabel:'继续',multiline:false}))?.trim() ?? ''
    const publicationReason = (await promptAction({title:'填写发布说明',description:'至少2个字，会保留在发布审计中。',label:'发布说明',confirmLabel:'继续'}))?.trim() ?? ''
    if (!Number.isFinite(Date.parse(effectiveFrom)) || Date.parse(effectiveFrom) <= Date.now() || publicationReason.length < 2) {
      return setNotice('必须填写未来生效时间和发布说明，未发布。')
    }
    setBusy(`publish-${policy.id}`); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/loyalty/annual-benefit-policies/${policy.id}/publish`, {
        effectiveFrom: new Date(effectiveFrom).toISOString(), effectiveUntil: null, reason: publicationReason,
      }, { idempotencyKey: `annual-benefit-publish-${crypto.randomUUID()}` })
      setNotice('年度礼遇已排期发布；未来礼遇只展示预览，进入实际窗口才可能生成权益。'); await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '年度礼遇未发布') }
    finally { setBusy('') }
  }
  async function confirmOccurrence(event: FormEvent) {
    event.preventDefault()
    if (!canConfirmOccurrence || busy) return
    if (!occurrence.ruleId || !/^\d{4}$/.test(occurrence.cycleYear) || !/^\d{4}-\d{2}-\d{2}$/.test(occurrence.startsOn)
      || !/^\d{4}-\d{2}-\d{2}$/.test(occurrence.endsOn) || occurrence.confirmationReference.trim().length < 2) {
      return setNotice('请填写节日规则、同一年内的日期和确认依据。')
    }
    setBusy('occurrence'); setNotice('')
    try {
      await api.postEndpoint('/api/staff/loyalty/annual-benefit-occurrences', {
        ...occurrence, cycleYear: Number(occurrence.cycleYear), confirmationReference: occurrence.confirmationReference.trim(),
      }, { idempotencyKey: `annual-benefit-occurrence-${crypto.randomUUID()}` })
      setNotice('节日日期已确认；顾客端只会基于该确认结果展示对应窗口。'); await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '节日日期未确认') }
    finally { setBusy('') }
  }
  async function redeemDailySnack(claim: DailySnackClaim) {
    if (!canFulfill || busy || claim.status !== 'reserved') return
    if (!(await confirmAction({title:'确认核销会员礼遇',description:`核销“${claim.title}”后将提交零元订单与后厨制作任务，不能撤销。`,confirmLabel:'确认核销'}))) return
    setBusy(`daily-snack-${claim.id}`); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/annual-daily-snack-claims/${encodeURIComponent(claim.claimCode)}/redeem`, {}, {
        idempotencyKey: `annual-daily-snack-redeem-${crypto.randomUUID()}`,
      })
      setNotice('每日点心已核销；请在后厨任务或打印回执中确认实际出品。')
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '每日点心未核销') }
    finally { setBusy('') }
  }
  async function redeemAnnualGift(reservation: AnnualGiftReservation) {
    if (!canFulfill || busy) return
    const selection = giftSelections[reservation.reservationId]
      ?? { productId:reservation.originalProductId,reason:'' }
    const product = reservation.allowedProducts.find((item) => item.productId === selection.productId)
    if (!product) return setNotice('请选择这项礼遇已发布的原商品或合规替代品。')
    const reason = product.isOriginal ? null : selection.reason.trim()
    if (!product.isOriginal && (reason === null || reason.length < 2)) return setNotice('使用替代品必须填写至少2个字的替换原因。')
    if (!(await confirmAction({
      title:'确认核销会员礼遇',
      description:`为${reservation.tableCode}的${reservation.memberNo || '会员'}核销“${reservation.title}”？\n实际出品：${product.name} × ${reservation.quantity}${reason ? `\n替换原因：${reason}` : ''}\n确认后将预留库存并进入出品任务。`,
      confirmLabel:'确认核销',
    }))) return
    setBusy(`annual-gift-${reservation.reservationId}`); setNotice('')
    try {
      await api.postEndpoint(`/api/benefit-reservations/${reservation.reservationId}/redeem`, {
        benefitId:reservation.benefitId,customerId:reservation.customerId,tableSessionId:reservation.tableSessionId,
        selectedProductId:product.productId,substitutionReason:reason,
      }, { idempotencyKey:`annual-gift-redeem-${crypto.randomUUID()}` })
      setNotice('礼遇已核销并进入“待出品”；只有制作送达完成后才会显示“已完成”。')
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '年度礼遇未完成核销') }
    finally { setBusy('') }
  }
  async function cancelAnnualGift(reservation:AnnualGiftReservation) {
    if (!canFulfill||busy) return
    const cancelReason=(await promptAction({title:'填写取消暂留原因',description:`取消${reservation.tableCode}的“${reservation.title}”暂留。`,label:'取消原因',confirmLabel:'继续'}))?.trim()??''
    if (cancelReason.length<2) return setNotice('必须填写取消原因，礼遇暂留未释放。')
    setBusy(`annual-gift-cancel-${reservation.reservationId}`);setNotice('')
    try {
      await api.postEndpoint(`/api/staff/annual-benefit-reservations/${reservation.reservationId}/cancel`,{
        customerId:reservation.customerId,tableSessionId:reservation.tableSessionId,reason:cancelReason,
      },{idempotencyKey:`annual-gift-cancel-${crypto.randomUUID()}`})
      setNotice('生日或节日礼遇暂留已取消并释放；顾客端会更新状态。')
      await load()
    } catch(error) { setNotice(error instanceof Error?error.message:'年度礼遇暂留未取消') }
    finally { setBusy('') }
  }
  async function cancelDailySnack(claim: DailySnackClaim) {
    if (!canFulfill || busy || claim.status !== 'reserved') return
    const reason = (await promptAction({title:'填写取消暂留原因',description:`取消“${claim.title}”的暂留。`,label:'取消原因',confirmLabel:'继续'}))?.trim() ?? ''
    if (reason.length < 2) return setNotice('取消原因不足，未释放每日点心暂留。')
    setBusy(`daily-snack-cancel-${claim.id}`); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/annual-daily-snack-claims/${encodeURIComponent(claim.claimCode)}/cancel`, { reason }, {
        idempotencyKey: `annual-daily-snack-cancel-${crypto.randomUUID()}`,
      })
      setNotice('每日点心暂留已取消并释放；顾客端会更新为“已取消”。')
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '每日点心暂留未取消') }
    finally { setBusy('') }
  }

  async function retryComplimentaryFulfillment(item:ComplimentaryFulfillmentException) {
    if (!canHandleException||busy) return
    const retryReason=(await promptAction({title:'填写重新派发复核原因',description:`重新派发 ${item.tableCode} 的“${item.title||'会员礼遇'}”。`,label:'复核原因',confirmLabel:'继续'}))?.trim()??''
    if (retryReason.length<2) return setNotice('必须填写复核原因，未重新派发。')
    setBusy(`fulfillment-retry-${item.id}`);setNotice('')
    try {
      await api.postEndpoint(`/api/staff/complimentary-fulfillment-exceptions/${item.id}/retry`,{
        reason:retryReason,
      },{ idempotencyKey:`complimentary-fulfillment-retry-${crypto.randomUUID()}` })
      setNotice('已记录当前员工和复核原因，系统将可靠重试出品与打印任务。')
      await load()
    } catch (error) { setNotice(error instanceof Error?error.message:'礼遇履约未能重新派发') }
    finally { setBusy('') }
  }

  async function resolveComplimentaryCancellation(item:ComplimentaryFulfillmentException) {
    if (!canHandleException||busy||item.status!=='failed') return
    const reason=(await promptAction({title:'填写取消系统出品核对原因',description:`取消 ${item.tableCode} 的“${item.title||'会员礼遇'}”系统出品并释放库存。`,label:'核对原因',confirmLabel:'继续'}))?.trim()??''
    if (reason.length<2) return setNotice('必须填写核对原因，未取消礼遇出品。')
    if (!(await confirmAction({title:'确认取消零元礼遇订单',description:'系统会取消这张零元礼遇订单、释放库存和制作容量，并将顾客礼遇显示为已取消。只有确认尚未制作、尚未交付时才可继续。',confirmLabel:'确认取消',tone:'danger'}))) return
    setBusy(`fulfillment-cancel-${item.id}`);setNotice('')
    try {
      await api.postEndpoint(`/api/staff/complimentary-fulfillment-exceptions/${item.id}/resolve`,{
        action:'cancel_release',reason,
      },{ idempotencyKey:`complimentary-fulfillment-cancel-${crypto.randomUUID()}` })
      setNotice('礼遇异常已取消结案；系统订单、库存预留和制作容量已在同一事务释放。')
      await load()
    } catch (error) { setNotice(error instanceof Error?error.message:'礼遇异常未能取消结案') }
    finally { setBusy('') }
  }

  async function resolveComplimentaryCompensation(item:ComplimentaryFulfillmentException) {
    if (!canHandleException||busy||item.status!=='failed') return
    const compensationReference=(await promptAction({title:'填写线下补偿凭证',description:'填写已完成的线下补偿凭证、事件编号或交接单号，至少2个字。',label:'补偿凭证',confirmLabel:'继续',multiline:false}))?.trim()??''
    if (compensationReference.length<2) return setNotice('必须填写可追溯的补偿凭证，未结案。')
    const reason=(await promptAction({title:'填写线下补偿核对结果',description:`说明 ${item.tableCode} 的线下补偿内容和核对结果。`,label:'核对结果',confirmLabel:'继续'}))?.trim()??''
    if (reason.length<2) return setNotice('必须填写补偿说明，未结案。')
    if (!(await confirmAction({title:'确认线下补偿已完成',description:`凭证：${compensationReference}\n系统将取消原零元出品订单、释放预留，并把会员礼遇记为已补偿完成。`,confirmLabel:'确认已补偿'}))) return
    setBusy(`fulfillment-compensate-${item.id}`);setNotice('')
    try {
      await api.postEndpoint(`/api/staff/complimentary-fulfillment-exceptions/${item.id}/resolve`,{
        action:'external_compensation',reason,compensationReference,
      },{ idempotencyKey:`complimentary-fulfillment-compensate-${crypto.randomUUID()}` })
      setNotice('线下补偿已凭证化结案；原系统订单及预留已释放，顾客礼遇更新为已完成。')
      await load()
    } catch (error) { setNotice(error instanceof Error?error.message:'线下补偿未能结案') }
    finally { setBusy('') }
  }

  return <section className="staff-module-summary annual-benefit-panel"><div>
    <strong>年度会员礼遇</strong><small>生日、节日、优先排座和落座小食使用同一版规则；预览不占库存，员工队列覆盖必须留原因。</small>
    {notice && <p className="staff-module-notice" role="status">{notice}</p>}
    {canManage && <form className="staff-module-form" onSubmit={(event) => void saveDraft(event)}>
      <label>政策编号<input value={policyCode} onChange={(event) => setPolicyCode(event.target.value.toUpperCase())} placeholder="ANNUAL_2026" /></label>
      <label className="activity-wide">起草说明<input required minLength={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <fieldset className="activity-wide"><legend>添加年度礼遇规则</legend>
        <label>规则编号<input value={draftRule.ruleCode} onChange={(event) => updateRule({ ruleCode: event.target.value.toUpperCase() })} placeholder="GOLD_BIRTHDAY" /></label>
        <label>顾客名称<input value={draftRule.title} onChange={(event) => updateRule({ title: event.target.value })} placeholder="金卡生日礼遇" /></label>
        <label>规则类型<select value={draftRule.ruleKind} onChange={(event) => changeKind(event.target.value as RuleKind)}>{Object.entries(ruleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>适用等级<select value={draftRule.eligibleTier} onChange={(event) => updateRule({ eligibleTier: event.target.value as Tier })}>{Object.entries(tierLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>权益定义<select value={draftRule.benefitDefinitionId} onChange={(event) => updateRule({ benefitDefinitionId: event.target.value })}><option value="">请选择</option>{configuration?.definitions.filter((item) => item.status === 'active').map((item) => <option key={item.id} value={item.id}>{item.name}（{item.benefitKind}）</option>)}</select></label>
        <label>数量<input type="number" min="1" max="100" value={draftRule.quantity} onChange={(event) => updateRule({ quantity: Number(event.target.value) })} /></label>
        <label>有效天数<input type="number" min="1" max="366" value={draftRule.validityDays} onChange={(event) => updateRule({ validityDays: Number(event.target.value) })} /></label>
        <label>提前可用天数<input type="number" min="0" max="90" value={draftRule.windowBeforeDays} onChange={(event) => updateRule({ windowBeforeDays: Number(event.target.value) })} /></label>
        <label>延后可用天数<input type="number" min="0" max="90" value={draftRule.windowAfterDays} onChange={(event) => updateRule({ windowAfterDays: Number(event.target.value) })} /></label>
        <label>叠加组<input value={draftRule.stackGroup} onChange={(event) => updateRule({ stackGroup: event.target.value.toLowerCase() })} readOnly={draftRule.ruleKind === 'birthday' || draftRule.ruleKind === 'festival'} /></label>
        <label>优先级（小数优先）<input type="number" min="1" max="32767" value={draftRule.priority} onChange={(event) => updateRule({ priority: Number(event.target.value) })} /></label>
        <label>库存要求<select value={draftRule.inventoryRequirement} onChange={(event) => updateRule({ inventoryRequirement: event.target.value as InventoryRequirement })}><option value="strict_recipe">正式配方与可预留库存</option><option value="not_applicable">不涉及库存</option></select></label>
        <label>资格变化撤销策略<select value={draftRule.revocationPolicy} onChange={(event) => updateRule({ revocationPolicy: event.target.value as RevocationPolicy })}><option value="cancel_before_redeem">核销前撤销</option><option value="expire_only">仅按有效期失效</option><option value="manual_compensation">人工复核补偿</option></select></label>
        {draftRule.ruleKind === 'birthday' && <label>2月29日非闰年规则<select value={draftRule.feb29Policy ?? 'feb28'} onChange={(event) => updateRule({ feb29Policy: event.target.value as Feb29Policy })}><option value="feb28">按2月28日</option><option value="mar01">按3月1日</option><option value="leap_year_only">仅闰年发放</option></select></label>}
        {draftRule.ruleKind === 'priority_seating' && <label>优先安排保留分钟<input type="number" min="5" max="30" value={draftRule.reservationHoldMinutes ?? 15} onChange={(event) => updateRule({ reservationHoldMinutes: Number(event.target.value) })} /></label>}
        {draftRule.ruleKind === 'daily_snack' && <><label>点心暂留分钟<input type="number" min="5" max="30" value={draftRule.redemptionHoldMinutes ?? 15} onChange={(event) => updateRule({ redemptionHoldMinutes: Number(event.target.value) })} /></label><label>每桌每日上限<input type="number" min="1" max="100" value={draftRule.tableDailyLimit} onChange={(event) => updateRule({ tableDailyLimit: Number(event.target.value) })} /></label></>}
        {draftRule.ruleKind !== 'daily_snack' && <label>酒水合规<select value={draftRule.alcoholHandling} onChange={(event) => updateRule({ alcoholHandling: event.target.value as AlcoholHandling })}><option value="not_applicable">不适用</option><option value="non_alcoholic_only">仅无酒精</option><option value="staff_compliance_required">员工合规核验</option></select></label>}
        {draftRule.alcoholHandling === 'staff_compliance_required' && <label>无酒精替代品<select value={draftRule.substitutes[0]?.productId ?? ''} onChange={(event) => updateRule({ substitutes: event.target.value ? [{ productId: event.target.value, priority: 10, reason: '酒水合规无酒精替代' }] : [] })}><option value="">请选择正式配方商品</option>{configuration?.products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>}
        <label className="catalog-check"><input type="checkbox" checked={draftRule.inheritToHigherTiers} onChange={(event) => updateRule({ inheritToHigherTiers: event.target.checked })} />高等级继承</label>
        <button type="button" onClick={addRule}>加入礼遇规则</button>
      </fieldset>
      <div className="activity-wide tier-benefit-draft-list">{draftRules.length === 0 ? <small>尚未加入礼遇规则</small> : draftRules.map((rule) => <span key={rule.ruleCode}>{rule.ruleCode} · {ruleLabels[rule.ruleKind]} · {tierLabels[rule.eligibleTier]} <button type="button" onClick={() => setDraftRules((items) => items.filter((item) => item.ruleCode !== rule.ruleCode))}>移除</button></span>)}</div>
      <button type="submit" disabled={Boolean(busy)}>{busy === 'draft' ? '正在保存' : '保存年度礼遇草稿'}</button>
    </form>}
    {canConfirmOccurrence && <form className="staff-module-form" onSubmit={(event) => void confirmOccurrence(event)}><label>节日规则<select value={occurrence.ruleId} onChange={(event) => setOccurrence({ ...occurrence, ruleId: event.target.value })}><option value="">请选择</option>{festivalRules.map((rule) => <option key={rule.id} value={rule.id}>{rule.title}</option>)}</select></label><label>年份<input value={occurrence.cycleYear} inputMode="numeric" onChange={(event) => setOccurrence({ ...occurrence, cycleYear: event.target.value })} /></label><label>开始日期<input type="date" value={occurrence.startsOn} onChange={(event) => setOccurrence({ ...occurrence, startsOn: event.target.value })} /></label><label>结束日期<input type="date" value={occurrence.endsOn} onChange={(event) => setOccurrence({ ...occurrence, endsOn: event.target.value })} /></label><label className="activity-wide">日期确认依据<input value={occurrence.confirmationReference} minLength={2} maxLength={240} onChange={(event) => setOccurrence({ ...occurrence, confirmationReference: event.target.value })} placeholder="例如：运营排期单编号" /></label><button disabled={Boolean(busy)}>{busy === 'occurrence' ? '正在确认' : '确认节日日期'}</button></form>}
    {canConfigure && <div className="activity-admin-list"><header><strong>年度礼遇版本</strong><small>只有第三方发布的未来版本才会在顾客端生效</small></header>{(configuration?.policies.length ?? 0) === 0 ? <p>尚未建立年度礼遇政策。</p> : configuration!.policies.map((policy) => <article key={policy.id}><div><strong>{policy.policyCode} · 第{policy.version}版 · {statusLabels[policy.status]}</strong><small>{(configuration?.rules ?? []).filter((rule) => rule.policyVersionId === policy.id).map((rule) => `${ruleLabels[rule.ruleKind]}：${rule.title}`).join(' · ') || '未配置规则'}</small><small>{policy.effectiveFrom ? `生效 ${new Date(policy.effectiveFrom).toLocaleString('zh-CN')}` : '尚未生效'} · {policy.reason}</small></div><div className="staff-inline-actions">{policy.status === 'draft' && canApprove && policy.draftedByEmployeeId !== auth.employee.id && <button type="button" disabled={Boolean(busy)} onClick={() => void approve(policy)}>独立审批</button>}{policy.status === 'approved' && canPublish && policy.draftedByEmployeeId !== auth.employee.id && policy.approvedByEmployeeId !== auth.employee.id && <button type="button" disabled={Boolean(busy)} onClick={() => void publish(policy)}>排期发布</button>}</div></article>)}</div>}
    {canFulfill && <div className="activity-admin-list"><header><strong>当前桌台会员礼遇待办</strong><small>生日/节日礼遇按员工负责桌台过滤；替代商品必须显式选择并记录原因。</small></header>{annualGiftReservations.length === 0 ? <p>当前负责桌台没有待核销的生日或节日礼遇。</p> : annualGiftReservations.map((item) => { const selection=giftSelections[item.reservationId] ?? { productId:item.originalProductId,reason:'' }; const selected=item.allowedProducts.find((product)=>product.productId===selection.productId); return <article key={item.reservationId}><div><strong>{item.tableCode} · {item.title} · {item.quantity}份</strong><small>{item.memberNo || '会员号待确认'} · {item.customerName || '顾客姓名未设置'} · 暂留至 {new Date(item.expiresAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</small><label>本次出品<select value={selection.productId} onChange={(event)=>setGiftSelections((current)=>({...current,[item.reservationId]:{productId:event.target.value,reason:current[item.reservationId]?.reason ?? ''}}))}>{item.allowedProducts.map((product)=><option key={product.productId} value={product.productId}>{product.name}{product.isOriginal?'（原礼遇）':'（合规替代）'}</option>)}</select></label>{selected && !selected.isOriginal && <label>替换原因<input minLength={2} maxLength={240} value={selection.reason} onChange={(event)=>setGiftSelections((current)=>({...current,[item.reservationId]:{...selection,reason:event.target.value}}))} placeholder={selected.configuredReason || '请说明顾客选择或合规原因'} /></label>}</div><div className="staff-inline-actions"><button type="button" disabled={Boolean(busy)} onClick={()=>void redeemAnnualGift(item)}>{busy===`annual-gift-${item.reservationId}`?'正在核销':'二次确认并进入出品'}</button><button type="button" disabled={Boolean(busy)} onClick={()=>void cancelAnnualGift(item)}>{busy===`annual-gift-cancel-${item.reservationId}`?'正在取消':'取消暂留'}</button></div></article> })}</div>}
    {canFulfill && <div className="activity-admin-list"><header><strong>今日待核销点心</strong><small>仅显示当日到店申请；核销前请核对桌台和顾客出示的核销码。</small></header>{dailySnackClaims.length === 0 ? <p>当前没有待核销或已处理的每日点心。</p> : dailySnackClaims.map((claim) => <article key={claim.id}><div><strong>{claim.tableCode || '当前桌台'} · {claim.title} · {claim.quantity}份</strong><small>核销码 {claim.claimCode} · {dailySnackStatus(claim)}</small>{claim.status === 'reserved' && <em>请先核对顾客出示的核销码</em>}</div><div className="staff-inline-actions">{claim.status === 'reserved' && <><button type="button" disabled={Boolean(busy)} onClick={() => void redeemDailySnack(claim)}>{busy === `daily-snack-${claim.id}` ? '正在核销' : '确认核销并通知出品'}</button><button type="button" disabled={Boolean(busy)} onClick={() => void cancelDailySnack(claim)}>{busy === `daily-snack-cancel-${claim.id}` ? '正在取消' : '取消暂留'}</button></>}</div></article>)}</div>}
    {canHandleException && <div className="activity-admin-list"><header><strong>礼遇出品异常</strong><small>自动重试停止后必须选择重新派发、取消释放或凭证化线下补偿；所有终态动作均复验桌台权限并写审计。</small></header>{fulfillmentExceptions.length===0?<p>当前没有需要人工处理的礼遇出品异常。</p>:fulfillmentExceptions.map((item)=><article key={item.id}><div><strong>{item.tableCode} · {item.title||'会员礼遇'} · {item.status==='failed'?'自动重试已停止':'正在自动重试'}</strong><small>{item.memberNo||'会员号待确认'} · {item.customerName||'顾客姓名未设置'} · 已尝试 {item.attemptCount} 次 · {item.lastErrorCode||'原因待确认'}</small></div><div className="staff-inline-actions"><button type="button" disabled={Boolean(busy)} onClick={()=>void retryComplimentaryFulfillment(item)}>{busy===`fulfillment-retry-${item.id}`?'正在重新派发':'复核并重新派发'}</button>{item.status==='failed'&&<><button type="button" disabled={Boolean(busy)} onClick={()=>void resolveComplimentaryCancellation(item)}>{busy===`fulfillment-cancel-${item.id}`?'正在取消释放':'取消出品并释放'}</button><button type="button" disabled={Boolean(busy)} onClick={()=>void resolveComplimentaryCompensation(item)}>{busy===`fulfillment-compensate-${item.id}`?'正在补偿结案':'线下补偿结案'}</button></>}</div></article>)}</div>}
    {canConfigure && configuration !== null && configuration.occurrences.length > 0 && <div className="activity-admin-list"><header><strong>已确认节日日期</strong><small>顾客日历只使用这里已确认的日期</small></header>{configuration.occurrences.map((item) => <article key={item.id}><div><strong>{item.startsOn} 至 {item.endsOn}</strong><small>{configuration.rules.find((rule) => rule.id === item.ruleId)?.title ?? '已归档规则'} · {item.confirmationReference}</small></div></article>)}</div>}
  </div></section>
}

function blankRule(): RuleDraft { return { ruleCode: '', title: '', ruleKind: 'birthday', eligibleTier: 'gold', inheritToHigherTiers: false, benefitDefinitionId: '', quantity: 1, validityDays: 1, windowBeforeDays: 0, windowAfterDays: 0, onSiteOnly: true, requiresTableSession: true, memberDailyLimit: 1, tableDailyLimit: 1, alcoholHandling: 'non_alcoholic_only', stackGroup: 'festival_gift', priority: 10, inventoryRequirement: 'strict_recipe', revocationPolicy: 'cancel_before_redeem', feb29Policy: 'feb28', substitutes: [], reservationHoldMinutes: null, redemptionHoldMinutes: null, enabled: true } }
function ruleForKind(rule: RuleDraft): RuleDraft { if (rule.ruleKind === 'priority_seating') return { ...rule, stackGroup: rule.ruleCode ? rule.ruleCode.toLowerCase() : 'priority_seating', priority: 100, inventoryRequirement: 'not_applicable', feb29Policy: null, substitutes: [], onSiteOnly: false, requiresTableSession: false, reservationHoldMinutes: rule.reservationHoldMinutes ?? 15, redemptionHoldMinutes: null }; if (rule.ruleKind === 'daily_snack') return { ...rule, stackGroup: rule.ruleCode ? rule.ruleCode.toLowerCase() : 'daily_snack', priority: 100, inventoryRequirement: 'strict_recipe', feb29Policy: null, substitutes: [], onSiteOnly: true, requiresTableSession: true, validityDays: 1, windowBeforeDays: 0, windowAfterDays: 0, alcoholHandling: 'not_applicable', reservationHoldMinutes: null, redemptionHoldMinutes: rule.redemptionHoldMinutes ?? 15 }; if (rule.ruleKind === 'festival') return { ...rule, stackGroup: 'festival_gift', priority: 20, inventoryRequirement: 'strict_recipe', feb29Policy: null, onSiteOnly: true, requiresTableSession: true, reservationHoldMinutes: null, redemptionHoldMinutes: null }; return { ...rule, stackGroup: 'festival_gift', priority: 10, inventoryRequirement: 'strict_recipe', feb29Policy: rule.feb29Policy ?? 'feb28', onSiteOnly: true, requiresTableSession: true, reservationHoldMinutes: null, redemptionHoldMinutes: null } }
function validateRule(rule: RuleDraft) { if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(rule.ruleCode) || rule.title.trim().length < 2 || !rule.benefitDefinitionId || !/^[a-z][a-z0-9_.-]{1,63}$/.test(rule.stackGroup) || !Number.isSafeInteger(rule.priority)) throw new Error('请填写规则编号、顾客名称、权益定义、叠加组和优先级。'); if (rule.ruleKind === 'birthday' && !rule.feb29Policy) throw new Error('生日礼遇必须明确2月29日的非闰年处理规则。'); if (rule.alcoholHandling === 'staff_compliance_required' && rule.substitutes.length === 0) throw new Error('酒水合规礼遇必须选择无酒精替代品。'); if (rule.ruleKind === 'priority_seating' && (rule.reservationHoldMinutes === null || rule.reservationHoldMinutes < 5 || rule.reservationHoldMinutes > 30 || rule.onSiteOnly || rule.requiresTableSession)) throw new Error('优先排座只能配置5至30分钟的订座保留，不能要求顾客已入座。'); if (rule.ruleKind === 'daily_snack' && (rule.redemptionHoldMinutes === null || rule.redemptionHoldMinutes < 5 || rule.redemptionHoldMinutes > 30 || !rule.onSiteOnly || !rule.requiresTableSession || rule.alcoholHandling !== 'not_applicable')) throw new Error('每日点心必须为到店、关联桌台、无酒精处理的5至30分钟短暂留权益。') }
function dailySnackStatus(claim: DailySnackClaim): string { if (claim.status === 'redeemed') return `已核销待出品${claim.redeemedByEmployeeName ? ` · ${claim.redeemedByEmployeeName}` : ''}${claim.redeemedAt ? ` · ${new Date(claim.redeemedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}` : ''}`; if (claim.status === 'fulfilled') return `已完成${claim.fulfilledAt ? ` · ${new Date(claim.fulfilledAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}` : ''}`; if (claim.status === 'compensated') return `线下补偿已完成${claim.fulfilledAt ? ` · ${new Date(claim.fulfilledAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}` : ''}`; if (claim.status === 'cancelled_after_redemption') return '出品失败，已取消并释放'; if (claim.status === 'cancelled') return '已取消并释放'; if (claim.status === 'expired') return '暂留超时，已自动释放'; return `暂留至 ${claim.expiresAt ? new Date(claim.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—'}` }
