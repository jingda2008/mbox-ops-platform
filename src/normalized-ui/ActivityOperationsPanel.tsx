import { useEffect, useState, type FormEvent } from 'react'
import { CheckCircle2, ChevronDown, RefreshCw, UserCheck, XCircle } from 'lucide-react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import { MediaAssetPicker } from './MediaAssetPicker'
import './activity-operations-panel.css'

type ActivityStatus = 'draft' | 'published' | 'full' | 'cancelled' | 'completed'
type ActivityPaymentMode = 'none' | 'deposit_optional' | 'deposit_required' | 'full_required'
type RegistrationStatus = 'reserved' | 'payment_pending' | 'confirmed' | 'waitlisted' | 'cancelled' | 'checked_in' | 'no_show' | 'refunded'

interface ActivitySummary {
  publicId: string; title: string; status: ActivityStatus; startsAt: string; endsAt: string
  assemblyLocation: string; capacity: number; occupiedSeats: number; waitlistedSeats: number
  registrationCount: number; paymentMode: ActivityPaymentMode; feeAmountMinor: number; currency: string
}

interface ActivityDetail extends ActivitySummary {
  kind: string; summary: string; coverUrl: string | null; depositAmountMinor: number
  feeBasis: 'per_person' | 'per_registration'; paymentDeadlineMinutes: number; paymentRuleText: string
  pointsReward: number; visibility: 'public' | 'member' | 'segment'
  audienceMemberLevels: string[]; audienceLifecycleStages: string[]
  safetyPolicyVersion: string | null; safetyAcknowledgementText: string | null; safetyRequirements: string[]
  refundPolicyVersion: string | null; refundPolicySummary: string | null; activityDetails: string | null
  includedItems: string[]; participationRequirements: string[]; contactInstructions: string | null
  memberBenefitText: string | null; updatedAt: string
}

interface Registration {
  publicId: string; customerLabel: string; memberLevel: string | null; partySize: number
  contactVersionPublicId: string; maskedContact: string
  status: RegistrationStatus; paymentStatus: string; paymentChoice: string
  requestedPaymentChoice: string; requestedPaymentMethod: string | null; requestedAmountDueMinor: number
  totalFeeAmountMinor: number; amountDueMinor: number; paidAmountMinor: number; currency: string
  registeredAt: string; paymentDueAt: string | null; checkedInAt: string | null
  paymentId: string | null; authoritativePaymentStatus: string | null; providerActionState: string | null
  refund: null | { id: string; publicId: string; status: string; amountMinor: number; approvedByEmployeeId: string | null }
}

interface OperationsDetail { activity: ActivityDetail; registrations: Registration[] }

interface DraftForm {
  kind: string; title: string; summary: string; coverUrl: string; startsAt: string; endsAt: string
  assemblyLocation: string; capacity: string; feeYuan: string; depositYuan: string
  feeBasis: string; paymentMode: ActivityPaymentMode; paymentDeadlineMinutes: string; paymentRuleText: string
  visibility: string; audienceMemberLevels: string[]; audienceLifecycleStages: string[]
  safetyPolicyVersion: string; safetyAcknowledgementText: string; safetyRequirements: string
  refundPolicyVersion: string; refundPolicySummary: string; activityDetails: string
  includedItems: string; participationRequirements: string; contactInstructions: string
  memberBenefitText: string; reason: string
}

const memberLevels = [['member','普通会员'],['silver','银卡'],['gold','金卡']] as const
const lifecycleStages = [['new','新会员'],['active','活跃'],['high_value','高价值'],['at_risk','有流失风险'],['dormant','沉睡']] as const

export function ActivityOperationsPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const canView = auth.permissions.includes('community.activity.view')
  const canManage = auth.permissions.includes('community.activity.manage')
  const canPublish = auth.permissions.includes('community.activity.publish')
  const canRequestRefund = canManage && auth.permissions.includes('refund.request')
  const canApproveRefund = auth.permissions.includes('refund.approve')
  const canExecuteRefund = auth.permissions.includes('refund.execute')
  const canRevealContact = auth.permissions.includes('community.activity.contact.reveal')
  const [expanded, setExpanded] = useState(false)
  const [activities, setActivities] = useState<ActivitySummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<OperationsDetail | null>(null)
  const [draft, setDraft] = useState<DraftForm | null>(null)
  const [reason, setReason] = useState('')
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [revealedContacts,setRevealedContacts]=useState<Record<string,{value:string;expiresAt:string}>>({})
  const [contactClock,setContactClock]=useState(()=>Date.now())

  useEffect(()=>{
    if (Object.keys(revealedContacts).length===0) return
    const timer=window.setInterval(()=>{
      const current=Date.now()
      setContactClock(current)
      setRevealedContacts((contacts)=>Object.fromEntries(Object.entries(contacts).filter(([,item])=>(
        new Date(item.expiresAt).getTime()>current
      ))))
    },1_000)
    return()=>window.clearInterval(timer)
  },[revealedContacts])

  useEffect(() => {
    if (!expanded) return
    let current = true
    setPhase('loading')
    setNotice('')
    void api.getEndpoint<{ data: unknown }>('/api/staff/activity-operations').then((response) => {
      if (!current) return
      setActivities(activityList(response.data))
      setPhase('ready')
    }).catch((error) => {
      if (!current) return
      setNotice(message(error, '活动运营数据读取失败'))
      setPhase('error')
    })
    return () => { current = false }
  }, [api, expanded])
  if (!canView) return null

  async function loadActivities() {
    setPhase('loading'); setNotice('')
    try {
      const response = await api.getEndpoint<{ data: unknown }>('/api/staff/activity-operations')
      const loaded = activityList(response.data)
      setActivities(loaded)
      setPhase('ready')
      if (selected && loaded.some((activity) => activity.publicId === selected)) await loadDetail(selected)
    } catch (error) {
      setNotice(message(error, '活动运营数据读取失败')); setPhase('error')
    }
  }

  async function loadDetail(publicId: string) {
    setRevealedContacts({})
    setBusy('detail'); setNotice('')
    try {
      const response = await api.getEndpoint<{ data: unknown }>(`/api/staff/activity-operations/${encodeURIComponent(publicId)}`)
      const loaded = operationsDetail(response.data)
      setSelected(publicId); setDetail(loaded)
      setDraft(loaded.activity.status === 'draft' ? draftFromActivity(loaded.activity) : null)
    } catch (error) { setNotice(message(error, '活动详情读取失败')) }
    finally { setBusy('') }
  }

  async function saveDraft(event: FormEvent) {
    event.preventDefault()
    if (!draft || !detail || busy) return
    setBusy('draft'); setNotice('')
    try {
      const isNew = detail.activity.publicId === ''
      const response = isNew
        ? await api.postEndpoint<unknown>('/api/staff/activity-operations', draftPayload(draft), {
          idempotencyKey: operationKey('activity-draft-create'),
        })
        : await api.putEndpoint<unknown>(
          `/api/staff/activity-operations/${encodeURIComponent(detail.activity.publicId)}/draft`,
          draftPayload(draft),
          { idempotencyKey: operationKey('activity-draft-update') },
        )
      const saved = activityDetail(response)
      setSelected(saved.publicId)
      setDetail({ activity: saved, registrations: [] })
      setDraft(draftFromActivity(saved))
      setNotice(isNew
        ? '活动草稿已建立并读回。请由另一位有发布权限的人员复核后发布。'
        : '活动草稿已保存并读回。发布后这些客户承诺将锁定。')
      await loadActivities()
    } catch (error) { setNotice(message(error, '活动草稿没有保存')) }
    finally { setBusy('') }
  }

  async function registrationAction(registration: Registration, action: 'check-in' | 'no-show' | 'cancel') {
    const normalizedReason = reason.trim()
    if (normalizedReason.length < 2) return setNotice('请先填写本次操作原因（至少2个字）')
    setBusy(`${registration.publicId}:${action}`); setNotice('')
    try {
      await api.postEndpoint(
        `/api/staff/activity-operations/registrations/${encodeURIComponent(registration.publicId)}/${action}`,
        { reason: normalizedReason },
        { idempotencyKey: operationKey(`activity-${action}`) },
      )
      setReason(''); setNotice(action === 'check-in' ? '签到已确认。' : action === 'no-show' ? '已标记未到。' : '报名已取消；仅明确释放的名额会进入候补递补。')
      await refreshSelected()
    } catch (error) { setNotice(message(error, '报名操作没有完成')) }
    finally { setBusy('') }
  }

  async function refundAction(registration: Registration, action: 'request' | 'approve' | 'reject' | 'execute' | 'query') {
    const normalizedReason = reason.trim()
    if (action !== 'query' && action !== 'execute' && normalizedReason.length < 2) {
      return setNotice('请先填写退款原因或复核说明（至少2个字）')
    }
    const refund = registration.refund
    const endpoint = action === 'request'
      ? `/api/staff/activity-operations/registrations/${encodeURIComponent(registration.publicId)}/refund-request`
      : action === 'query'
        ? `/api/refunds/${refund?.id}/provider-query`
        : `/api/refunds/${refund?.id}/${action}`
    setBusy(`${registration.publicId}:refund-${action}`); setNotice('')
    try {
      await api.postEndpoint(endpoint, action === 'approve' || action === 'reject' || action === 'request'
        ? { reason: normalizedReason } : {}, { idempotencyKey: operationKey(`activity-refund-${action}`) })
      setReason('')
      setNotice(action === 'request' ? '退款已由店长发起，等待收银复核。'
        : action === 'approve' ? '退款已复核通过，仍需执行并等待渠道确认。'
          : action === 'reject' ? '退款申请已驳回。'
            : action === 'execute' ? '退款已提交渠道，尚未确认成功前不会标记已退款。'
              : '已向渠道查询退款状态。')
      await refreshSelected()
    } catch (error) { setNotice(message(error, '退款操作没有完成')) }
    finally { setBusy('') }
  }

  async function queryPayment(registration: Registration) {
    if (!registration.paymentId) return
    setBusy(`${registration.publicId}:payment-query`); setNotice('')
    try {
      await api.postEndpoint(`/api/payments/${registration.paymentId}/provider-query`, {}, {
        idempotencyKey: operationKey('activity-payment-query'),
      })
      setNotice('已向渠道查单，请按权威结果继续处理。'); await refreshSelected()
    } catch (error) { setNotice(message(error, '支付查单没有完成')) }
    finally { setBusy('') }
  }

  async function revealContact(registration:Registration){
    const purpose=registration.status==='waitlisted'?'waitlist_coordination'
      :registration.status==='payment_pending'?'payment_followup'
        :['confirmed','checked_in'].includes(registration.status)?'attendance_coordination':null
    if (!purpose || !canRevealContact || registration.maskedContact==='已清除') return
    setBusy(`${registration.publicId}:contact`);setNotice('')
    try{
      const raw=await api.postEndpoint<unknown>(
        `/api/staff/activity-contacts/${encodeURIComponent(registration.contactVersionPublicId)}/reveal`,
        {purpose},{idempotencyKey:operationKey(`activity-contact-${purpose}`)},
      )
      const value=object(raw,'联系方式查看结果')
      const contactValue=string(value.contactValue)
      const expiresAt=string(value.expiresAt)
      if(new Date(expiresAt).getTime()<=Date.now()) throw new Error('联系方式显示时限已过，请重新查看')
      setContactClock(Date.now())
      setRevealedContacts((contacts)=>({...contacts,[registration.publicId]:{value:contactValue,expiresAt}}))
      setNotice('联系方式仅在当前页面短暂显示，离开或到期后自动清除。')
    }catch(error){setNotice(message(error,'联系方式未能安全读取'))}
    finally{setBusy('')}
  }

  function startCreate() {
    const nextDraft = emptyDraft()
    setSelected(null)
    setDetail({ activity: draftShell(nextDraft), registrations: [] })
    setDraft(nextDraft)
    setNotice('正在建立新活动草稿。费用、权益、退款和安全承诺请一次填写完整。')
  }

  async function publishActivity(activity: ActivityDetail) {
    if (busy || activity.publicId === '' || !window.confirm(
      `确认发布“${activity.title}”？发布后时间、费用、权益、安全和退款承诺不可静默修改。`,
    )) return
    setBusy('publish'); setNotice('')
    try {
      await api.postEndpoint(`/api/staff/community-activities/${encodeURIComponent(activity.publicId)}/publish`, {}, {
        idempotencyKey: operationKey('activity-publish'),
      })
      setNotice('活动已由发布人员复核发布，顾客端将按当前承诺展示。')
      await loadDetail(activity.publicId)
      const response = await api.getEndpoint<{ data: unknown }>('/api/staff/activity-operations')
      setActivities(activityList(response.data))
    } catch (error) { setNotice(message(error, '活动没有发布')) }
    finally { setBusy('') }
  }

  async function refreshSelected() {
    if (selected) await loadDetail(selected)
    const response = await api.getEndpoint<{ data: unknown }>('/api/staff/activity-operations')
    setActivities(activityList(response.data))
  }

  const updateDraft = (key: keyof DraftForm, value: DraftForm[typeof key]) => setDraft((current) => (
    current === null ? null : { ...current, [key]: value }
  ))

  return <section className="activity-operations-panel" aria-label="活动报名运营工作台">
    <header>
      <div><strong>活动报名运营</strong><small>名单、候补、签到、取消与退款状态集中处理；不在此页面伪造支付结果。</small></div>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => {if(value)setRevealedContacts({});return !value})}>{expanded ? '收起' : '打开工作台'}<ChevronDown size={17} /></button>
    </header>
    {expanded && <>
      {notice && <p className="activity-operations-notice" role="status">{notice}</p>}
      <div className="activity-operations-toolbar"><span>{activities.length} 个活动</span><div>{canManage && <button type="button" onClick={startCreate}>新建活动草稿</button>}<button type="button" disabled={phase === 'loading'} onClick={() => void loadActivities()}><RefreshCw size={16} />刷新</button></div></div>
      {phase === 'error' && <button type="button" onClick={() => void loadActivities()}>重新读取</button>}
      <div className="activity-operations-list">{activities.map((activity) => <button type="button" className={selected === activity.publicId ? 'is-selected' : ''} key={activity.publicId} onClick={() => void loadDetail(activity.publicId)}>
        <strong>{activity.title}</strong><span>{statusLabel(activity.status)} · {dateText(activity.startsAt)}</span><small>{activity.occupiedSeats}/{activity.capacity} 人 · 候补 {activity.waitlistedSeats} 人</small>
      </button>)}</div>
      {detail && <div className="activity-operations-detail">
        <header><div><strong>{detail.activity.publicId === '' ? '新活动草稿' : detail.activity.title}</strong><small>{dateText(detail.activity.startsAt)} · {detail.activity.assemblyLocation}</small></div><div><em>{statusLabel(detail.activity.status)}</em>{detail.activity.status === 'draft' && detail.activity.publicId !== '' && canPublish && <button type="button" disabled={busy === 'publish'} onClick={() => void publishActivity(detail.activity)}>复核并发布</button>}</div></header>
        <div className="activity-operations-metrics"><span><strong>{detail.activity.occupiedSeats}</strong>已占名额</span><span><strong>{detail.activity.waitlistedSeats}</strong>候补人数</span><span><strong>{detail.activity.capacity}</strong>人数上限</span></div>
        {detail.activity.pointsReward > 0 && <p className="activity-operations-warning">历史活动配置了未版本化积分奖励，当前不会自动发放或对顾客展示；发布前必须改为0。</p>}
        {draft && canManage && <details className="activity-draft-editor" open={detail.activity.publicId === ''}><summary>{detail.activity.publicId === '' ? '填写活动草稿' : '编辑草稿'}（发布后不可静默修改）</summary><form onSubmit={(event) => void saveDraft(event)}>
          <fieldset><legend>活动与时间</legend>
            <label>活动名称<input required minLength={2} maxLength={120} value={draft.title} onChange={(event) => updateDraft('title', event.target.value)} /></label>
            <label>活动类型<select value={draft.kind} onChange={(event) => updateDraft('kind', event.target.value)}><option value="member_night">会员音乐夜</option><option value="city_walk">城市漫步</option><option value="hike">徒步</option><option value="camping">露营</option><option value="music_picnic">音乐野餐</option><option value="proposal">求婚活动</option><option value="other">其他</option></select></label>
            <label className="wide">列表摘要<textarea rows={2} value={draft.summary} onChange={(event) => updateDraft('summary', event.target.value)} /></label>
            <label className="wide">活动详情<textarea rows={5} value={draft.activityDetails} onChange={(event) => updateDraft('activityDetails', event.target.value)} /></label>
            <label>开始时间<input type="datetime-local" required value={draft.startsAt} onChange={(event) => updateDraft('startsAt', event.target.value)} /></label>
            <label>结束时间<input type="datetime-local" required value={draft.endsAt} onChange={(event) => updateDraft('endsAt', event.target.value)} /></label>
            <label>集合地点<input value={draft.assemblyLocation} onChange={(event) => updateDraft('assemblyLocation', event.target.value)} /></label>
            <label>人数上限<input type="number" min={1} max={1000} value={draft.capacity} onChange={(event) => updateDraft('capacity', event.target.value)} /></label>
            <label className="wide">封面图片地址（可选）<input type="url" value={draft.coverUrl} onChange={(event) => updateDraft('coverUrl', event.target.value)} placeholder="上传后会自动填入站内地址；也可填写已核对的 HTTPS 地址" /></label>
            <div className="wide"><MediaAssetPicker api={api} purpose="community_activity" value={draft.coverUrl} onChange={(coverUrl)=>updateDraft('coverUrl',coverUrl)} label="上传活动封面" /></div>
          </fieldset>
          <fieldset><legend>费用、权益和客群</legend>
            <label>计价方式<select value={draft.feeBasis} onChange={(event) => updateDraft('feeBasis', event.target.value)}><option value="per_registration">每次报名/每组</option><option value="per_person">每人</option></select></label>
            <label>预付方式<select value={draft.paymentMode} onChange={(event) => updateDraft('paymentMode', event.target.value as ActivityPaymentMode)}><option value="none">无需预付</option><option value="deposit_optional">订金可选</option><option value="deposit_required">必须付订金</option><option value="full_required">必须全额预付</option></select></label>
            <label>活动费用（元）<input inputMode="decimal" value={draft.feeYuan} onChange={(event) => updateDraft('feeYuan', event.target.value)} /></label>
            <label>订金（元）<input inputMode="decimal" value={draft.depositYuan} onChange={(event) => updateDraft('depositYuan', event.target.value)} /></label>
            <label>付款时限（分钟）<input type="number" min={5} max={1440} value={draft.paymentDeadlineMinutes} onChange={(event) => updateDraft('paymentDeadlineMinutes', event.target.value)} /></label>
            <label className="wide">付款说明<input value={draft.paymentRuleText} onChange={(event) => updateDraft('paymentRuleText', event.target.value)} /></label>
            <label>可见范围<select value={draft.visibility} onChange={(event) => updateDraft('visibility', event.target.value)}><option value="public">所有顾客</option><option value="member">所有会员</option><option value="segment">指定客群</option></select></label>
            <div className="activity-audience-options wide"><span>指定会员等级</span>{memberLevels.map(([code,label]) => <label key={code}><input type="checkbox" disabled={draft.visibility !== 'segment'} checked={draft.audienceMemberLevels.includes(code)} onChange={() => updateDraft('audienceMemberLevels', toggle(draft.audienceMemberLevels,code))} />{label}</label>)}</div>
            <div className="activity-audience-options wide"><span>指定会员阶段</span>{lifecycleStages.map(([code,label]) => <label key={code}><input type="checkbox" disabled={draft.visibility !== 'segment'} checked={draft.audienceLifecycleStages.includes(code)} onChange={() => updateDraft('audienceLifecycleStages', toggle(draft.audienceLifecycleStages,code))} />{label}</label>)}</div>
            <label className="wide">会员权益或赠送<textarea rows={3} value={draft.memberBenefitText} onChange={(event) => updateDraft('memberBenefitText', event.target.value)} placeholder="没有则留空；已配置内容会在顾客详情可见" /></label>
            <p className="wide activity-operations-warning">活动积分奖励暂不开放：旧字段没有规则版本、预算和发放状态机，本页固定为0，不会在签到时静默发分。</p>
          </fieldset>
          <fieldset><legend>退款、安全和参与承诺</legend>
            <label>退款规则版本<input value={draft.refundPolicyVersion} onChange={(event) => updateDraft('refundPolicyVersion', event.target.value)} /></label>
            <label>安全规则版本<input value={draft.safetyPolicyVersion} onChange={(event) => updateDraft('safetyPolicyVersion', event.target.value)} /></label>
            <label className="wide">退款说明<textarea rows={3} value={draft.refundPolicySummary} onChange={(event) => updateDraft('refundPolicySummary', event.target.value)} /></label>
            <label className="wide">安全确认文案<textarea rows={2} value={draft.safetyAcknowledgementText} onChange={(event) => updateDraft('safetyAcknowledgementText', event.target.value)} /></label>
            <label className="wide">安全要求（每行一项）<textarea rows={4} value={draft.safetyRequirements} onChange={(event) => updateDraft('safetyRequirements', event.target.value)} /></label>
            <label className="wide">费用包含（每行一项）<textarea rows={3} value={draft.includedItems} onChange={(event) => updateDraft('includedItems', event.target.value)} /></label>
            <label className="wide">参与条件（每行一项）<textarea rows={3} value={draft.participationRequirements} onChange={(event) => updateDraft('participationRequirements', event.target.value)} /></label>
            <label className="wide">联系与集合说明<textarea rows={3} value={draft.contactInstructions} onChange={(event) => updateDraft('contactInstructions', event.target.value)} /></label>
            <label className="wide">修改原因<input minLength={2} maxLength={500} required value={draft.reason} onChange={(event) => updateDraft('reason', event.target.value)} /></label>
          </fieldset>
          <button type="submit" disabled={busy === 'draft'}>{busy === 'draft' ? '保存中' : detail.activity.publicId === '' ? '建立草稿并读回' : '保存草稿并读回'}</button>
        </form></details>}
        {detail.activity.publicId !== '' && <section className="activity-registration-roster"><header><div><strong>报名与候补名单</strong><small>候补按报名时间排序；收费候补不预扣款。</small></div><span>{detail.registrations.length} 条</span></header>
          {canManage && <label className="activity-operation-reason">本次操作原因<input minLength={2} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：顾客来电取消 / 现场确认未到" /></label>}
          {detail.registrations.length === 0 && <p>当前还没有报名。</p>}
          <div className="activity-registration-list">{detail.registrations.map((registration) => <article key={registration.publicId} className={`status-${registration.status}`}>
            <header><div><strong>{registration.customerLabel}</strong><small>{registration.partySize} 人 · {dateText(registration.registeredAt)}</small></div><em>{registrationStatusLabel(registration.status)}</em></header>
            <p>{paymentText(registration)}</p>
            <div className="activity-contact-line"><span>联系：{revealedContacts[registration.publicId]?.value ?? registration.maskedContact}</span>
              {revealedContacts[registration.publicId] && <small>{Math.max(0,Math.ceil((new Date(revealedContacts[registration.publicId]!.expiresAt).getTime()-contactClock)/1_000))} 秒后隐藏</small>}
              {canRevealContact && revealPurpose(registration)!==null && registration.maskedContact!=='已清除' && !revealedContacts[registration.publicId] && <button type="button" disabled={busy===`${registration.publicId}:contact`} onClick={()=>void revealContact(registration)}>{revealActionLabel(registration)} · 60秒</button>}
            </div>
            {registration.refund && <p className="activity-refund-state">退款 {money(registration.refund.amountMinor)} · {refundStatusLabel(registration.refund.status)}</p>}
            <div className="activity-registration-actions">
              {canManage && registration.status === 'confirmed' && <><button type="button" onClick={() => void registrationAction(registration,'check-in')}><UserCheck size={16} />签到</button><button type="button" onClick={() => void registrationAction(registration,'no-show')}><XCircle size={16} />未到</button></>}
              {canManage && ['reserved','payment_pending','confirmed','waitlisted'].includes(registration.status) && registration.paymentStatus !== 'paid' && registration.paidAmountMinor === 0 && <button type="button" onClick={() => void registrationAction(registration,'cancel')}>取消报名</button>}
              {registration.status === 'payment_pending' && registration.providerActionState && registration.paymentId && <button type="button" onClick={() => void queryPayment(registration)}>先查支付</button>}
              {canRequestRefund && registration.paymentStatus === 'paid' && registration.refund === null && <button type="button" onClick={() => void refundAction(registration,'request')}>店长发起退款取消</button>}
              {canApproveRefund && registration.refund?.status === 'requested' && <><button type="button" onClick={() => void refundAction(registration,'approve')}><CheckCircle2 size={16} />收银复核通过</button><button type="button" onClick={() => void refundAction(registration,'reject')}>驳回</button></>}
              {canExecuteRefund && registration.refund?.status === 'approved' && <button type="button" onClick={() => void refundAction(registration,'execute')}>执行退款</button>}
              {canExecuteRefund && registration.refund?.status === 'processing' && <button type="button" onClick={() => void refundAction(registration,'query')}>查询渠道退款</button>}
            </div>
          </article>)}</div>
        </section>}
      </div>}
      {busy === 'detail' && <p>正在读取活动详情…</p>}
    </>}
  </section>
}

function draftFromActivity(activity: ActivityDetail): DraftForm {
  return {
    kind: activity.kind, title: activity.title, summary: activity.summary, coverUrl: activity.coverUrl ?? '',
    startsAt: localDateTime(activity.startsAt), endsAt: localDateTime(activity.endsAt), assemblyLocation: activity.assemblyLocation,
    capacity: String(activity.capacity), feeYuan: minorToYuan(activity.feeAmountMinor), depositYuan: minorToYuan(activity.depositAmountMinor),
    feeBasis: activity.feeBasis, paymentMode: activity.paymentMode, paymentDeadlineMinutes: String(activity.paymentDeadlineMinutes),
    paymentRuleText: activity.paymentRuleText, visibility: activity.visibility,
    audienceMemberLevels: activity.audienceMemberLevels, audienceLifecycleStages: activity.audienceLifecycleStages,
    safetyPolicyVersion: activity.safetyPolicyVersion ?? '', safetyAcknowledgementText: activity.safetyAcknowledgementText ?? '',
    safetyRequirements: activity.safetyRequirements.join('\n'), refundPolicyVersion: activity.refundPolicyVersion ?? '',
    refundPolicySummary: activity.refundPolicySummary ?? '', activityDetails: activity.activityDetails ?? '',
    includedItems: activity.includedItems.join('\n'), participationRequirements: activity.participationRequirements.join('\n'),
    contactInstructions: activity.contactInstructions ?? '', memberBenefitText: activity.memberBenefitText ?? '', reason: '',
  }
}

function emptyDraft(): DraftForm {
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1_000)
  startsAt.setMinutes(0, 0, 0)
  const endsAt = new Date(startsAt.getTime() + 3 * 60 * 60 * 1_000)
  return {
    kind: 'member_night', title: '', summary: '', coverUrl: '',
    startsAt: localDateTime(startsAt.toISOString()), endsAt: localDateTime(endsAt.toISOString()),
    assemblyLocation: 'M-BOX陆家嘴店', capacity: '20', feeYuan: '0.00', depositYuan: '0.00',
    feeBasis: 'per_registration', paymentMode: 'none', paymentDeadlineMinutes: '15',
    paymentRuleText: '本活动无需预付，到店后按活动说明结算', visibility: 'public',
    audienceMemberLevels: [], audienceLifecycleStages: [], safetyPolicyVersion: 'activity-safety-v1',
    safetyAcknowledgementText: '我已阅读并同意本活动的安全与参与要求', safetyRequirements: '',
    refundPolicyVersion: 'activity-refund-v1', refundPolicySummary: '免费活动可在开始前取消',
    activityDetails: '', includedItems: '', participationRequirements: '',
    contactInstructions: '', memberBenefitText: '', reason: '',
  }
}

function draftShell(draft: DraftForm): ActivityDetail {
  const startsAt = new Date(draft.startsAt).toISOString()
  const endsAt = new Date(draft.endsAt).toISOString()
  return {
    publicId: '', title: '', status: 'draft', startsAt, endsAt,
    assemblyLocation: draft.assemblyLocation, capacity: Number(draft.capacity), occupiedSeats: 0,
    waitlistedSeats: 0, registrationCount: 0, paymentMode: draft.paymentMode,
    feeAmountMinor: 0, currency: 'CNY', kind: draft.kind, summary: '', coverUrl: null,
    depositAmountMinor: 0, feeBasis: 'per_registration', paymentDeadlineMinutes: 15,
    paymentRuleText: draft.paymentRuleText, pointsReward: 0, visibility: 'public',
    audienceMemberLevels: [], audienceLifecycleStages: [],
    safetyPolicyVersion: draft.safetyPolicyVersion,
    safetyAcknowledgementText: draft.safetyAcknowledgementText, safetyRequirements: [],
    refundPolicyVersion: draft.refundPolicyVersion, refundPolicySummary: draft.refundPolicySummary,
    activityDetails: null, includedItems: [], participationRequirements: [],
    contactInstructions: null, memberBenefitText: null, updatedAt: new Date().toISOString(),
  }
}

function draftPayload(draft: DraftForm) {
  const visibility = draft.visibility
  return {
    kind: draft.kind, title: draft.title.trim(), summary: draft.summary.trim(), coverUrl: draft.coverUrl.trim() || null,
    startsAt: new Date(draft.startsAt).toISOString(), endsAt: new Date(draft.endsAt).toISOString(),
    assemblyLocation: draft.assemblyLocation.trim(), capacity: integer(draft.capacity,'人数上限'),
    feeAmountMinor: yuanToMinor(draft.feeYuan,'活动费用'), depositAmountMinor: yuanToMinor(draft.depositYuan,'订金'),
    feeBasis: draft.feeBasis, paymentMode: draft.paymentMode,
    paymentDeadlineMinutes: integer(draft.paymentDeadlineMinutes,'付款时限'), paymentRuleText: draft.paymentRuleText.trim(),
    pointsReward: 0, visibility,
    audienceMemberLevels: visibility === 'segment' ? draft.audienceMemberLevels : [],
    audienceLifecycleStages: visibility === 'segment' ? draft.audienceLifecycleStages : [],
    safetyPolicyVersion: draft.safetyPolicyVersion.trim(), safetyAcknowledgementText: draft.safetyAcknowledgementText.trim(),
    safetyRequirements: lines(draft.safetyRequirements), refundPolicyVersion: draft.refundPolicyVersion.trim(),
    refundPolicySummary: draft.refundPolicySummary.trim(), activityDetails: draft.activityDetails.trim(),
    includedItems: lines(draft.includedItems), participationRequirements: lines(draft.participationRequirements),
    contactInstructions: draft.contactInstructions.trim(), memberBenefitText: draft.memberBenefitText.trim() || null,
    reason: draft.reason.trim(),
  }
}

function activityList(value: unknown): ActivitySummary[] {
  if (!Array.isArray(value)) throw new Error('活动列表格式无法识别')
  return value.map(activitySummary)
}
function operationsDetail(value: unknown): OperationsDetail {
  const record = object(value,'活动运营详情')
  if (!Array.isArray(record.registrations)) throw new Error('报名列表格式无法识别')
  return { activity: activityDetail(record.activity), registrations: record.registrations.map(registration) }
}
function activitySummary(value: unknown): ActivitySummary {
  const record = object(value,'活动摘要')
  return {
    publicId: string(record.publicId), title: string(record.title), status: activityStatus(record.status),
    startsAt: string(record.startsAt), endsAt: string(record.endsAt), assemblyLocation: string(record.assemblyLocation),
    capacity: number(record.capacity), occupiedSeats: number(record.occupiedSeats), waitlistedSeats: number(record.waitlistedSeats),
    registrationCount: number(record.registrationCount), paymentMode: paymentMode(record.paymentMode),
    feeAmountMinor: number(record.feeAmountMinor), currency: string(record.currency),
  }
}
function activityDetail(value: unknown): ActivityDetail {
  const record = object(value,'活动详情')
  const summary = activitySummary(value)
  return {
    ...summary, kind: string(record.kind), summary: string(record.summary), coverUrl: nullableString(record.coverUrl),
    depositAmountMinor: number(record.depositAmountMinor), feeBasis: record.feeBasis === 'per_person' ? 'per_person' : 'per_registration',
    paymentDeadlineMinutes: number(record.paymentDeadlineMinutes), paymentRuleText: string(record.paymentRuleText),
    pointsReward: number(record.pointsReward), visibility: visibility(record.visibility),
    audienceMemberLevels: strings(record.audienceMemberLevels), audienceLifecycleStages: strings(record.audienceLifecycleStages),
    safetyPolicyVersion: nullableString(record.safetyPolicyVersion), safetyAcknowledgementText: nullableString(record.safetyAcknowledgementText),
    safetyRequirements: strings(record.safetyRequirements), refundPolicyVersion: nullableString(record.refundPolicyVersion),
    refundPolicySummary: nullableString(record.refundPolicySummary), activityDetails: nullableString(record.activityDetails),
    includedItems: strings(record.includedItems), participationRequirements: strings(record.participationRequirements),
    contactInstructions: nullableString(record.contactInstructions), memberBenefitText: nullableString(record.memberBenefitText),
    updatedAt: string(record.updatedAt),
  }
}
function registration(value: unknown): Registration {
  const record = object(value,'报名')
  const refund = record.refund === null ? null : object(record.refund,'退款')
  return {
    publicId: string(record.publicId), customerLabel: string(record.customerLabel), memberLevel: nullableString(record.memberLevel),
    contactVersionPublicId:string(record.contactVersionPublicId),maskedContact:string(record.maskedContact),
    partySize: number(record.partySize), status: registrationStatus(record.status), paymentStatus: string(record.paymentStatus),
    paymentChoice: string(record.paymentChoice), requestedPaymentChoice: string(record.requestedPaymentChoice),
    requestedPaymentMethod: nullableString(record.requestedPaymentMethod),
    requestedAmountDueMinor: number(record.requestedAmountDueMinor), totalFeeAmountMinor: number(record.totalFeeAmountMinor),
    amountDueMinor: number(record.amountDueMinor), paidAmountMinor: number(record.paidAmountMinor), currency: string(record.currency),
    registeredAt: string(record.registeredAt), paymentDueAt: nullableString(record.paymentDueAt), checkedInAt: nullableString(record.checkedInAt),
    paymentId: nullableString(record.paymentId), authoritativePaymentStatus: nullableString(record.authoritativePaymentStatus),
    providerActionState: nullableString(record.providerActionState), refund: refund === null ? null : {
      id: string(refund.id), publicId: string(refund.publicId), status: string(refund.status), amountMinor: number(refund.amountMinor),
      approvedByEmployeeId: nullableString(refund.approvedByEmployeeId),
    },
  }
}
function object(value: unknown,label: string): Record<string,unknown> { if(typeof value!=='object'||value===null||Array.isArray(value)) throw new Error(`${label}格式无法识别`); return value as Record<string,unknown> }
function string(value: unknown): string { if(typeof value!=='string') throw new Error('文本格式无法识别'); return value }
function nullableString(value: unknown): string | null { if(value===null) return null; return string(value) }
function number(value: unknown): number { if(!Number.isSafeInteger(value)||(value as number)<0) throw new Error('数字格式无法识别'); return value as number }
function strings(value: unknown): string[] { if(!Array.isArray(value)||value.some((item)=>typeof item!=='string')) throw new Error('列表格式无法识别'); return [...value] }
function activityStatus(value: unknown): ActivityStatus { if(!['draft','published','full','cancelled','completed'].includes(String(value))) throw new Error('活动状态无法识别'); return value as ActivityStatus }
function registrationStatus(value: unknown): RegistrationStatus { if(!['reserved','payment_pending','confirmed','waitlisted','cancelled','checked_in','no_show','refunded'].includes(String(value))) throw new Error('报名状态无法识别'); return value as RegistrationStatus }
function paymentMode(value: unknown): ActivityPaymentMode { if(!['none','deposit_optional','deposit_required','full_required'].includes(String(value))) throw new Error('付款方式无法识别'); return value as ActivityPaymentMode }
function visibility(value: unknown): ActivityDetail['visibility'] { if(!['public','member','segment'].includes(String(value))) throw new Error('可见范围无法识别'); return value as ActivityDetail['visibility'] }
function integer(value: string,label: string) { if(!/^\d+$/.test(value)) throw new Error(`${label}必须是整数`); return Number(value) }
function yuanToMinor(value: string,label: string) { if(!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) throw new Error(`${label}格式不正确`); const amount=Math.round(Number(value)*100); if(!Number.isSafeInteger(amount)) throw new Error(`${label}超出范围`); return amount }
function minorToYuan(value: number) { return (value/100).toFixed(2) }
function lines(value: string) { return value.split(/\r?\n/).map((item)=>item.trim()).filter(Boolean) }
function toggle(values: string[],value: string) { return values.includes(value) ? values.filter((item)=>item!==value) : [...values,value] }
function localDateTime(value: string) { const date=new Date(value); const local=new Date(date.getTime()-date.getTimezoneOffset()*60_000); return local.toISOString().slice(0,16) }
function operationKey(scope: string) { return `${scope}-${crypto.randomUUID()}` }
function message(error: unknown,fallback: string) { return error instanceof Error ? error.message : fallback }
function money(value: number) { return `¥${(value/100).toFixed(2)}` }
function dateText(value: string) { return new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) }
function statusLabel(value: ActivityStatus) { return ({draft:'草稿',published:'报名中',full:'已满',cancelled:'已取消',completed:'已结束'} as const)[value] }
function registrationStatusLabel(value: RegistrationStatus) { return ({reserved:'已预留',payment_pending:'待付款',confirmed:'已确认',waitlisted:'候补',cancelled:'已取消',checked_in:'已签到',no_show:'未到',refunded:'已退款'} as const)[value] }
function refundStatusLabel(value: string) { return ({requested:'待收银复核',approved:'待执行',rejected:'已驳回',processing:'渠道处理中',succeeded:'退款成功',failed:'退款失败'} as Record<string,string>)[value] ?? '状态待确认' }
function paymentText(value: Registration) { if(value.paymentStatus==='paid') return `已付 ${money(value.paidAmountMinor)} · 取消须走退款链`; if(value.paymentStatus==='pending') return `待付 ${money(value.amountDueMinor)} · ${value.providerActionState ? '渠道已受理或待查' : '尚未创建渠道动作'}`; if(value.status==='waitlisted') return value.requestedPaymentChoice==='none' ? '候补中 · 递补后无需预付' : `候补中 · 现在不预扣，递补后待付 ${money(value.requestedAmountDueMinor)}`; return value.totalFeeAmountMinor>0 ? `活动费用 ${money(value.totalFeeAmountMinor)} · 当前零付款` : '无需预付' }
function revealPurpose(value:Registration){return value.status==='waitlisted'?'waitlist_coordination':value.status==='payment_pending'?'payment_followup':['confirmed','checked_in'].includes(value.status)?'attendance_coordination':null}
function revealActionLabel(value:Registration){return value.status==='waitlisted'?'候补联系':value.status==='payment_pending'?'付款跟进':'签到联系'}
