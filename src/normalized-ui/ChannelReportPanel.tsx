import {useEffect,useRef,useState} from 'react'
import type {NormalizedApiClient} from '../normalized-api'
type Row=Record<string,unknown>
const money=(v:unknown)=>v==null?'待核算':`¥${(Number(v)/100).toFixed(2)}`
export function ChannelReportPanel({api,sessionId}:{api:NormalizedApiClient;sessionId:string}){
 const [rows,setRows]=useState<Row[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),epoch=useRef(0)
 useEffect(()=>{epoch.current++;setBusy(false);setRows([]);setError('');return()=>{epoch.current++}},[sessionId])
 async function load(csv=false){if(busy)return;const n=epoch.current;setBusy(true);setError('');try{
  if(csv){const r=await api.getEndpoint<{data:{csv:string}}>('/api/staff/channel/report?format=csv-data');if(n!==epoch.current)return;const url=URL.createObjectURL(new Blob([r.data.csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='渠道经营核对.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  else{const r=await api.getEndpoint<{data:Row[]}>('/api/staff/channel/report');if(n===epoch.current)setRows(r.data)}
 }catch(e){if(n===epoch.current)setError(e instanceof Error?e.message:String(e))}finally{if(n===epoch.current)setBusy(false)}}
 return <details><summary>推广效果、成本与交班核对</summary><p>当前显示及导出最近 500 个批次。A、B 按领取入口分别计数，到店按客组去重，不直接比较两入口转化率。贡献＝已履约净收款－商品成本－佣金；优惠和退款已在净收款内，不再重复扣减。原预约和有历史消费的客组单列，可能重叠；无历史记录不等于新客。未扣税费、人工、租金等，不等于净利润；缺成本或待同步时显示待核算。</p><button type="button" disabled={busy} onClick={()=>void load()}>读取经营核对表</button><button type="button" disabled={busy} onClick={()=>void load(true)}>导出当前权限内的核对表</button>{error&&<p role="alert">{error}</p>}
 <table><thead><tr><th>批次／推荐人</th><th>A／B领取</th><th>确认到店／原预约／已知老客</th><th>净收款</th><th>成本</th><th>佣金</th><th>贡献估算</th><th>核对状态</th></tr></thead><tbody>{rows.map(r=><tr key={String(r.id)}><td>{String(r.offerCode)}／{String(r.promoterName)}</td><td>{String(r.staffClaims)}／{String(r.selfClaims)}</td><td>{String(r.arrivedVisits)}／{String(r.priorReservationVisits)}／{String(r.knownReturningVisits)}组</td><td>{money(r.netReceiptsMinor)}</td><td>{money(r.costMinor)}，缺成本 {String(r.missingCostItems)} 项</td><td>{money(r.commissionMinor)}</td><td>{money(r.contributionMinor)}</td><td>{r.pending?'待履约、冻结或同步未完成':'已核对'} · {String(r.checkedAt??'尚未核对')}</td></tr>)}</tbody></table></details>
}
