import {useEffect,useRef,useState,type FormEvent} from 'react'
import {NormalizedApiError,type NormalizedApiClient,type StaffAuthView} from '../normalized-api'
import type {MemberReportView,MemberReportDetail,MemberReportRow} from '../shared/member-report'
import './member-report.css'
const money=(v:number)=>new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY'}).format(v/100)
const time=(v:string|null)=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'暂无'
const states:Record<string,string>={active:'有效',suspended:'已暂停',closed:'已关闭',withdrawn:'已退出',revoked:'已撤销',outside_validity:'不在有效期'}
const initial={search:'',joinedFrom:'',joinedTo:'',interest:'all',card:''}
export function MemberReportPanel({api,auth}:{api:NormalizedApiClient;auth:StaffAuthView}){
 const [filters,setFilters]=useState(initial),[applied,setApplied]=useState(initial),[view,setView]=useState<MemberReportView|null>(null)
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[selected,setSelected]=useState<MemberReportRow|null>(null),[detail,setDetail]=useState<MemberReportDetail|null>(null),[detailBusy,setDetailBusy]=useState(false),[detailError,setDetailError]=useState('')
 const generation=useRef(0),detailGeneration=useRef(0),allowed=auth.permissions.includes('member.report.view')
 async function load(next=applied,page=1){
  const token=++generation.current;++detailGeneration.current;setSelected(null);setDetail(null);setView(null);setBusy(true);setError('')
  try{const body=Object.fromEntries(Object.entries({...next,page}).filter(([,value])=>value!==''));const r=await api.postEndpoint<MemberReportView>('/api/staff/member-report',body);if(token===generation.current){setView(r);setApplied(next)}}catch(e){if(token===generation.current)setError(e instanceof NormalizedApiError&&e.status!==null&&e.status>=500?'会员报表读取失败，请重试':e instanceof Error?e.message:'会员报表读取失败')}finally{if(token===generation.current)setBusy(false)}
 }
 async function open(row:MemberReportRow,page=1){
  const token=++detailGeneration.current;setSelected(row);setDetail(null);setDetailBusy(true);setDetailError('')
  try{const r=await api.getEndpoint<{data:MemberReportDetail}>(`/api/staff/member-report/${encodeURIComponent(row.customerId)}/consumption?page=${page}`);if(token===detailGeneration.current)setDetail(r.data)}catch(e){if(token===detailGeneration.current)setDetailError(e instanceof Error?e.message:'消费明细读取失败')}finally{if(token===detailGeneration.current)setDetailBusy(false)}
 }
 useEffect(()=>{setView(null);setSelected(null);setDetail(null);if(allowed)void load(initial);return()=>{++generation.current;++detailGeneration.current}},[api,auth.employee.id,allowed]) // eslint-disable-line react-hooks/exhaustive-deps
 function submit(e:FormEvent){e.preventDefault();void load(filters)}
 if(!allowed)return <p>当前账号没有会员查询报表权限。</p>
 return <section className="member-report"><h3>会员查询报表</h3>
 <details><summary>统计口径与数据范围</summary><p>会员按合并后的账号去重；入会日期按门店营业日筛选。消费为会员名下订单及活动报名的累计实收减成功退款，同桌多次加单计一次，活动每次报名计一次；全额退款不计消费次数。未关联会员的员工代下单、零现金兑换及测试记录不计入。</p></details>
 <form onSubmit={submit}><label>会员号、姓名或完整手机号<input value={filters.search} onChange={e=>setFilters({...filters,search:e.target.value})} maxLength={64}/></label>
 <label>入会开始营业日<input type="date" value={filters.joinedFrom} onChange={e=>setFilters({...filters,joinedFrom:e.target.value})}/></label><label>入会结束营业日<input type="date" value={filters.joinedTo} onChange={e=>setFilters({...filters,joinedTo:e.target.value})}/></label>
 <label>有效兴趣卡<select value={filters.interest} onChange={e=>setFilters({...filters,interest:e.target.value})}><option value="all">全部</option><option value="yes">有</option><option value="no">无</option></select></label><label>卡项目名称<input value={filters.card} onChange={e=>setFilters({...filters,card:e.target.value})} maxLength={60}/></label><button disabled={busy}>查询</button><button type="button" disabled={busy} onClick={()=>{setFilters(initial);void load(initial)}}>重置</button></form>
 {busy&&<p role="status">正在读取会员报表…</p>}{error&&<p role="alert">{error}<button onClick={()=>void load(filters)}>重试</button></p>}
 {view&&<><p><strong>会员总数 {view.totalMembers} 人 · 符合条件 {view.matchedMembers} 人</strong> · 更新于 {time(view.generatedAt)} · 每日 {view.cutoff} 切日</p><p>性别尚未采集，显示“未填写”；手机号只显示当前有效的已核验号码。</p>
 <div className="member-report-scroll"><table><thead><tr>{['会员','入会时间','手机号','性别','兴趣卡与类别','累计消费净额','成功收款 / 退款','消费次数 / 有效订单数','最近付款时间','明细'].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{view.items.map(row=><tr key={row.customerId}><td data-label="会员"><div>{row.name||'未填写姓名'}<br/>{row.memberNo}<br/>{states[row.status]||row.status}</div></td><td data-label="入会时间"><div>{time(row.joinedAt)}</div></td><td data-label="手机号"><div>{row.phone||(row.phoneStatus==='unavailable'?'暂无法读取':'未登记有效手机号')}</div></td><td data-label="性别"><div>{row.gender||'未填写'}</div></td><td data-label="兴趣卡与类别"><div>{row.hasInterestCard?'有有效兴趣卡':'无有效兴趣卡'}{row.cards.map((c,i)=><div key={i}>{c.name} · {c.kind==='interest'?'兴趣卡':'联名卡'} · {states[c.status]||c.status}{c.validUntil&&` · 至${time(c.validUntil)}`}</div>)}</div></td><td data-label="累计消费净额"><div>{money(row.netMinor)}</div></td><td data-label="成功收款 / 退款"><div>{money(row.paidMinor)} / {money(row.refundMinor)}</div></td><td data-label="消费次数 / 有效订单数"><div>{row.consumptionCount} / {row.orderCount}</div></td><td data-label="最近付款时间"><div>{time(row.lastPaidAt)}</div></td><td data-label="消费明细"><div><button onClick={()=>void open(row)}>查看消费</button></div></td></tr>)}</tbody></table></div>
 {!view.items.length&&<p>没有符合条件的会员。</p>}<nav aria-label="会员分页"><button disabled={busy||view.page===1} onClick={()=>void load(applied,view.page-1)}>上一页</button><span>第 {view.page} 页</span><button disabled={busy||view.page*view.pageSize>=view.matchedMembers} onClick={()=>void load(applied,view.page+1)}>下一页</button></nav></>}
 {selected&&<section aria-label="会员消费明细"><h4>{selected.name||selected.memberNo} · 消费明细</h4><button onClick={()=>{++detailGeneration.current;setSelected(null);setDetail(null)}}>关闭明细</button>{detailBusy&&<p role="status">正在读取消费…</p>}{detailError&&<p role="alert">{detailError}<button onClick={()=>void open(selected)}>重试明细</button></p>}{detail&&<><p>共 {detail.total} 笔。点单按订单营业日，活动按首次付款营业日归属；退款按截至查询时的成功记录回算。</p>{detail.items.map(row=><article key={row.reference}><strong>{row.kind==='order'?'点单':'活动报名'} · {row.businessDate}</strong><p>实收 {money(row.paidMinor)} · 退款 {money(row.refundMinor)} · 净额 {money(row.netMinor)}</p><p>首次付款 {time(row.firstPaidAt)} · 最近付款 {time(row.lastPaidAt)} · 最近退款 {time(row.lastRefundAt)}</p><small>{row.reference}</small></article>)}{!detail.items.length&&<p>暂无已关联的成功收款记录。</p>}<nav aria-label="消费分页"><button disabled={detailBusy||detail.page===1} onClick={()=>void open(selected,detail.page-1)}>上一页</button><span>第 {detail.page} 页</span><button disabled={detailBusy||detail.page*detail.pageSize>=detail.total} onClick={()=>void open(selected,detail.page+1)}>下一页</button></nav></>}</section>}
 </section>
}
