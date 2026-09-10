import {useEffect,useRef,useState} from 'react'
import type {NormalizedApiClient,StaffAuthView} from '../normalized-api'
import {executeRecoverableCommand} from './recoverable-command'
import {createIdempotencyKey} from './cashier-mutation'
import {useConfirmationDialog} from './ConfirmationDialog'

interface Review{refund_id:string;reservation_id:string;order_reference:string;refund_reference:string;refund_amount_minor:string;currency:string;benefit_code:string;quantity:number;status:string;action:string|null;reason:string|null;evidence_reference:string|null;replacement_benefit_id?:string|null;replacement_quantity?:number|null}
interface Replacement{id:string;benefit_code:string;quantity_total:number;valid_until:string|null}
const key=(row:Review)=>`${row.refund_id}:${row.reservation_id}`
export function CouponRefundReviewPanel({api,auth}:{api:NormalizedApiClient;auth:StaffAuthView}){
 const [rows,setRows]=useState<Review[]>([]),[cursor,setCursor]=useState<string|null>(null),[state,setState]=useState<'pending'|'resolved'>('pending')
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[loaded,setLoaded]=useState(false),[selected,setSelected]=useState<string|null>(null)
 const [action,setAction]=useState(''),[reason,setReason]=useState(''),[evidence,setEvidence]=useState('')
 const [replacements,setReplacements]=useState<Replacement[]>([]),[replacementCursor,setReplacementCursor]=useState<string|null>(null),[replacementId,setReplacementId]=useState('')
 const mounted=useRef(false),flight=useRef(false),epoch=useRef(0),{confirmAction}=useConfirmationDialog()
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++}},[])
 async function load(nextState=state,more=false){
  if(flight.current)return;flight.current=true;setBusy(true);setMessage('');const current=++epoch.current
  try{const query=new URLSearchParams({state:nextState,...(more&&cursor?{cursor}:{})});const response=await api.getEndpoint<{data:{items:Review[];nextCursor:string|null}}>(`/api/staff/member-gifts/refund-reviews?${query}`)
   if(mounted.current&&current===epoch.current){setRows(previous=>more?[...new Map([...previous,...response.data.items].map(row=>[key(row),row])).values()]:response.data.items);setCursor(response.data.nextCursor);setState(nextState);setLoaded(true);setSelected(null);return true}
  }catch(error){if(mounted.current&&current===epoch.current)setMessage(error instanceof Error?error.message:'读取失败，不能判定没有待办')}
  finally{flight.current=false;if(mounted.current)setBusy(false)}
 }
 async function loadReplacements(row:Review,more=false){
  if(flight.current)return;flight.current=true;setBusy(true);setMessage('')
  try{const query=new URLSearchParams({refundId:row.refund_id,reservationId:row.reservation_id,...(more&&replacementCursor?{cursor:replacementCursor}:{})})
   const response=await api.getEndpoint<{data:{items:Replacement[];nextCursor:string|null}}>(`/api/staff/member-gifts/refund-replacement-options?${query}`)
   if(mounted.current){setReplacements(previous=>more?[...new Map([...previous,...response.data.items].map(item=>[item.id,item])).values()]:response.data.items);setReplacementCursor(response.data.nextCursor)}
  }catch(error){if(mounted.current)setMessage(error instanceof Error?error.message:'补偿券读取失败，请重试')}
  finally{flight.current=false;if(mounted.current)setBusy(false)}
 }
 async function decide(row:Review){
  if(flight.current||!action||reason.trim().length<2||evidence.trim().length<2||(action==='replacement_coupon'&&!replacementId))return
  flight.current=true;setBusy(true);setMessage('');let saved=false
  try{
   if(!await confirmAction({title:'确认权益复核',description:`订单 ${row.order_reference}：${action==='no_return'?'依据原规则不返券':action==='replacement_coupon'?'关联已发到本人券包的补偿券':'已完成线下补偿'}。此操作只记录权益处理结论，不发券、不退款、不修改库存。请确保凭证真实且未重复补偿。`,confirmLabel:'记录复核结果'})||!mounted.current)return
   const body={refundId:row.refund_id,reservationId:row.reservation_id,action,reason:reason.trim(),evidenceReference:evidence.trim(),...(action==='replacement_coupon'?{replacementBenefitId:replacementId}:{})}
   await executeRecoverableCommand(`${auth.employee.id}:coupon-refund:${key(row)}`,body,createIdempotencyKey('coupon-review'),idempotencyKey=>api.postEndpoint('/api/staff/member-gifts/refund-reviews',body,{idempotencyKey}))
   saved=true
  }catch(error){if(mounted.current)setMessage(error instanceof Error?error.message:'结果尚未确认，请读取记录核对后重试')}
  finally{flight.current=false;if(mounted.current)setBusy(false)}
  if(saved&&mounted.current){const refreshed=await load();if(mounted.current)setMessage(refreshed?'权益复核已记录，可在已处理记录查看；未改动收退款金额。':'权益复核已记录，但列表刷新失败，请重新读取核对。未改动收退款金额。')}
 }
 return <details className="coupon-refund-reviews"><summary>退款后的权益复核</summary>
  <p>退款不自动返券。核对制作状态和原规则后记录结果；补发须先走已审批的发券活动，再关联本人新券，不能重复充作多笔补偿。</p>
  <div className="gift-actions"><button type="button" disabled={busy} aria-pressed={state==='pending'} onClick={()=>void load('pending')}>读取待复核权益</button><button type="button" disabled={busy} aria-pressed={state==='resolved'} onClick={()=>void load('resolved')}>已处理记录</button></div>
  {loaded&&rows.length===0&&<p>{state==='pending'?'当前没有待复核权益':'当前没有已处理记录'}</p>}
  <div className="gift-records">{rows.map(row=><article key={key(row)}><strong>{row.benefit_code} · {row.quantity}份</strong><p>订单 {row.order_reference}</p><p>本笔退款 ¥{(Number(row.refund_amount_minor)/100).toFixed(2)}（订单退款金额，不是每张券的补偿金额）</p><p>券状态：{row.status==='redeemed'?'已核销':row.status==='reserved'?'订单占用中':'已释放或过期'}</p>
   {row.action?<p>权益结果：{row.action==='no_return'?'按原规则不返券':row.action==='replacement_coupon'?`已关联补偿券 ${row.replacement_quantity}份`:'线下补偿已登记'} · {row.reason} · 凭证：{row.evidence_reference}</p>:auth.permissions.includes('loyalty.policy.publish')&&<>
    <button type="button" disabled={busy} onClick={()=>{setSelected(key(row));setAction('');setReason('');setEvidence('');setReplacements([]);setReplacementCursor(null);setReplacementId('')}}>复核此权益</button>
    {selected===key(row)&&<fieldset disabled={busy}>
      <legend>权益处理结果</legend>
      <label>处理方式<select aria-label="权益处理方式" value={action} onChange={e=>setAction(e.target.value)}>
        <option value="">请选择已确认的处理方式</option>
        <option value="no_return">按原规则不返券</option>
        <option value="external_compensation">已完成线下补偿</option>
        <option value="replacement_coupon">关联已发出的补偿券</option>
      </select></label>
      {action==='replacement_coupon'&&<>
        <p>仅显示这笔退款申请后，已发到同一会员且尚未使用、未关联补偿的券。请选择双方已确认的补偿，不会在这里另发一张券。</p>
        <button type="button" onClick={()=>void loadReplacements(row)}>读取本人新券</button>
        <label>已发补偿券<select aria-label="已发补偿券" value={replacementId} onChange={event=>setReplacementId(event.target.value)}><option value="">请读取并选择</option>{replacements.map(item=><option key={item.id} value={item.id}>{item.benefit_code} · {item.quantity_total}份</option>)}</select></label>
        {replacementCursor&&<button type="button" onClick={()=>void loadReplacements(row,true)}>更多本人新券</button>}
      </>}
      <label>权益复核原因<textarea value={reason} maxLength={500} onChange={e=>setReason(e.target.value)}/></label>
      <label>规则或补偿凭证<input value={evidence} maxLength={200} onChange={e=>setEvidence(e.target.value)}/></label>
      <button type="button" disabled={!action||reason.trim().length<2||evidence.trim().length<2||(action==='replacement_coupon'&&!replacementId)} onClick={()=>void decide(row)}>记录权益处理</button>
    </fieldset>}
   </>}</article>)}</div>
  {cursor&&<button type="button" disabled={busy} onClick={()=>void load(state,true)}>更多权益复核</button>}{message&&<p role="status">{message}</p>}
 </details>
}
