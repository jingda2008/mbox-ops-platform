import { useCallback,useEffect,useMemo,useRef,useState } from 'react'
import type { NormalizedApiClient,StaffAuthView } from '../normalized-api'
import { DurableStaffCommand } from './durable-staff-command'
type Row=Record<string,unknown>
type Data={positions:Row[];statements:Row[];ledger:Row[];payouts:Row[];accounts:Row[];balances:Row[];limit:number}
const yuan=(v:unknown)=>v==null?'待核算':`¥${(Number(v)/100).toFixed(2)}`
const state=(v:unknown)=>({pending:'待对方确认',confirmed:'已确认待审批',disputed:'有争议',approved:'已审批',cancelled:'已取消',unknown:'付款待核实',succeeded:'付款成功',failed:'付款失败'}[String(v)]??String(v))
export function ChannelFinancePanel({api,auth,partners}:{api:NormalizedApiClient;auth:StaffAuthView;partners:{id:string;name:string;promoterId:string;promoterName:string}[]}){
 const [data,setData]=useState<Data|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[pending,setPending]=useState(false),[action,setAction]=useState('reconcile'),[detail,setDetail]=useState<{statement:Row;lines:Row[]}|null>(null)
 const epoch=useRef(0),writing=useRef(false),detailRequest=useRef(0),dataRequest=useRef(0)
 const reload=useCallback(async()=>{const n=epoch.current,request=++dataRequest.current;detailRequest.current++;setDetail(null);setError('');try{const r=await api.getEndpoint<{data:Data}>('/api/staff/channel/finance');if(n===epoch.current&&request===dataRequest.current)setData(r.data)}catch(e){if(n===epoch.current&&request===dataRequest.current)setError(e instanceof Error?e.message:String(e));throw e}},[api])
 const command=useMemo(()=>new DurableStaffCommand<Record<string,unknown>,unknown>(`channel-finance:${auth.session.id}`,(body,key,context)=>api.postEndpoint('/api/staff/channel/finance',body,{idempotencyKey:`channel-${key}`,channelRecovery:context.recovery}),undefined,true),[api,auth.session.id])
 useEffect(()=>{epoch.current++;writing.current=false;setBusy(false);setNotice('');setData(null);setDetail(null);setError('');if(auth.permissions.includes('channel.settle'))void reload().catch(()=>{});try{setPending(command.pending()!==null)}catch(e){setError(String(e))}return()=>{epoch.current++}},[auth.session.id,auth.permissions,command,reload])
 async function submit(body?:Record<string,unknown>){if(writing.current)return;writing.current=true;setBusy(true);setError('');const n=epoch.current;try{if(body)await command.submit(body);else await command.recover();if(n!==epoch.current)return;await command.refresh(async()=>{await reload();if(n!==epoch.current)throw new Error('登录状态已变化，请在原账号核对回执')});if(n===epoch.current)setNotice('已保存并核对最新记录；付款登记不会发起银行转账。')}catch(e){if(n===epoch.current)setError(e instanceof Error?e.message:String(e))}finally{if(n===epoch.current){writing.current=false;setBusy(false);try{setPending(command.pending()!==null)}catch{setPending(true)}}}}
 async function inspect(id:string){const n=epoch.current,request=++detailRequest.current;setError('');setDetail(null);try{const r=await api.getEndpoint<{data:{statement:Row;lines:Row[]}}>(`/api/staff/channel/statement/${id}`);if(n===epoch.current&&request===detailRequest.current)setDetail(r.data)}catch(e){if(n===epoch.current&&request===detailRequest.current)setError(e instanceof Error?e.message:String(e))}}
 function form(e:React.FormEvent<HTMLFormElement>){e.preventDefault();const f=new FormData(e.currentTarget),v=(k:string)=>String(f.get(k)??'');const body:Record<string,unknown>={action,reason:v('reason')}
  if(action==='account'){body.partnerId=v('partnerId');body.reference=v('reference')}
  else if(action==='statement'){body.promoterId=v('promoterId');body.accountId=v('accountId')}
  else if(action==='reconcile')body.promoterId=v('promoterId')
  else body.id=v('id')
  if(action==='reissue-account')body.accountId=v('accountId')
  if(['start-payment','return-payment'].includes(action))body.amountMinor=Math.round(Number(v('amount'))*100)
  if(['start-payment','return-payment','confirm-payment'].includes(action))body.reference=v('reference')
  if(action==='confirm-payment')body.success=v('success')==='true'
  void submit(body)
 }
 if(!auth.permissions.includes('channel.settle'))return null
 const label=(id:unknown)=>partners.find(p=>p.promoterId===id)?.promoterName??String(id).slice(-8),disabled=busy||pending
 const ids=action==='verify-account'?data?.accounts:action==='confirm-payment'||action==='return-payment'?data?.payouts:data?.statements
 return <details><summary>渠道财务 · 退款计佣、对账及付款登记</summary>
  <p>按实际净消费累计计佣；退款处理中冻结。原银行付款状态不明时先查原回单。账户及付款必须由另一位有权限的员工复核。</p>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <button type="button" disabled={busy} onClick={()=>void reload().catch(()=>{})}>刷新核算记录</button>{pending&&<button type="button" disabled={busy} onClick={()=>void submit()}>恢复原财务操作</button>}
  <form onSubmit={form}><fieldset disabled={disabled} className="gift-form-grid">
   <label>办理事项<select value={action} onChange={e=>setAction(e.target.value)}>{[['reconcile','重新核对原交易'],['account','登记新版收款账户依据'],['verify-account','独立复核账户'],['statement','生成成熟账项结算单'],['approve','独立审批已确认结算单'],['cancel','取消未付款结算单'],['reissue-account','更换账户，生成原单尾款续结单'],['start-payment','登记线下付款待查账'],['confirm-payment','独立核实付款结果'],['return-payment','登记银行退回']].map(([v,l])=><option value={v} key={v}>{l}</option>)}</select></label>
   {action==='account'&&<label>合作主体<select name="partnerId" required>{partners.map(p=><option key={p.promoterId} value={p.id}>{p.name}</option>)}</select></label>}
   {['statement','reconcile'].includes(action)&&<label>推荐人<select name="promoterId" required>{partners.map(p=><option key={p.promoterId} value={p.promoterId}>{p.name} · {p.promoterName}</option>)}</select></label>}
   {['statement','reissue-account'].includes(action)&&<label>已核实账户<select name="accountId" required>{data?.accounts.filter(a=>a.verifiedAt&&!a.revokedAt).map(a=><option key={String(a.id)} value={String(a.id)}>{String(a.subject)} · {String(a.reference)}</option>)}</select></label>}
   {!['account','statement','reconcile'].includes(action)&&<label>原记录<select name="id" required>{ids?.map(r=><option key={String(r.id)} value={String(r.id)}>{String(r.id).slice(-8)} · {r.status?state(r.status):String(r.subject)} {r.amountMinor?yuan(r.amountMinor):''}</option>)}</select></label>}
   {['account','start-payment','confirm-payment','return-payment'].includes(action)&&<label>{action==='account'?'经授权保管的账户资料编号及脱敏账户标识':'银行流水或查账凭据编号（全店唯一）'}<input key={action} name="reference" required minLength={4} maxLength={200}/></label>}
   {['start-payment','return-payment'].includes(action)&&<label>金额（元）<input name="amount" type="number" step="0.01" min="0.01" required/></label>}
   {action==='confirm-payment'&&<label>核实结果<select name="success"><option value="true">有原回单：成功</option><option value="false">已查明：失败</option></select></label>}
   <label>办理依据<input name="reason" required minLength={2} maxLength={500}/></label><button>确认办理并留痕</button>
  </fieldset></form>
  <h4>推荐人净余额</h4>{data?.balances.map(b=><p key={String(b.promoterId)}>{label(b.promoterId)} · 应计 {yuan(b.accruedMinor)} · 实付净额 {yuan(b.paidMinor)} · 未付余额 {yuan(b.balanceMinor)}（负数抵扣后续佣金）</p>)}
  <h4>结算单</h4><p>账户变更的尾款续结不新增佣金，原单与续结单金额不能相加；总应付以推荐人净余额为准。</p>{data?.statements.map(s=><p key={String(s.id)}>{String(s.id).slice(-8)} · {label(s.promoterId)} · {state(s.status)} · {s.sourceStatementId?`原单 ${String(s.sourceStatementId).slice(-8)} 的尾款续结`:'原结算单'} · 本单 {yuan(s.amountMinor)} · 实付净额 {yuan(s.paidMinor)} <button type="button" disabled={busy} onClick={()=>void inspect(String(s.id))}>核对原消费和退款明细</button></p>)}
  {detail&&<section><h4>原结算单 {String(detail.statement.id).slice(-8)} 的出单快照</h4><p>收款主体 {String(detail.statement.accountSubject??'待核对')} · 账户资料/脱敏标识 {String(detail.statement.accountReference??'待核对')}</p><p>{detail.statement.sourceStatementId?'本单是关联原结算单的尾款续结，不新增佣金；下列明细来自原单。':'以下是该单生成时的依据。'}审批、付款前仍会重新读取实时交易。累计本金用于核对，实际付款以本单佣金差额为准。</p>{detail.lines.map((line,i)=><div key={i}><p>客组 {String(line.visitId).slice(-8)} · 佣金差额 {yuan(line.deltaMinor)} · {String(line.createdAt)}</p>{((line.evidence as {evidence?:Row[]})?.evidence??[]).map((o,j)=><p key={j}>原订单 {String(o.orderId)} · {o.excluded?`排除：${o.excluded}`:`实收 ${yuan(o.paid)} · 退款 ${yuan(o.refunded)} · 合格本金 ${yuan(o.basis)}`}</p>)}</div>)}</section>}
  <h4>消费核算与冻结</h4>{data?.positions.map(p=><p key={String(p.visitId)}>{label(p.promoterId)} · 客组 {String(p.visitId).slice(-8)} · 合格净消费 {yuan(p.basisMinor)} · 应计 {yuan(p.commissionMinor)} · {p.frozen?`冻结：${(p.reasons as string[]).join('、')}`:`成熟时间 ${p.maturesAt}`} · 更新 {String(p.checkedAt)}{p.stale?' · 数据待同步':''}</p>)}
  <h4>退款与佣金差额</h4>{data?.ledger.map(l=><p key={String(l.id)}>{label(l.promoterId)} · 客组 {String(l.visitId).slice(-8)} · 本次差额 {yuan(l.deltaMinor)} · {String(l.createdAt)}</p>)}
  <p>列表显示最近 {data?.limit??500} 条；所有出单和付款校验使用完整账本，不以当前列表合计作为应付。</p>
 </details>
}
