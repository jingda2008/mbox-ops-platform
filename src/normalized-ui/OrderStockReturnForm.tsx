import {useMemo,useRef,useState} from 'react'
import type {StockReturnCapability} from '../shared/operating-history'
import type {NormalizedApiClient} from '../normalized-api'
import {OrderStockReturnRecovery} from './order-stock-return-recovery'
type Props={api:NormalizedApiClient;itemId:string;quantity:number;employeeId:string;capability?:StockReturnCapability;label?:string;onChanged():Promise<void>}
export function OrderStockReturnForm(props:Props){return <StockReturnForm key={`${props.employeeId}:${props.itemId}`} {...props}/>}
function StockReturnForm({api,itemId,quantity,employeeId,capability,label,onChanged}:Props){
 const recovery=useMemo(()=>new OrderStockReturnRecovery(api,employeeId,itemId,undefined,label),[api,employeeId,itemId,label])
 const original=recovery.pending()
 const [units,setUnits]=useState(original?.body.quantity??1),[mode,setMode]=useState<'unmade'|'returned_unopened'>(original?.body.disposition??(capability&&!capability.canReturnUnopened?'unmade':'returned_unopened')),[reason,setReason]=useState(original?.body.reason??''),[confirmed,setConfirmed]=useState(original?.body.unopenedConfirmed??false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('')
 const lock=useRef(false),pending=recovery.pending(),locked=busy||!!pending
 async function refreshRemaining(){
  await recovery.refresh(onChanged)
  setConfirmed(false);setReason('');setUnits(1)
  setNotice('已核对剩余数量。本次退库完成，没有再次退款或出品。')
 }
 async function run(recover=false){
  if(lock.current)return
  if(!recover&&(!confirmed||!Number.isSafeInteger(units)||units<1||units>quantity||reason.trim().length<3)){setNotice('请核实数量、填写原因，并确认商品处理事实');return}
  lock.current=true;setBusy(true)
  try{
   if(recover)await recovery.recover()
   else await recovery.submit({quantity:units,disposition:mode,reason:reason.trim(),unopenedConfirmed:confirmed})
   setNotice('退库登记已成功，正在核对剩余数量。')
   await refreshRemaining()
  }catch(error){setNotice(recovery.pending()?.recordId?'退库已经成功，剩余数量暂未读回。只需刷新数量，不要再次登记。':error instanceof Error?error.message:'退库结果未确认，请恢复原登记结果')}
  finally{lock.current=false;setBusy(false)}
 }
 async function refresh(){
  if(lock.current)return
  lock.current=true;setBusy(true)
  try{await refreshRemaining()}catch{setNotice('退库已经成功，剩余数量仍未读回，请稍后刷新数量。')}
  finally{lock.current=false;setBusy(false)}
 }
 if(!pending&&(quantity<1||capability&&!capability.canReturnUnmade&&!capability.canReturnUnopened))return null
 return <details><summary>退款商品库存处理</summary><p>退款不等于退库。已开封、已消耗或制作好的配方不能恢复为原料；此操作不会再次退款。</p>
 <label>退回数量<input type="number" min={1} max={quantity} step={1} value={units} disabled={locked} onChange={event=>setUnits(Number(event.target.value))}/></label>
 <label>实际情况<select value={mode} disabled={locked} onChange={event=>{setMode(event.target.value as typeof mode);setConfirmed(false)}}>{(!capability||capability.canReturnUnopened||original?.body.disposition==='returned_unopened')&&<option value="returned_unopened">未开封整包装，已实际退回</option>}{(!capability||capability.canReturnUnmade||original?.body.disposition==='unmade')&&<option value="unmade">尚未制作，出品已取消</option>}</select></label>
 <label>核对说明<input value={reason} maxLength={1000} disabled={locked} onChange={event=>setReason(event.target.value)}/></label>
 <label><input type="checkbox" checked={confirmed} disabled={locked} onChange={event=>setConfirmed(event.target.checked)}/>我已核实上述情况和实际数量</label>
 <button type="button" disabled={locked||!confirmed} onClick={()=>void run()}>{busy?'正在核对…':'确认实际退库'}</button>
 {pending?.recordId?<div><details><summary>退库记录详情</summary><p>{pending.recordId}</p></details><p>本次退库已登记。<button type="button" disabled={busy} onClick={()=>void refresh()}>刷新剩余数量</button></p></div>:pending&&<p>上次登记结果待确认。<button type="button" disabled={busy} onClick={()=>void run(true)}>恢复原退库结果</button></p>}
 {notice&&<p role="status">{notice}</p>}</details>
}
