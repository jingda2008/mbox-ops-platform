import {useRef,useState} from 'react'
import type {NormalizedApiClient} from '../normalized-api'
import {executeRecoverableCommand} from './recoverable-command'
export function OrderStockReturnForm({api,itemId,quantity,employeeId,onChanged}:{api:NormalizedApiClient;itemId:string;quantity:number;employeeId:string;onChanged?():Promise<void>}){
 const [units,setUnits]=useState(1),[mode,setMode]=useState<'unmade'|'returned_unopened'>('returned_unopened'),[reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('')
 const lock=useRef(false)
 async function submit(){
  if(lock.current)return
  if(!confirmed||!Number.isSafeInteger(units)||units<1||units>quantity||reason.trim().length<3){setNotice('请核实数量、填写原因，并确认商品处理事实');return}
  lock.current=true;setBusy(true)
  const endpoint=`/api/operations/order-items/${encodeURIComponent(itemId)}/stock-return`
  const body={quantity:units,disposition:mode,reason:reason.trim(),unopenedConfirmed:confirmed}
  try{await executeRecoverableCommand(`${employeeId}:${endpoint}`,body,crypto.randomUUID(),key=>api.postEndpoint(endpoint,body,{idempotencyKey:key}));setNotice('已记录实际退库；没有再次退款，也没有重复出品。');setConfirmed(false);setReason('');setUnits(1);void onChanged?.()}
  catch(error){setNotice(error instanceof Error?error.message:'退库结果未确认，请保持原填写内容重试核对')}
  finally{lock.current=false;setBusy(false)}
 }
 return <details><summary>退款商品库存处理</summary><p>退款不等于退库。已开封、已消耗或制作好的配方不能恢复为原料；此操作不会再次退款。</p>
 <label>退回数量<input type="number" min={1} max={quantity} step={1} value={units} disabled={busy} onChange={event=>setUnits(Number(event.target.value))}/></label>
 <label>实际情况<select value={mode} disabled={busy} onChange={event=>{setMode(event.target.value as typeof mode);setConfirmed(false)}}><option value="returned_unopened">未开封整包装，已实际退回</option><option value="unmade">尚未制作，出品已取消</option></select></label>
 <label>核对说明<input value={reason} maxLength={1000} disabled={busy} onChange={event=>setReason(event.target.value)}/></label>
 <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/>我已核实上述情况和实际数量</label>
 <button type="button" disabled={busy||!confirmed} onClick={()=>void submit()}>{busy?'正在登记…':'确认实际退库'}</button>{notice&&<p role="status">{notice}</p>}</details>
}
