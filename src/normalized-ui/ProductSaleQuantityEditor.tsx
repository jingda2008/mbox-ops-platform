import {useEffect,useState} from 'react'
import {NormalizedApiClient} from '../normalized-api'
import {executeRecoverableCommand} from './recoverable-command'

type Quantity={remaining:number|null;version:string;reserved:number}
export function ProductSaleQuantityEditor({api,productId,onSaved}:{api:NormalizedApiClient;productId:string;onSaved:()=>Promise<void>}){
  const [current,setCurrent]=useState<Quantity|null>(null)
  const [value,setValue]=useState('')
  const [busy,setBusy]=useState(false)
  const [notice,setNotice]=useState('')
  const endpoint=`/api/catalog/products/${encodeURIComponent(productId)}/sale-quantity`
  async function read(){
    const result=await api.getEndpoint<{data:Quantity}>(endpoint)
    setCurrent(result.data);setValue(result.data.remaining===null?'':String(result.data.remaining))
  }
  useEffect(()=>{let active=true;api.getEndpoint<{data:Quantity}>(endpoint).then(result=>{
    if(active){setCurrent(result.data);setValue(result.data.remaining===null?'':String(result.data.remaining))}
  }).catch(error=>{if(active)setNotice(error instanceof Error?error.message:'数量未能读取，请重试')});return()=>{active=false}},[api,endpoint])
  async function save(){
    if(!current||busy)return
    if(value!==''&&(!/^\d+$/.test(value)||Number(value)>1000000)){setNotice('请填写0到1000000的整数，或留空沿用原管理方式');return}
    const body={remaining:value===''?null:Number(value),expectedVersion:current.version}
    setBusy(true);setNotice('正在确认保存结果')
    try{
      await executeRecoverableCommand(`sale-quantity:${productId}`,body,crypto.randomUUID(),key=>api.postEndpoint<Quantity>(endpoint,body,{idempotencyKey:key}))
      await read();await onSaved();setNotice('可售数量已保存并重新读取')
    }catch(error){setNotice(`${error instanceof Error?error.message:'结果暂未确认'}。可重试原保存，或重新读取当前数量核对`)}finally{setBusy(false)}
  }
  return <section className="catalog-wide" aria-label="可售数量">
    <label>剩余可售份数<input type="text" inputMode="numeric" placeholder="留空沿用原管理方式" value={value} disabled={busy||!current} onChange={event=>setValue(event.target.value)}/></label>
    <small>留空不增加数量限制；0表示售罄。填写后按剩余份数管理，补货时手动修改，不每天重置。原库存、销售状态和兴趣卡条件仍生效。</small>
    {current&&<p>当前：{current.remaining===null?'沿用原管理方式':`${current.remaining}份可售`}；待付款等已预留：{current.reserved}份（不含在可售份数内）。挂账已提交或已付款的订单，撤单退款不自动补回，请核对实物后补充。</p>}
    <button type="button" disabled={busy||!current} onClick={()=>void save()}>保存可售数量</button>
    <button type="button" disabled={busy} onClick={()=>{setBusy(true);void read().then(()=>setNotice('已读取当前数量')).catch(error=>setNotice(error instanceof Error?error.message:'读取失败')).finally(()=>setBusy(false))}}>重新读取</button>
    {notice&&<p role="status">{notice}</p>}
  </section>
}
