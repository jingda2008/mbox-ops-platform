import {useRef,useState} from 'react'
import type {StaffFulfillmentItem} from './types'
export function DeliveryBatchComposer({items,onSubmit,onChanged}:{items:StaffFulfillmentItem[];onSubmit(items:Array<{taskId:string;quantity:number}>):Promise<void>;onChanged():Promise<void>}){
 const [quantities,setQuantities]=useState<Record<string,number>>({}),[busy,setBusy]=useState(false),[notice,setNotice]=useState('')
 const lock=useRef(false)
 const available=items.filter(item=>item.canDeliver&&item.readyForDelivery&&(item.deliveryUnbatchedQuantity??0)>0)
 async function submit(){
  if(lock.current)return
  const selected=available.filter(item=>(quantities[item.taskId]??0)>0).map(item=>({taskId:item.taskId,quantity:quantities[item.taskId]!}))
  if(!selected.length){setNotice('先填写本批需要配送的数量');return}
  lock.current=true;setBusy(true)
  try{await onSubmit(selected);setQuantities({});setNotice('本批已确认，配送票后台生成；打印失败不影响送达操作。');void onChanged()}
  catch(error){setNotice(error instanceof Error?error.message:'本批未确认，请核对后重试')}
  finally{lock.current=false;setBusy(false)}
 }
 if(!available.length)return null
 return <details><summary>合并本批配送单</summary><p>只选同一桌次、同一工作站；填2即本批送2，剩余数量可留到下一批。本批备齐不代表送达；分批配送时，必须等该项所有数量都送到后再点“全部已送达”。打印失败不妨碍现场配送。</p>
  {available.map(item=><label key={item.taskId} style={{display:'flex',gap:8,alignItems:'center',marginBlock:8}}>
    <span style={{flex:1,minWidth:0}}>{item.table.code} · {item.stationCode==='kitchen'?'后厨':'吧台'} · {item.item.productName}{item.item.note?`（${item.item.note}）`:''} · 未合单 {item.deliveryUnbatchedQuantity}</span>
    <input aria-label={`${item.item.productName}本批数量`} type="number" min={0} max={item.deliveryUnbatchedQuantity} step={1} disabled={busy} value={quantities[item.taskId]??0} style={{width:72}} onChange={event=>setQuantities(current=>({...current,[item.taskId]:Number(event.target.value)}))}/>
  </label>)}
  <button type="button" disabled={busy} onClick={()=>void submit()}>{busy?'正在确认本批…':'确认本批备齐并生成配送单'}</button>{notice&&<p role="status">{notice}</p>}
 </details>
}
