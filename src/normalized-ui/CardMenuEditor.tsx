import {ServiceWindowFields} from './ServiceWindowFields'
import type {ProductServiceWindow} from '../shared/product-service-window'
import {useEffect,useState} from 'react'
import type {NormalizedApiClient,StaffAuthView} from '../normalized-api'
import {executeRecoverableCommand} from './recoverable-command'
import {createIdempotencyKey} from './cashier-mutation'
interface MenuItem{service_window?:ProductServiceWindow|null;product_id:string;name:string;exclusive:boolean;active:boolean;sort_order:number;exclusive_price_minor:string|null}
export function CardMenuEditor({api,auth,projectId}:{api:NormalizedApiClient;auth:StaffAuthView;projectId:string}){
 const [items,setItems]=useState<MenuItem[]>([]),[products,setProducts]=useState<{id:string;name:string}[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
 const [window,setWindow]=useState<ProductServiceWindow|null>(null)
 const [form,setForm]=useState({productId:'',exclusive:true,active:true,sortOrder:0}),[price,setPrice]=useState('')
 useEffect(()=>{let live=true;setBusy(true);setMessage('');setItems([])
  void (async()=>{
   const menu=await api.getEndpoint<{data:MenuItem[]}>(`/api/staff/member-cards/projects/${projectId}/menu`)
   const options:{id:string;name:string}[]=[];let offset:number|null=0
   do{const result:{data:{items:{id:string;name:string}[];nextOffset:number|null}}=await api.getEndpoint(`/api/staff/member-cards/product-options?offset=${offset}`);options.push(...result.data.items);offset=result.data.nextOffset}while(offset!==null&&live)
   if(live){setItems(menu.data);setProducts(options)}
  })().catch(error=>{if(live)setMessage(error instanceof Error?error.message:'菜单读取失败，可重新打开')}).finally(()=>{if(live)setBusy(false)})
  return()=>{live=false}
 },[api,projectId])
 async function command(action:'save'|'remove',productId=form.productId){
  if(busy)return
  setBusy(true);setMessage('')
  try{
   if(action==='save'&&price&&!/^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,2})?$/.test(price))throw new Error('持卡价须为最多两位小数的金额')
   const url=`/api/staff/member-cards/projects/${projectId}/menu${action==='remove'?'/remove':''}`
   const body=action==='remove'?{productId}:{...form,serviceWindow:window,exclusivePriceMinor:price?Math.round(Number(price)*100):null}
   await executeRecoverableCommand(`${auth.employee.id}:${url}`,body,createIdempotencyKey('card-menu'),key=>api.postEndpoint(url,body,{idempotencyKey:key}))
   setItems((await api.getEndpoint<{data:MenuItem[]}>(`/api/staff/member-cards/projects/${projectId}/menu`)).data)
   setMessage(action==='remove'?'已移除关联，历史订单保留':'指定商品已保存')
  }catch(error){setMessage(error instanceof Error?error.message:'结果未确认，请重新打开核对')}
  finally{setBusy(false)}
 }
 return <div className="member-card-menu"><h4>指定商品与持卡价</h4><p>未配置的权益不作承诺。公共商品可配置持卡价；仅持卡可见须选非公共商品。已配置赠券仍按原活动任务和次数发放。</p>
  {message&&<p role="status">{message}</p>}
  {items.map(item=><p key={item.product_id}>{item.name} · {item.active?'启用':'停用'}<button disabled={busy} onClick={()=>{setForm({productId:item.product_id,exclusive:item.exclusive,active:item.active,sortOrder:item.sort_order});setWindow(item.service_window??null);setPrice(item.exclusive_price_minor===null?'':(Number(item.exclusive_price_minor)/100).toFixed(2))}}>编辑</button><button disabled={busy} onClick={()=>void command('remove',item.product_id)}>移除此项</button></p>)}
  {!busy&&!items.length&&<p>尚未关联指定商品，不承诺免费或折扣。</p>}
  <fieldset disabled={busy}><label>指定商品<select value={form.productId} onChange={e=>{const item=items.find(i=>i.product_id===e.target.value);setForm({productId:e.target.value,exclusive:item?.exclusive??true,active:item?.active??true,sortOrder:item?.sort_order??0});setPrice(item?.exclusive_price_minor==null?'':(Number(item.exclusive_price_minor)/100).toFixed(2));setWindow(item?.service_window??null)}}><option value="">请选择</option>{products.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
   <label>持卡价（元，留空沿用标准价）<input inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)}/></label>
   <label><input type="checkbox" checked={form.exclusive} onChange={e=>setForm({...form,exclusive:e.target.checked})}/>仅持卡可见</label>
   <label><input type="checkbox" checked={form.active} onChange={e=>setForm({...form,active:e.target.checked})}/>启用关联</label>
   <ServiceWindowFields value={window} onChange={setWindow} disabled={busy}/><p>未设置专属时段时沿用商品时段；仅本卡入口不同才设置。</p>
   <button disabled={!form.productId} onClick={()=>void command('save')}>保存指定商品</button>
  </fieldset>
 </div>
}
