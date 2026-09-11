import {OrderBillPrintButton} from './OrderBillPrintButton'
import {useEffect,useState} from 'react'
import type {NormalizedApiClient} from '../normalized-api'
import type {OperatingHistory} from '../shared/operating-history'

export function CashierDaySummary({api,businessDate,revision,printEmployeeId}:{api:NormalizedApiClient;businessDate:string;revision:unknown;printEmployeeId?:string}) {
 const [data,setData]=useState<OperatingHistory|null>(null),[error,setError]=useState('')
 useEffect(()=>{let current=true
  setData(previous=>previous?.businessDate===businessDate?previous:null)
  void api.getEndpoint<{data:OperatingHistory}>(`/api/operations/history?businessDate=${encodeURIComponent(businessDate)}`).then(value=>{if(current){setData(value.data);setError('')}}).catch(reason=>{if(current)setError(reason instanceof Error?reason.message:'营业金额暂未刷新')})
  return()=>{current=false}
 },[api,businessDate,revision])
 if(data?.financialSummaryVisible===false)return null
 const total=data?.receipts.reduce((sum,row)=>({received:sum.received+row.receivedMinor,refunded:sum.refunded+row.refundedMinor,net:sum.net+row.netMinor}),{received:0,refunded:0,net:0})
 const money=(value:number|undefined)=>value===undefined?'—':`¥${(value/100).toFixed(2)}`
 return <section className="cashier-day-summary" aria-label="本营业日金额"><header><strong>本营业日 {businessDate}</strong><small>{data?`更新 ${new Date(data.generatedAt).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}`:'正在读取金额'}</small></header>
  <div className="cashier-day-net"><span>净收</span><strong>{money(total?.net)}</strong></div>
  <div className="cashier-day-metrics"><span>收款 <b>{money(total?.received)}</b></span><span>退款 <b>{money(total?.refunded)}</b></span><span>待收 <b>{money(data?.summary?Number(data.summary.outstandingMinor):undefined)}</b></span></div>
  <details><summary>销售与统计口径</summary><p>销售额 {money(data?.summary?Number(data.summary.orderAmountMinor):undefined)}；销售按订单营业日，收退款按资金入账营业日。旧支付结果未知不计入收款。</p></details>
  {printEmployeeId&&<OrderBillPrintButton key={businessDate} api={api} orderId="" employeeId={printEmployeeId} businessDate={businessDate}/>}
  {error&&<p role="alert">{error}；显示的是上次读取结果。</p>}
 </section>
}
