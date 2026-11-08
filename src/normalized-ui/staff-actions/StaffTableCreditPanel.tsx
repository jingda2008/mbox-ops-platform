import {useConfirmationDialog} from '../ConfirmationDialog'
import {useCallback,useEffect,useRef,useState} from 'react'
import {STAFF_SESSION_BINDING_HEADER} from '../../shared/staff-session-binding'
import {executeRecoverableCommand} from '../recoverable-command'
import {CustomerPaymentCodeScanner} from '../../components/CustomerPaymentCodeScanner'
import type {OnlinePaymentAction} from '../../shared/online-payment-contracts'
type View={session:{tableCode:string;locationVersion:number;minimumMinor:string;status:string};orders:Array<{id:string;publicId:string;dueMinor:string;linked?:boolean}>;pending:Array<{id:string;publicId:string;amountMinor:string;method?:string}>;prepayment:null|{availableMinor:number;receivedMinor:number;initialFundingRequiredMinor:number}}
const money=(n:number|string)=>`¥${(Number(n)/100).toFixed(2)}`
export function StaffTableCreditPanel({sessionId,staffSessionId,permissions,initialOrderId,onUpdated}:{sessionId:string;staffSessionId?:string;permissions:readonly string[];initialOrderId?:string;onUpdated?:(remainingMinor?:number)=>void}){
 const {confirmAction}=useConfirmationDialog()
 const [open,setOpen]=useState(false),[view,setView]=useState<View|null>(null),[amount,setAmount]=useState(''),[payer,setPayer]=useState(''),[consent,setConsent]=useState(false),[provider,setProvider]=useState('postar'),[reference,setReference]=useState(''),[terminal,setTerminal]=useState(''),[selected,setSelected]=useState<string[]>(initialOrderId?[initialOrderId]:[]),[review,setReview]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[action,setAction]=useState<OnlinePaymentAction|null>(null),[qr,setQr]=useState(''),[scanner,setScanner]=useState(false)
 const writing=useRef(false),generation=useRef(0)
 const request=useCallback(async<T,>(path:string,body?:object,key?:string):Promise<T>=>{
  const headers=new Headers({accept:'application/json'});if(staffSessionId)headers.set(STAFF_SESSION_BINDING_HEADER,staffSessionId)
  if(body){headers.set('content-type','application/json');headers.set('idempotency-key',key!)}
  const response=await fetch(`/api/${path}`,{method:body?'POST':'GET',headers,credentials:'include',body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)}),result=await response.json()
  if(!response.ok)throw Object.assign(new Error(result.error?.message??'收款状态读取失败'),{status:response.status});return result.data
 },[staffSessionId])
 const reload=useCallback(async()=>{const epoch=generation.current;const data=await request<View>(`payments/table-prepayment/${sessionId}`);if(epoch===generation.current){setView(data);setSelected(ids=>ids.filter(id=>data.orders.some(order=>order.id===id)))}return data},[request,sessionId])
 useEffect(()=>{generation.current++;setOpen(false);setView(null);setReview(false);setAction(null);setQr('');setError('');setNotice('');setAmount('');setPayer('');setConsent(false);setSelected(initialOrderId?[initialOrderId]:[]);return()=>{generation.current++}},[sessionId,staffSessionId,initialOrderId])
 useEffect(()=>{let active=true;setQr('');if(action?.presentation==='qr'&&typeof action.payload?.qrCodeUrl==='string')void import('qrcode').then(m=>m.default.toDataURL(String(action.payload?.qrCodeUrl),{width:240,margin:1})).then(url=>{if(active)setQr(url)});return()=>{active=false}},[action])
 if(!permissions.includes('payment.initiate.staff'))return null
 const amountMinor=Math.round(Number(amount)*100),due=(view?.orders??[]).filter(o=>selected.includes(o.id)||o.linked).reduce((n,o)=>n+Number(o.dueMinor),0),available=view?.prepayment?.availableMinor??0
 const valid=/^\d+(\.\d{1,2})?$/.test(amount)&&amountMinor>0&&amountMinor<=100_000_000&&payer.trim().length>=2&&consent&&(provider==='postar'||reference.trim().length>0)&&(provider!=='physical_pos'||terminal.trim().length>0)
 const submit=async(authCode?:string)=>{
  if(!view||!valid||writing.current)return;writing.current=true;setBusy(true);setError('');const epoch=generation.current
  const body={sessionId,amountMinor,expectedLocationVersion:view.session.locationVersion,expectedMinimumMinor:Number(view.session.minimumMinor),orderIds:selected,payerReference:payer.trim(),sharedTableConsent:true,provider,method:provider==='postar'?(authCode?'auth_code':'native_qr'):provider==='cash'?'cash':provider==='physical_pos'?'card':'manual',receiptReference:reference.trim(),terminalId:terminal.trim(),externalMethodCode:'other',collectionNote:payer.trim()}
  try{
   const result=await executeRecoverableCommand(`staff-credit:${staffSessionId}:${sessionId}`,body,`staff-credit-${crypto.randomUUID()}`,key=>request<{payment:{id:string;status:string};action:OnlinePaymentAction|null}>('payments/table-prepayment',{...body,...(authCode?{customerAuthCode:authCode}:{})},key))
   if(epoch!==generation.current)return
   setAction(result.action);setScanner(false);setReview(false)
   setNotice(result.payment.status==='succeeded'?'实收已登记，原款已用于所选订单，剩余金额保留为本桌余额。':'已生成原付款，请以渠道到账结果为准。')
   const fresh=await reload();onUpdated?.(initialOrderId?Number(fresh.orders.find(o=>o.id===initialOrderId)?.dueMinor??0):undefined)
  }catch(e){if(epoch===generation.current)setError(e instanceof Error?e.message:'结果待核对，请查询原付款')}
  finally{writing.current=false;if(epoch===generation.current)setBusy(false)}
 }
 const resume=async(id:string)=>{setBusy(true);setError('');try{setAction(await request<OnlinePaymentAction>(`payments/table-prepayment/${id}/resume`,{},`credit-resume-${id}`));await reload()}catch(e){setError(e instanceof Error?e.message:'请查询原付款')}finally{setBusy(false)}}
 const close=async(id:string,amountMinor:string)=>{if(!await confirmAction({title:'关闭原预付款',description:`确认向渠道关闭原预付款 ${money(amountMinor)}？仅渠道确认关闭后才能重新收款。`,confirmLabel:'申请渠道关闭'}))return;setBusy(true);setError('');try{await request(`payments/${id}/provider-close`,{reason:'顾客取消原预收付款，经收银核对申请渠道关闭',expectedAmountMinor:Number(amountMinor)},`credit-close-${id}`);setAction(null);await reload()}catch(e){setError(e instanceof Error?e.message:'原付款关闭结果待核对')}finally{setBusy(false)}}
 const query=async(id:string)=>{setBusy(true);setError('');try{await request(`payments/${id}/provider-query`,{},`credit-query-${crypto.randomUUID()}`);const fresh=await reload();onUpdated?.(initialOrderId?Number(fresh.orders.find(o=>o.id===initialOrderId)?.dueMinor??0):undefined);setNotice('已查询原付款，请核对余额和剩余应付。')}catch(e){setError(e instanceof Error?e.message:'原付款仍待核对')}finally{setBusy(false)}}
 return <section className="table-service-panel staff-credit-panel" aria-label="自填收款与本桌余额"><button type="button" disabled={busy} onClick={()=>{setOpen(!open);if(!open)void reload().catch(e=>setError(e.message))}}>自填收款／预收与补款</button>
 {open&&view&&<><p>{view.session.tableCode} · 本桌低消 {money(view.session.minimumMinor)} · 预收累计实收 {money(view.prepayment?.receivedMinor??0)} · 可用余额 {money(available)} · 预收要求还差 {money(view.prepayment?.initialFundingRequiredMinor??view.session.minimumMinor)}</p>
 {view.orders.map(o=><label key={o.id}><input type="checkbox" disabled={busy||review||o.linked} checked={selected.includes(o.id)||!!o.linked} onChange={e=>setSelected(ids=>e.target.checked?[...ids,o.id]:ids.filter(id=>id!==o.id))}/>{o.publicId} · 待付 {money(o.dueMinor)}{o.linked?'（已关联，继续结清）':''}</label>)}
 {view.pending.map(p=><div key={p.id}><p>原预付款 {p.publicId} · {money(p.amountMinor)} 待确认</p>{p.method==='native_qr'&&<button type="button" disabled={busy} onClick={()=>void resume(p.id)}>继续原付款码</button>}{permissions.includes('reconciliation.view')&&<><button type="button" disabled={busy} onClick={()=>void query(p.id)}>查询原预付款</button>{permissions.includes('payment.collect.all_tables')&&<button type="button" disabled={busy} onClick={()=>void close(p.id,p.amountMinor)}>申请关闭原付款</button>}</>}</div>)}
 {view.session.status==='open'&&!view.pending.length&&<fieldset disabled={busy||review}><label>本次收款金额（元）<input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)}/></label><button type="button" onClick={()=>setAmount((Math.max(0,due-available)/100).toFixed(2))}>填入所选订单剩余应付 {money(Math.max(0,due-available))}</button>
 <label>付款人及收款说明<input value={payer} maxLength={200} onChange={e=>setPayer(e.target.value)}/></label>
 <label>收款方式<select value={provider} onChange={e=>setProvider(e.target.value)}><option value="postar">线上扫码支付</option>{permissions.includes('payment.manual.cash.record')&&<option value="cash">现金实收登记</option>}{permissions.includes('payment.manual.pos.record')&&<option value="physical_pos">实体 POS 实收登记</option>}{permissions.includes('payment.manual.external.record')&&<option value="external_manual">其他线下实收登记</option>}</select></label>
 {provider!=='postar'&&<label>实收凭证号<input value={reference} maxLength={128} onChange={e=>setReference(e.target.value)}/></label>}{provider==='physical_pos'&&<label>POS 终端号<input value={terminal} onChange={e=>setTerminal(e.target.value)}/></label>}
 <label><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>付款人已确认原款用于本桌所选订单及后续共同点单，余款不自动转服务费</label><button type="button" disabled={!valid} onClick={()=>setReview(true)}>核对本次收款</button></fieldset>}
 {review&&<div role="group" aria-label="确认自填收款"><p>本次 {money(amountMinor)}；所选订单尚欠 {money(due)}。余额按下单顺序结算本桌已关联及本次所选订单，未结清部分继续待付；预计剩余额度 {money(Math.max(0,available+amountMinor-due))}。</p>{provider!=='postar'&&<p role="alert">仅在确已收到款项后确认。输入金额不代表到账。</p>}<button type="button" disabled={busy} onClick={()=>void submit()}>{provider==='postar'?'出示预收付款码':'确认已实际收到本次款项'}</button>{provider==='postar'&&<button type="button" disabled={busy} onClick={()=>setScanner(true)}>扫描顾客付款码收取本次金额</button>}<button type="button" disabled={busy} onClick={()=>setReview(false)}>返回核对</button></div>}
 {qr&&<img src={qr} alt="本次预收款付款二维码" style={{maxWidth:'100%'}}/>}{action&&permissions.includes('reconciliation.view')&&<button type="button" disabled={busy} onClick={()=>void query(action.paymentId)}>查询本次支付结果</button>}
 <button type="button" disabled={busy} onClick={()=>void reload().catch(e=>setError(e.message))}>刷新余额与待付金额</button></>}
 {scanner&&view&&<CustomerPaymentCodeScanner tableCode={view.session.tableCode} amountLabel={money(amountMinor)} onClose={()=>setScanner(false)} onConfirm={code=>submit(code)}/>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}</section>
}
