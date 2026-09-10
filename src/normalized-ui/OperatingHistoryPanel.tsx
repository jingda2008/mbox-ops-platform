import {useRef,useState} from 'react'
import type {NormalizedApiClient} from '../normalized-api'
import type {OperatingHistory} from '../shared/operating-history'
import './operating-history-panel.css'

export function OperatingHistoryPanel({api,businessDate}:{api:NormalizedApiClient;businessDate:string}) {
  const [date,setDate]=useState(businessDate),[table,setTable]=useState(''),[employee,setEmployee]=useState('')
  const [endDate,setEndDate]=useState(businessDate)
  const [data,setData]=useState<OperatingHistory|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const generation=useRef(0)
  async function read(page=0) {
    const version=++generation.current
    setBusy(true);setError('')
    try {
      const params=new URLSearchParams({businessDate:date,endDate,table,employee,page:String(page)})
      const response=await api.getEndpoint<{data:OperatingHistory}>(`/api/operations/history?${params}`)
      if(version===generation.current)setData(response.data)
    } catch(reason) {if(version===generation.current)setError(reason instanceof Error?reason.message:'账务历史暂未读取成功')}
    finally{if(version===generation.current)setBusy(false)}
  }
  function reset() {generation.current++;setData(null);setBusy(false);setError('')}
  async function exportAll() {
    const version=++generation.current
    setBusy(true);setError('')
    try {
      const params=new URLSearchParams({businessDate:date,endDate,table,employee,exportAll:'true'})
      const response=await api.getEndpoint<{data:OperatingHistory}>(`/api/operations/history?${params}`)
      if(version===generation.current)download(response.data,true)
    }catch(reason){if(version===generation.current)setError(reason instanceof Error?reason.message:'导出未完成，请重试')}
    finally{if(version===generation.current)setBusy(false)}
  }
  function download(snapshot:OperatingHistory|null=data,all=false) {
    if(!snapshot)return
    const rows=[['营业日','订单','桌台','下单员工','下单时间','菜品','数量','单价','优惠后小计','履约状态','商品备注','送达员工','送达时间'],
      ...snapshot.orders.flatMap(order=>order.items.map(item=>[order.businessDate??snapshot.businessDate,order.publicId,order.tableCode,order.employeeName??'顾客自助',
        time(order.submittedAt),item.name,String(item.quantity),money(item.unitPriceMinor),money(item.totalMinor),status(item.status),item.note??'',item.deliveredBy??'',item.deliveredAt?time(item.deliveredAt):'']))]
    const csv='\uFEFF'+rows.map(row=>row.map(cell=>`"${(/^[=+@\-\t\r]/.test(cell)?"'"+cell:cell).replaceAll('"','""')}"`).join(',')).join('\r\n')
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}))
    const link=document.createElement('a');link.href=url;link.download=`营业明细-${snapshot.businessDate}-${all?'全部筛选结果':`第${snapshot.page+1}页`}.csv`;link.click()
    setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  return <details className="operating-history-panel" aria-label="营业日账务与历史订单"><summary>营业日账务与历史订单</summary>
    <form onSubmit={event=>{event.preventDefault();void read()}}>
      <label>开始营业日<input type="date" required value={date} max={endDate} onChange={event=>{reset();setDate(event.target.value)}} /></label>
      <label>结束营业日<input type="date" required value={endDate} min={date} onChange={event=>{reset();setEndDate(event.target.value)}} /></label>
      <label>桌号<input value={table} maxLength={80} onChange={event=>{reset();setTable(event.target.value)}} /></label>
      <label>下单员工<input value={employee} maxLength={80} placeholder="留空含顾客自助" onChange={event=>{reset();setEmployee(event.target.value)}} /></label>
      <button type="submit" disabled={busy}>{busy?'读取中':'查看账务与历史'}</button>
    </form>
    {error&&<p role="alert">{error}；可重新查询，原账务不会被修改。</p>}
    {data&&<>
      <h4>{data.businessDate}{data.endDate&&data.endDate!==data.businessDate?` 至 ${data.endDate}`:''} 全店已入账资金</h4>
      <p>按流水记账营业日统计，包含活动收退款；不受桌号和员工筛选影响。不将未确认支付算作收入，也不将零元赠送算作收款。</p>
      {data.receipts.length===0?<p>当日没有已入账收退款流水；不代表没有订单或渠道待核对款项。</p>:data.receipts.map(row=><article key={row.provider}>
        <strong>{provider(row.provider)}</strong><span>收款 ¥{money(row.receivedMinor)} · 退款 ¥{money(row.refundedMinor)} · 净收 ¥{money(row.netMinor)}</span>
      </article>)}
      <h4>历史订单与送达状态</h4><p>每页50单；送达员工与时间取自正式送达操作记录，缺失凭据不推测。此处为查询快照，不是已扎账确认。</p>
      {data.orders.length===0&&<p>没有符合筛选条件的订单。</p>}
      {data.orders.map(order=><details key={order.id}><summary>{order.tableCode} · ¥{money(order.totalMinor)} · {time(order.submittedAt)}</summary>
        <p>{order.publicId} · {order.employeeName??'顾客自助'} · {status(order.status)}</p>
        {order.items.map(item=><article key={item.id}><strong>{item.name} ×{item.quantity}</strong><span>单价 ¥{money(item.unitPriceMinor)} · 小计 ¥{money(item.totalMinor)} · {status(item.status)}</span>{item.note&&<p>商品备注：{item.note}</p>}{item.status==='delivered'&&<p>{item.deliveredAt?`送达：${item.deliveredBy??'员工信息未留存'} · ${time(item.deliveredAt)}`:'已送达，历史送达凭据未留存'}</p>}</article>)}
      </details>)}
      <nav><button disabled={busy||data.page===0} onClick={()=>void read(data.page-1)}>上一页</button><span>第{data.page+1}页</span><button disabled={busy||!data.hasMore} onClick={()=>void read(data.page+1)}>下一页</button><button disabled={busy||data.orders.length===0} onClick={()=>download()}>导出本页明细</button><button disabled={busy||data.orders.length===0} onClick={()=>void exportAll()}>导出全部筛选结果</button></nav>
      <p>全部导出使用同一账务快照，最多5000单；超过范围会明确提示缩小筛选，不会静默截断。</p>
    </>}
  </details>
}
function money(value:number){return(value/100).toFixed(2)}
function time(value:string){return new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}
function provider(value:string){return({cash:'现金',postar:'星驿',wechat:'微信',physical_pos:'实体POS',external_manual:'其他线下',simulation:'模拟'} as Record<string,string>)[value]??value}
function status(value:string){return({draft:'草稿',submitted:'已下单',confirmed:'已确认',fulfilling:'履约中',completed:'已完成',cancelled:'已取消',accepted:'已接单',preparing:'制作中',ready:'待送达',delivered:'已送达'} as Record<string,string>)[value]??value}
