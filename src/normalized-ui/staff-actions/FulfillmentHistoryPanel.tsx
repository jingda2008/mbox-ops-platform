import {useEffect,useState} from 'react'
import type {OperatingHistory} from '../../shared/operating-history'
import type {StaffActionsApiPort} from './staff-actions-api'

export function FulfillmentHistoryPanel({api,kind}:{api:StaffActionsApiPort;kind:'prepared'|'delivered'}) {
 const [date,setDate]=useState(''),[table,setTable]=useState(''),[page,setPage]=useState(0)
 const [data,setData]=useState<OperatingHistory|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0)
 useEffect(()=>{let current=true;setBusy(true);setError('')
  if(!api.loadFulfillmentHistory){setError('历史查询入口暂不可用');setBusy(false);return}
  void api.loadFulfillmentHistory({kind,date,table,page}).then(value=>{if(current)setData(value)}).catch(reason=>{if(current)setError(reason instanceof Error?reason.message:'历史暂未读取成功')}).finally(()=>{if(current)setBusy(false)})
  return()=>{current=false}
 },[api,kind,date,table,page,revision])
 return <section className="staff-fulfillment-history" aria-label={kind==='prepared'?'我的历史制作':'我的历史送达'}>
  <form onSubmit={event=>{event.preventDefault();setRevision(value=>value+1)}}><label>营业日<input type="date" value={date||data?.businessDate||''} onChange={event=>{setDate(event.target.value);setPage(0)}}/></label><label>桌号<input value={table} placeholder="全部桌台" onChange={event=>{setTable(event.target.value);setPage(0)}}/></label><button disabled={busy}>刷新</button></form>
  {error&&<p role="alert">{error}</p>}{busy&&<p role="status">正在读取历史</p>}
  {data?.orders.map(order=><article className="staff-action-card" key={order.id}><header><strong>{order.tableCode}</strong><small>{order.publicId}</small></header>{order.items.map(item=><div key={item.id}><strong>{item.name} ×{item.quantity}</strong>{item.note&&<p>{item.note}</p>}<p>{kind==='prepared'?item.preparedBy:item.deliveredBy} · {((kind==='prepared'?item.preparedAt:item.deliveredAt) ? new Date((kind==='prepared'?item.preparedAt:item.deliveredAt)!).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '完成时间未留存')}</p></div>)}</article>)}
  {!busy&&data?.orders.length===0&&<p>该营业日没有本人{kind==='prepared'?'制作完成':'确认送达'}记录。</p>}
  <nav><button disabled={busy||page===0} onClick={()=>setPage(value=>value-1)}>上一页</button><span>第{page+1}页</span><button disabled={busy||!data?.hasMore} onClick={()=>setPage(value=>value+1)}>下一页</button></nav>
 </section>
}
