import { useCallback, useEffect, useState } from 'react'
import { PauseCircle, PlayCircle, ShieldCheck } from 'lucide-react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import { useConfirmationDialog } from './ConfirmationDialog'
import './loyalty-emergency-control-panel.css'

type Capability = 'points_accrual'|'points_redemption'|'wechat_notification'
interface OperationalControl {
  capability:Capability
  state:'active'|'paused'
  version:number
  reason:string|null
  reviewAt:string|null
  changedAt:string|null
  pendingAccrualCount:number
}
const LABELS:Record<Capability,{ title:string;detail:string }> = {
  points_accrual:{ title:'新积分发放',detail:'暂停后照常付款、出单和退款；已付款订单进入待对账，恢复后自动安全补算。' },
  points_redemption:{ title:'积分兑换',detail:'只暂停新的兑换，不删除积分、兑换记录或已确认权益。' },
  wechat_notification:{ title:'微信会员通知',detail:'暂停后不发送，也不消耗一次性订阅授权；交易本身不受影响。' },
}

export function LoyaltyEmergencyControlPanel({ api,auth }:{ api:NormalizedApiClient;auth:StaffAuthView }) {
  const { confirmAction, promptAction } = useConfirmationDialog()
  const canView=auth.permissions.includes('loyalty.operations.view')
  const canControl=auth.permissions.includes('loyalty.operations.control')
  const [items,setItems]=useState<OperationalControl[]>([])
  const [busy,setBusy]=useState<Capability|null>(null)
  const [notice,setNotice]=useState('')
  const load=useCallback(async () => {
    if (!canView) return
    try {
      const response=await api.getEndpoint<{ data:OperationalControl[] }>('/api/staff/loyalty/operational-controls')
      setItems(response.data)
    } catch (error) { setNotice(error instanceof Error?error.message:'会员运行状态暂时无法读取') }
  },[api,canView])
  useEffect(() => { void load() },[load])
  if (!canView) return null

  async function change(item:OperationalControl) {
    if (!canControl||busy!==null) return
    const operation=item.state==='active'?'pause':'resume'
    const reason=(await promptAction({title:operation==='pause'?'填写暂停原因':'填写恢复原因',description:'该说明会写入运行审计。',label:'原因',confirmLabel:'继续'}))?.trim()
    if (!reason) return
    let reviewAt:string|null=null
    if (operation==='pause') {
      const value=(await promptAction({title:'填写复核时间（可选）',description:'例如 2026-08-17 10:00；不需要可留空。',label:'复核时间',confirmLabel:'继续',multiline:false}))?.trim() ?? ''
      if (value) {
        const parsed=Date.parse(value)
        if (!Number.isFinite(parsed)||parsed<=Date.now()) return setNotice('复核时间必须晚于当前时间。')
        reviewAt=new Date(parsed).toISOString()
      }
    }
    if (!(await confirmAction({
      title: `${operation==='pause'?'暂停':'恢复'}会员运行能力`,
      description: `${operation==='pause'?'暂停':'恢复'}“${LABELS[item.capability].title}”？\n${LABELS[item.capability].detail}`,
      confirmLabel: operation === 'pause' ? '确认暂停' : '确认恢复',
      tone: operation === 'pause' ? 'danger' : 'default',
    }))) return
    setBusy(item.capability);setNotice('')
    try {
      await api.putEndpoint(`/api/staff/loyalty/operational-controls/${item.capability}`,{
        operation,reason,reviewAt,expectedVersion:item.version,
      },{ idempotencyKey:`loyalty-operation-${crypto.randomUUID()}` })
      setNotice(operation==='pause'?'已暂停；付款、订单和退款仍正常运行。':'已恢复；待处理事项会由后台安全重算。')
      await load()
    } catch (error) { setNotice(error instanceof Error?error.message:'运行状态没有改变，请刷新后重试') }
    finally { setBusy(null) }
  }

  return <section className="loyalty-emergency-panel" aria-label="会员运行安全总闸">
    <header><span><ShieldCheck size={18}/></span><div><strong>会员运行安全总闸</strong><small>仅最高管理权限可操作；三个能力分别控制，暂停不会停止收款、出单或退款。</small></div></header>
    {notice&&<p role="status">{notice}</p>}
    <div className="loyalty-emergency-grid">{items.map((item) => <article key={item.capability} data-state={item.state}>
      <div><strong>{LABELS[item.capability].title}</strong><em>{item.state==='paused'?'已暂停':'正常运行'}</em></div>
      <small>{LABELS[item.capability].detail}</small>
      {item.reason&&<small>最近原因：{item.reason}</small>}
      {item.reviewAt&&<small>计划复核：{new Date(item.reviewAt).toLocaleString('zh-CN')}</small>}
      {item.capability==='points_accrual'&&item.pendingAccrualCount>0&&<b>{item.pendingAccrualCount} 笔已付款订单待补算</b>}
      {canControl&&<button type="button" disabled={busy!==null} onClick={() => void change(item)}>
        {item.state==='active'?<PauseCircle size={16}/>:<PlayCircle size={16}/>} {busy===item.capability?'正在确认':item.state==='active'?'暂停':'恢复'}
      </button>}
    </article>)}</div>
  </section>
}
