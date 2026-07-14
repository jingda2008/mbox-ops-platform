import { BadgeCheck, CalendarClock, ExternalLink, Gift, Megaphone, MessageSquareText, ShieldCheck, UserRoundCheck, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { cancelMemberBenefitRedemption, confirmMemberBenefitRedemption, decideMemberBenefit, grantMemberBenefit, launchMemberCampaign, lockMemberBenefit, previewMemberCampaign, retryCustomerNotification } from '../api'
import type { BenefitCampaignPreview } from '../api'
import type { BenefitChannel } from '../shared/benefit-contracts'
import type { BootstrapResponse } from '../shared/contracts'
import { BenefitConfiguration } from './BenefitConfiguration'

interface BenefitCenterViewProps {
  data: BootstrapResponse
  onRefresh: () => Promise<void>
  onNotice: (message: string) => void
}

const segmentLabels = {
  dormant_30: '30天未到店老客',
  dormant_60: '60天未到店老客',
  vip: '金卡及白金会员',
  all_opted_in: '全部已同意触达会员',
}

const channelLabels = {
  none: '仅到账，不发消息',
  service_account: '微信服务号',
  wecom: '企业微信',
}

export function BenefitCenterView({ data, onRefresh, onNotice }: BenefitCenterViewProps) {
  const manager = data.employees.find((employee) => employee.roleId === 'manager' && employee.status === 'active')
  const [actorId, setActorId] = useState(data.employees.find((employee) => employee.roleId === 'server')?.id ?? data.employees[0]?.id ?? '')
  const [memberId, setMemberId] = useState(data.members[0]?.id ?? '')
  const [templateId, setTemplateId] = useState(data.benefitTemplates.find((item) => item.enabled)?.id ?? '')
  const [quantity, setQuantity] = useState(1)
  const [reason, setReason] = useState('现场服务关怀')
  const [channel, setChannel] = useState<BenefitChannel>('service_account')
  const [campaignName, setCampaignName] = useState('老朋友回店礼')
  const [campaignSegment, setCampaignSegment] = useState<keyof typeof segmentLabels>('dormant_30')
  const [campaignTemplateId, setCampaignTemplateId] = useState(data.benefitTemplates.find((item) => item.id === 'benefit-return-50')?.id ?? templateId)
  const [campaignChannel, setCampaignChannel] = useState<'service_account' | 'wecom'>('service_account')
  const [campaignPreview, setCampaignPreview] = useState<BenefitCampaignPreview | null>(null)
  const occupiedTables = data.tables.filter((table) => table.status === 'occupied')
  const [redemptionTableId, setRedemptionTableId] = useState(occupiedTables[0]?.id ?? '')
  const [authorizationActorId, setAuthorizationActorId] = useState(manager?.id ?? actorId)
  const [busy, setBusy] = useState(false)

  const pendingRequests = data.benefitGrantRequests.filter((request) => request.status === 'pending')
  const selectedMemberBenefits = data.memberBenefits.filter(
    (benefit) => benefit.memberId === memberId && ['available', 'locked'].includes(benefit.status),
  )
  const queuedNotifications = data.customerNotifications.filter((item) => item.status === 'queued').length
  const totalAvailable = data.memberBenefits.filter((benefit) => benefit.status === 'available').reduce((sum, benefit) => sum + benefit.remainingQuantity, 0)

  const policiesByRole = useMemo(
    () => new Map(data.benefitGrantPolicies.map((policy) => [policy.roleId, policy])),
    [data.benefitGrantPolicies],
  )

  useEffect(() => setCampaignPreview(null), [campaignSegment, campaignTemplateId, campaignChannel])

  async function submitGrant(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const request = await grantMemberBenefit({
        actorId,
        memberId,
        templateId,
        quantity,
        reason,
        channel,
        idempotencyKey: `benefit-grant-${crypto.randomUUID()}`,
      })
      onNotice(request.status === 'granted' ? '权益已发放到会员账户' : '超出当前人员权限，已提交审批')
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '权益发放失败')
    } finally {
      setBusy(false)
    }
  }

  async function decide(requestId: string, decision: 'granted' | 'rejected') {
    if (!manager) return
    setBusy(true)
    try {
      await decideMemberBenefit(requestId, {
        actorId: manager.id,
        decision,
        note: decision === 'granted' ? '值班经理确认符合会员关怀规则' : '不符合本次权益发放规则',
      })
      onNotice(decision === 'granted' ? '审批通过，权益已到账' : '权益申请已拒绝')
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '权益审批失败')
    } finally {
      setBusy(false)
    }
  }

  async function launchCampaign(event: React.FormEvent) {
    event.preventDefault()
    if (!manager || !campaignPreview?.withinDailyBudget) return
    setBusy(true)
    try {
      const campaign = await launchMemberCampaign({
        actorId: manager.id,
        name: campaignName,
        segment: campaignSegment,
        templateId: campaignTemplateId,
        channel: campaignChannel,
        reason: `${campaignName}召回活动`,
        idempotencyKey: `benefit-campaign-${crypto.randomUUID()}`,
      })
      onNotice(`活动完成：${campaign.issuedCount}位会员权益到账，${campaign.skippedCount}位因持有上限跳过`)
      await onRefresh()
      setCampaignPreview(null)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '活动发放失败')
    } finally {
      setBusy(false)
    }
  }

  async function previewCampaign() {
    if (!manager) return
    setBusy(true)
    try {
      const preview = await previewMemberCampaign({
        actorId: manager.id,
        name: campaignName,
        segment: campaignSegment,
        templateId: campaignTemplateId,
        channel: campaignChannel,
        reason: `${campaignName}召回活动`,
        idempotencyKey: `benefit-preview-${crypto.randomUUID()}`,
      })
      setCampaignPreview(preview)
      onNotice('活动范围和成本预估已更新，请确认后发放')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '活动预估失败')
    } finally {
      setBusy(false)
    }
  }

  async function retryNotification(notificationId: string) {
    setBusy(true)
    try {
      await retryCustomerNotification(notificationId)
      onNotice('失败通知已重新进入发送队列')
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '通知重试失败')
    } finally {
      setBusy(false)
    }
  }

  async function lockBenefit(benefitId: string) {
    setBusy(true)
    try {
      await lockMemberBenefit({
        actorId,
        benefitId,
        tableId: redemptionTableId,
        quantity: 1,
        idempotencyKey: `benefit-lock-${crypto.randomUUID()}`,
      })
      onNotice('权益已锁定到桌台，请核对后确认出品')
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '权益锁定失败')
    } finally {
      setBusy(false)
    }
  }

  async function confirmRedemption(redemptionId: string) {
    setBusy(true)
    try {
      await confirmMemberBenefitRedemption(redemptionId, {
        actorId,
        authorizedBy: authorizationActorId,
        idempotencyKey: `benefit-confirm-${crypto.randomUUID()}`,
      })
      onNotice('权益已核销，赠品订单已进入出品队列')
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '权益核销失败')
    } finally {
      setBusy(false)
    }
  }

  async function cancelRedemption(redemptionId: string) {
    setBusy(true)
    try {
      await cancelMemberBenefitRedemption(redemptionId, {
        actorId,
        reason: '现场核对后取消本次核销',
        idempotencyKey: `benefit-cancel-${crypto.randomUUID()}`,
      })
      onNotice('权益锁定已释放，会员可继续使用')
      await onRefresh()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '取消核销失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="benefit-view">
      <div className="section-heading">
        <div><span className="eyebrow">会员资产与触达</span><h2>权益发放中心</h2></div>
        <div className="heading-actions"><span className="count-chip">{data.members.length}会员</span><a className="secondary-button" href="/member?member=member-amy" target="_blank" rel="noreferrer"><ExternalLink size={16} />会员端</a></div>
      </div>

      <div className="benefit-metrics">
        <BenefitMetric icon={UserRoundCheck} label="会员样本" value={data.members.length} />
        <BenefitMetric icon={Gift} label="可用权益" value={totalAvailable} />
        <BenefitMetric icon={ShieldCheck} label="待审批" value={pendingRequests.length} warning={pendingRequests.length > 0} />
        <BenefitMetric icon={MessageSquareText} label="待通道发送" value={queuedNotifications} />
      </div>

      <div className="benefit-action-grid">
        <form className="benefit-form" onSubmit={(event) => void submitGrant(event)}>
          <div className="form-heading"><Gift size={19} /><div><strong>单客权益发放</strong><span>权限内直接到账，超权限自动审批</span></div></div>
          <div className="form-grid">
            <label><span>发放人员</span><select value={actorId} onChange={(event) => setActorId(event.target.value)}>{data.employees.filter((item) => item.status === 'active').map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName} · {data.config.roles.find((role) => role.id === employee.roleId)?.name}</option>)}</select></label>
            <label><span>会员</span><select value={memberId} onChange={(event) => setMemberId(event.target.value)}>{data.members.map((member) => <option key={member.id} value={member.id}>{member.displayName} · {member.level.toUpperCase()}</option>)}</select></label>
            <label><span>权益</span><select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>{data.benefitTemplates.filter((item) => item.enabled).map((template) => <option key={template.id} value={template.id}>{template.name} · 成本{money(template.costAmount)}</option>)}</select></label>
            <label><span>数量</span><input type="number" min={1} max={10} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} /></label>
            <label><span>通知方式</span><select value={channel} onChange={(event) => setChannel(event.target.value as BenefitChannel)}>{Object.entries(channelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="wide-field"><span>发放原因</span><input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          </div>
          <div className="policy-hint"><BadgeCheck size={16} /><span>{policySummary(data, actorId, policiesByRole)}</span></div>
          <button className="primary-button" type="submit" disabled={busy || !actorId || !memberId || !templateId}><Gift size={17} />确认发放</button>
        </form>

        <form className="benefit-form" onSubmit={(event) => void launchCampaign(event)}>
          <div className="form-heading"><Megaphone size={19} /><div><strong>老客召回活动</strong><span>按客群批量到账，并生成微信通知Outbox</span></div></div>
          <div className="form-grid">
            <label className="wide-field"><span>活动名称</span><input value={campaignName} onChange={(event) => setCampaignName(event.target.value)} /></label>
            <label><span>目标客群</span><select value={campaignSegment} onChange={(event) => setCampaignSegment(event.target.value as keyof typeof segmentLabels)}>{Object.entries(segmentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label><span>发放权益</span><select value={campaignTemplateId} onChange={(event) => setCampaignTemplateId(event.target.value)}>{data.benefitTemplates.filter((item) => item.enabled).map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
            <label><span>触达渠道</span><select value={campaignChannel} onChange={(event) => setCampaignChannel(event.target.value as 'service_account' | 'wecom')}><option value="service_account">微信服务号</option><option value="wecom">企业微信</option></select></label>
            <label><span>执行人</span><input value={manager?.displayName ?? '未配置活动管理员'} disabled /></label>
          </div>
          <div className={campaignPreview && !campaignPreview.withinDailyBudget ? 'policy-hint is-danger' : 'policy-hint'}><CalendarClock size={16} /><span>{campaignPreview
            ? `符合${campaignPreview.eligibleCount}人，可到账${campaignPreview.issuableCount}人，可微信触达${campaignPreview.reachableCount}人，预计成本${money(campaignPreview.estimatedCostAmount)}${campaignPreview.withinDailyBudget ? '' : '，已超每日额度'}`
            : '先预估人数、可触达范围和成本，再确认批量发放。'}</span></div>
          <div className="campaign-actions"><button className="secondary-button" type="button" disabled={busy || !manager} onClick={() => void previewCampaign()}><CalendarClock size={17} />预估范围</button><button className="primary-button" type="submit" disabled={busy || !manager || !campaignPreview?.withinDailyBudget}><Megaphone size={17} />确认发放</button></div>
        </form>
      </div>

      <div className="benefit-detail-grid">
        <div className="benefit-panel">
          <div className="panel-heading"><div><strong>会员账户</strong><span>权益直接到账，不依赖消息是否发送成功</span></div></div>
          <div className="member-list">
            {data.members.map((member) => {
              const benefits = data.memberBenefits.filter((item) => item.memberId === member.id && item.status === 'available')
              return (
                <button key={member.id} className={memberId === member.id ? 'member-row is-selected' : 'member-row'} onClick={() => setMemberId(member.id)}>
                  <span className="member-avatar">{member.displayName.slice(0, 1)}</span>
                  <span><strong>{member.displayName}</strong><small>{member.phoneMasked} · {member.tags.join(' / ')}</small></span>
                  <span className="member-channel"><i className={member.serviceAccountBound ? 'is-bound' : ''}>服务号</i><i className={member.wecomBound ? 'is-bound' : ''}>企微</i></span>
                  <b>{benefits.reduce((sum, benefit) => sum + benefit.remainingQuantity, 0)}项</b>
                </button>
              )
            })}
          </div>
          <div className="redemption-toolbar">
            <label><span>核销人员</span><select value={actorId} onChange={(event) => setActorId(event.target.value)}>{data.employees.filter((item) => item.status === 'active').map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label>
            <label><span>入账桌台</span><select value={redemptionTableId} onChange={(event) => setRedemptionTableId(event.target.value)}>{occupiedTables.map((table) => <option key={table.id} value={table.id}>{table.code} · {table.displayName}</option>)}</select></label>
            <label><span>赠送授权</span><select value={authorizationActorId} onChange={(event) => setAuthorizationActorId(event.target.value)}>{data.employees.filter((employee) => data.orderDomain.authorizationAuthorities.some((authority) => authority.actorId === employee.id && authority.kinds.includes('gift'))).map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label>
          </div>
          <div className="selected-benefits">
            {selectedMemberBenefits.length === 0 ? <span>当前会员暂无可用权益</span> : selectedMemberBenefits.map((benefit) => {
              const template = data.benefitTemplates.find((item) => item.id === benefit.templateId)
              const redemption = data.benefitRedemptions.find((item) => item.memberBenefitId === benefit.id && item.status === 'locked')
              return <div className="benefit-account-item" key={benefit.id}><Gift size={16} /><span><strong>{template?.name}</strong><small>剩余{benefit.remainingQuantity} · {benefit.validUntil.slice(0, 10)}到期</small></span><span className="redemption-actions">{redemption
                ? <><button className="primary-button" disabled={busy} onClick={() => void confirmRedemption(redemption.id)}><BadgeCheck size={14} />确认出品</button><button className="icon-button danger" title="取消核销并释放权益" disabled={busy} onClick={() => void cancelRedemption(redemption.id)}><XCircle size={15} /></button></>
                : template?.kind === 'product_gift'
                  ? <button className="secondary-button" disabled={busy || !redemptionTableId} onClick={() => void lockBenefit(benefit.id)}><ShieldCheck size={14} />锁定核销</button>
                  : <b>待接{template?.kind === 'amount_coupon' ? '支付账务' : '履约模块'}</b>}</span></div>
            })}
          </div>
        </div>

        <div className="benefit-panel">
          <div className="panel-heading"><div><strong>审批与通知</strong><span>经营授权和外部送达分别追踪</span></div></div>
          <div className="approval-list">
            {pendingRequests.length === 0 ? <div className="compact-empty">没有待审批申请</div> : pendingRequests.map((request) => {
              const member = data.members.find((item) => item.id === request.memberId)
              const template = data.benefitTemplates.find((item) => item.id === request.templateId)
              const employee = data.employees.find((item) => item.id === request.requestedBy)
              return <div className="approval-row" key={request.id}><div><strong>{member?.displayName} · {template?.name}</strong><span>{employee?.displayName}申请 · {request.reason}</span></div><div><button className="secondary-button" disabled={busy} onClick={() => void decide(request.id, 'rejected')}>拒绝</button><button className="primary-button" disabled={busy} onClick={() => void decide(request.id, 'granted')}>批准发放</button></div></div>
            })}
          </div>
          <div className="notification-list">
            {data.customerNotifications.slice(0, 8).map((notification) => {
              const member = data.members.find((item) => item.id === notification.memberId)
              return <div key={notification.id}><MessageSquareText size={16} /><span><strong>{member?.displayName} · {channelLabels[notification.channel]}</strong><small>{notificationDetail(notification)}</small></span>{notification.status === 'failed' ? <button className="notification-retry" disabled={busy} onClick={() => void retryNotification(notification.id)}>重试</button> : <b className={`notification-${notification.status}`}>{notificationStatus(notification.status)}</b>}</div>
            })}
            {data.customerNotifications.length === 0 && <div className="compact-empty">暂无通知记录</div>}
          </div>
        </div>
      </div>
      <BenefitConfiguration data={data} onRefresh={onRefresh} onNotice={onNotice} />
    </section>
  )
}

function BenefitMetric({ icon: Icon, label, value, warning = false }: { icon: typeof Gift; label: string; value: number; warning?: boolean }) {
  return <div className={warning ? 'benefit-metric is-warning' : 'benefit-metric'}><Icon size={18} /><span><strong>{value}</strong><small>{label}</small></span></div>
}

function money(amount: number) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(amount / 100)
}

function policySummary(data: BootstrapResponse, actorId: string, policies: Map<string, BootstrapResponse['benefitGrantPolicies'][number]>) {
  const actor = data.employees.find((item) => item.id === actorId)
  const policy = actor ? policies.get(actor.roleId) : null
  if (!policy) return '该人员没有直接发放权限，操作将进入审批。'
  const names = data.benefitTemplates.filter((item) => policy.templateIds.includes(item.id)).map((item) => item.name)
  return `可直接发放：${names.join('、') || '无'}；单次成本上限${money(policy.maxCostPerGrantAmount)}。`
}

function notificationStatus(status: BootstrapResponse['customerNotifications'][number]['status']) {
  return status === 'queued' ? '待发送' : status === 'sent' ? '已发送' : status === 'failed' ? '失败' : '已跳过'
}

function notificationDetail(notification: BootstrapResponse['customerNotifications'][number]) {
  if (notification.status === 'sent') return `服务商已受理${notification.providerMessageId ? ` · ${notification.providerMessageId}` : ''}`
  if (notification.status === 'queued') {
    const attempt = notification.attemptCount ?? 0
    return attempt > 0 ? `已尝试${attempt}次，等待下次执行` : '已入Outbox，待正式通道适配器发送'
  }
  return notification.failureReason ?? '未发送'
}
