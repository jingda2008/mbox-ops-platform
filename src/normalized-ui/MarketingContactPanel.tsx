import {useEffect,useRef,useState} from 'react'
import type {NormalizedApiClient,StaffAuthView} from '../normalized-api'
import {useConfirmationDialog} from './ConfirmationDialog'
import {executeRecoverableCommand} from './recoverable-command'
import {createIdempotencyKey} from './cashier-mutation'
import {NumberInputWithUnit} from './NumberInputWithUnit'
import './marketing-contact-panel.css'
type Channel='wechat'|'sms'|'phone'
interface Notice{id:string;code:string;version:number;status:string;created_by_employee_id:string;decisions:Array<{action:string;employee_id:string}>;rule:{operatorName:string;operatorContact:string;summary:string;withdrawalInstructions:string;dataCategories:string[];channels:Channel[];purposes:string[];validFrom:string;validUntil:string;consentDays:number;contactStartMinute:number;contactEndMinute:number;weekdays:number[];maximumPerDay:number;maximumPerMonth:number}}
interface Job{id:string;campaign_key:string;customer_ref:string;status:string;channel:Channel;blocked_reason:string|null}
interface Customer{id:string;name:string;code:string}
interface ConsentHistory{id:string;sequence:string;action:string;channel:Channel|null;purpose:string|null;createdAt:string;validUntil:string|null;source:string;actorName:string|null;reason:string|null;notice:{code:string;version:number;operatorName:string;summary:string;withdrawalInstructions:string;dataCategories:string[]}|null}
type Page<T>={items:T[];nextCursor:string|null}
const channelNames:Record<Channel,string>={wechat:'微信',sms:'短信',phone:'电话'}
const statusNames:Record<string,string>={draft:'待审核',approved:'待发布',published:'已发布',stopped:'已停止',queued:'等待核验',blocked:'暂不能发送',dispatching:'正在交给渠道',submitted:'渠道已受理，未确认送达',sent:'渠道确认送达',unknown:'结果未知，禁止自动重发',cancelled:'已取消',failed:'渠道确认失败'}
const reasonNames:Record<string,string>={channel_not_configured:'渠道尚未开通',recipient_not_verified:'客户联系方式尚未核实',channel_authority_missing:'缺少渠道原生许可',outside_contact_window:'当前不在允许联系时段',frequency_limit:'已达到联系频次上限',previous_delivery_unknown:'此前联系尚无明确结果',verification_unavailable:'核实服务暂不可用',consent_changed:'本人联系许可已变化',notice_stopped:'告知规则已停止',task_expired:'任务期限已结束',sender_permission_revoked:'发起员工权限已撤回',not_consented:'本人未同意',consent_changed_since_queue:'排队后本人许可已变化',consent_expired_or_scope_changed:'本人许可过期或范围已变化',staff_cancelled:'员工已取消',notice_unavailable:'告知规则当前不可用'}
const dateText=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})
const timeText=(value:number)=>`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`
export function MarketingContactPanel({api,auth}:{api:NormalizedApiClient;auth:StaffAuthView}){
  const can=(permission:string)=>auth.permissions.includes(permission)
  const [notices,setNotices]=useState<Notice[]>([]),[jobs,setJobs]=useState<Job[]>([]),[noticeCursor,setNoticeCursor]=useState<string|null>(null),[jobCursor,setJobCursor]=useState<string|null>(null)
  const [reason,setReason]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
  const [form,setForm]=useState({code:'',expectedVersion:'0',operatorName:'',operatorContact:'',summary:'',withdrawalInstructions:'',dataCategories:'',validFrom:'',validUntil:'',consentDays:'',start:'',end:'',maximumPerDay:'',maximumPerMonth:''})
  const [channels,setChannels]=useState<Channel[]>([]),[weekdays,setWeekdays]=useState<number[]>([]),[joint,setJoint]=useState(false)
  const [search,setSearch]=useState(''),[customers,setCustomers]=useState<Customer[]>([]),[customer,setCustomer]=useState<Customer|null>(null),[customerCursor,setCustomerCursor]=useState<string|null>(null)
  const [lookupPurpose,setLookupPurpose]=useState<'send'|'refusal'|'audit'>(can('marketing.send')?'send':can('marketing.refusal.record')?'refusal':'audit')
  const [history,setHistory]=useState<ConsentHistory[]>([]),[historyCursor,setHistoryCursor]=useState<string|null>(null),[historyLoaded,setHistoryLoaded]=useState(false)
  useEffect(()=>{setHistory([]);setHistoryCursor(null);setHistoryLoaded(false)},[customer?.id,lookupPurpose])
  const [task,setTask]=useState({noticeId:'',channel:'sms',purpose:'own_activities',campaignKey:'',content:'',expiresAt:''})
  const mounted=useRef(true),operation=useRef(false),generation=useRef(0),{confirmAction}=useConfirmationDialog()
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++}},[])
  if(!auth.permissions.some(p=>p.startsWith('marketing.')))return null
  const root='/api/staff/marketing'
  function change(key:keyof typeof form,value:string){setForm(previous=>({...previous,[key]:value}))}
  async function read(kind:'notices'|'jobs',more=false){
    const cursor=kind==='notices'?noticeCursor:jobCursor,current=generation.current
    const response=await api.getEndpoint<{data:Page<Notice>|Page<Job>}>(`${root}/${kind}${more&&cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`)
    if(!mounted.current||current!==generation.current)return
    if(kind==='notices'){const data=response.data as Page<Notice>;setNotices(previous=>more?[...new Map([...previous,...data.items].map(r=>[r.id,r])).values()]:data.items);setNoticeCursor(data.nextCursor)}
    else{const data=response.data as Page<Job>;setJobs(previous=>more?[...new Map([...previous,...data.items].map(r=>[r.id,r])).values()]:data.items);setJobCursor(data.nextCursor)}
  }
  async function operate(action:()=>Promise<void>){
    if(operation.current)return;operation.current=true;setBusy(true);setMessage('')
    try{await action()}catch(error){if(mounted.current)setMessage(error instanceof Error?error.message:'暂未完成，请刷新核对')}
    finally{operation.current=false;if(mounted.current)setBusy(false)}
  }
  async function command(path:string,data:unknown,description:string){
    await operate(async()=>{
      if(reason.trim().length<2)throw Error('请填写本次操作原因')
      if(!await confirmAction({title:'确认营销管理操作',description,confirmLabel:'确认记录'})||!mounted.current)return
      await executeRecoverableCommand(`${auth.employee.id}:${path}`,data,createIdempotencyKey('marketing'),key=>api.postEndpoint(`${root}${path}`,data,{idempotencyKey:key}))
      if(!mounted.current)return
      setMessage('操作已记录；这不代表客户已同意、已收到消息或已关注。')
      try{if(can('marketing.notice.view'))await read('notices');if(can('marketing.send'))await read('jobs')}
      catch{if(mounted.current)setMessage('操作已记录，但列表刷新失败。请刷新核对，勿重复创建不同任务。')}
    })
  }
  const int=(value:string)=>{if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw Error('次数、天数与版本须填写整数');return Number(value)}
  const instant=(value:string)=>{if(!value)throw Error('请选择北京时间期限');return `${value.length===16?`${value}:00`:value}+08:00`}
  async function save(){
    try{
      const minute=(value:string)=>{if(!/^\d{2}:\d{2}$/.test(value))throw Error('请选择允许联系时段');const [h,m]=value.split(':').map(Number);return h!*60+m!}
      const rule={operatorName:form.operatorName,operatorContact:form.operatorContact,summary:form.summary,withdrawalInstructions:form.withdrawalInstructions,dataCategories:form.dataCategories.split('、').map(s=>s.trim()).filter(Boolean),channels,purposes:['own_activities',...(joint?['mbox_joint_activities']:[])],validFrom:instant(form.validFrom),validUntil:instant(form.validUntil),consentDays:int(form.consentDays),contactStartMinute:minute(form.start),contactEndMinute:minute(form.end),weekdays,maximumPerDay:int(form.maximumPerDay),maximumPerMonth:int(form.maximumPerMonth),sharingMode:'no_partner_list'}
      await command('/notices',{code:form.code,expectedVersion:int(form.expectedVersion),rule,reason},'保存明确范围的告知草稿。仍需不同授权人员审核和发布，客户本人主动选择才产生营销许可。')
    }catch(error){setMessage(error instanceof Error?error.message:'请核对告知内容')}
  }
  async function lookup(more=false){await operate(async()=>{
    if(search.trim().length<2)throw Error('请输入至少2字的会员号或客户编号')
    const query=new URLSearchParams({purpose:lookupPurpose,search,...(more&&customerCursor?{cursor:customerCursor}:{})})
    const response=await api.getEndpoint<{data:Page<Customer>}>(`${root}/customers?${query}`)
    if(mounted.current){setCustomers(previous=>more?[...new Map([...previous,...response.data.items].map(c=>[c.id,c])).values()]:response.data.items);setCustomerCursor(response.data.nextCursor)}
  })}
  async function readHistory(more=false){await operate(async()=>{
    if(!customer||reason.trim().length<2)throw Error('请先选择客户并填写核查原因')
    const result=await api.postEndpoint<Page<ConsentHistory>>(`${root}/consent-history/query`,{customerId:customer.id,reason:reason.trim(),...(more&&historyCursor?{cursor:historyCursor}:{})})
    if(mounted.current){setHistory(previous=>more?[...new Map([...previous,...result.items].map(row=>[row.id,row])).values()]:result.items);setHistoryCursor(result.nextCursor);setHistoryLoaded(true)}
  })}
  return <section className="marketing-panel" aria-label="营销联系管理"><h3>营销联系管理</h3><p>入会、兴趣卡、微信原生订阅与营销联系许可相互独立。新渠道默认关闭，不向合作方导出名单。</p>
    <label>营销操作原因<input disabled={busy} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/></label>
    {message&&<p role="status" className="marketing-message">{message}</p>}
    {can('marketing.notice.edit')&&<details><summary>新增告知版本</summary><fieldset disabled={busy}><div className="marketing-grid">
      <label>规则编号<input value={form.code} maxLength={40} onChange={event=>change('code',event.target.value.toUpperCase())}/></label><label>已知最新版本<NumberInputWithUnit unit="版" value={form.expectedVersion} onChange={event=>change('expectedVersion',event.target.value)}/><small>新规则填0；改版请先读取，不覆盖旧版同意。</small></label>
      <label>实际经营主体<input value={form.operatorName} maxLength={200} onChange={event=>change('operatorName',event.target.value)}/></label><label>主体联系与客服<input value={form.operatorContact} maxLength={300} onChange={event=>change('operatorContact',event.target.value)}/></label>
      <label>营销用途与范围<textarea value={form.summary} maxLength={3000} onChange={event=>change('summary',event.target.value)}/></label><label>所用资料类型<textarea placeholder="按实际必要范围填写，用顿号分隔" value={form.dataCategories} onChange={event=>change('dataCategories',event.target.value)}/></label>
      <label>停止联系方法<textarea value={form.withdrawalInstructions} maxLength={1000} onChange={event=>change('withdrawalInstructions',event.target.value)}/></label>
      <label>告知开始（北京时间）<input type="datetime-local" value={form.validFrom} onChange={event=>change('validFrom',event.target.value)}/></label><label>告知截止（北京时间）<input type="datetime-local" value={form.validUntil} onChange={event=>change('validUntil',event.target.value)}/></label>
      {([['consentDays','每次同意最长','天'],['maximumPerDay','每人每日最多','次'],['maximumPerMonth','每人每月最多','次']] as const).map(([key,label,unit])=><label key={key}>{label}<NumberInputWithUnit unit={unit} aria-label={label} value={form[key]} onChange={event=>change(key,event.target.value)}/></label>)}
      <label>允许联系开始<input type="time" value={form.start} onChange={event=>change('start',event.target.value)}/></label><label>允许联系结束<input type="time" value={form.end} onChange={event=>change('end',event.target.value)}/></label>
    </div><fieldset><legend>可供本人选择的渠道（不是代客户同意）</legend><div className="marketing-choices">{(Object.keys(channelNames) as Channel[]).map(channel=><label key={channel}><input type="checkbox" checked={channels.includes(channel)} onChange={event=>setChannels(previous=>event.target.checked?[...previous,channel]:previous.filter(c=>c!==channel))}/>{channelNames[channel]}</label>)}</div></fieldset>
    <fieldset><legend>可联系星期（北京时间）</legend><div className="marketing-choices">{[1,2,3,4,5,6,7].map(day=><label key={day}><input type="checkbox" checked={weekdays.includes(day)} onChange={event=>setWeekdays(previous=>event.target.checked?[...previous,day]:previous.filter(d=>d!==day))}/>周{'一二三四五六日'[day-1]}</label>)}</div></fieldset>
    <label className="marketing-check"><input type="checkbox" checked={joint} onChange={event=>setJoint(event.target.checked)}/>另提供“由本店联系的联合活动”独立同意选项，不提供合作方名单</label><button type="button" onClick={()=>void save()}>保存告知草稿</button></fieldset></details>}
    {can('marketing.notice.view')&&<><button disabled={busy} onClick={()=>void operate(()=>read('notices'))}>读取告知版本</button><div className="marketing-records">{notices.map(notice=><article key={notice.id}><h4>{notice.code} · 第{notice.version}版 · {statusNames[notice.status]??notice.status}</h4><strong>{notice.rule.operatorName}</strong><p>{notice.rule.operatorContact}</p><p>{notice.rule.summary}</p><p>资料：{notice.rule.dataCategories.join('、')}；停止方式：{notice.rule.withdrawalInstructions}</p><p>{notice.rule.channels.map(c=>channelNames[c]).join('、')} · {notice.rule.purposes.includes('mbox_joint_activities')?'本店及本店联系的联合活动':'本店活动'} · 不共享名单</p><p>{dateText(notice.rule.validFrom)} 至 {dateText(notice.rule.validUntil)}；每次许可最多{notice.rule.consentDays}天</p><p>周{notice.rule.weekdays.map(d=>'一二三四五六日'[d-1]).join('、')} {timeText(notice.rule.contactStartMinute)}—{timeText(notice.rule.contactEndMinute)}；每日{notice.rule.maximumPerDay}次，每月{notice.rule.maximumPerMonth}次</p>
      <div className="marketing-actions">{notice.status==='draft'&&can('marketing.notice.approve')&&notice.created_by_employee_id!==auth.employee.id&&<button disabled={busy} onClick={()=>void command(`/notices/${notice.id}/decision`,{action:'approve',reason},'已核实实际主体、用途、必要资料与停止方法。审核不等于客户同意。')}>审核通过</button>}{notice.status==='approved'&&can('marketing.notice.publish')&&notice.created_by_employee_id!==auth.employee.id&&!notice.decisions.some(d=>d.action==='approve'&&d.employee_id===auth.employee.id)&&<button disabled={busy} onClick={()=>void command(`/notices/${notice.id}/decision`,{action:'publish',reason},'发布后本人可主动选择，不自动同意或发送任何消息。')}>发布告知</button>}{notice.status==='published'&&can('marketing.notice.publish')&&<button disabled={busy} onClick={()=>void command(`/notices/${notice.id}/decision`,{action:'stop',reason},'停止新同意与尚未发送任务，不修改会员权益或已完成送达事实。')}>停止此版本</button>}</div>
    </article>)}</div>{noticeCursor&&<button disabled={busy} onClick={()=>void operate(()=>read('notices',true))}>更多告知版本</button>}</>}
    {(can('marketing.send')||can('marketing.refusal.record')||can('marketing.consent.audit'))&&<details><summary>客户联系任务与拒绝记录</summary><fieldset disabled={busy}><label>查找用途<select value={lookupPurpose} onChange={event=>{setLookupPurpose(event.target.value as 'send'|'refusal'|'audit');setCustomer(null);setCustomers([]);setCustomerCursor(null)}}>{can('marketing.send')&&<option value="send">建立联系任务</option>}{can('marketing.refusal.record')&&<option value="refusal">记录客户拒绝</option>}{can('marketing.consent.audit')&&<option value="audit">核查本人许可历史</option>}</select></label>
      <label>会员号或客户编号<input value={search} onChange={event=>{setSearch(event.target.value);setCustomers([]);setCustomer(null);setCustomerCursor(null)}}/></label><button type="button" onClick={()=>void lookup()}>查找客户</button><div className="marketing-choices">{customers.map(item=><button key={item.id} type="button" aria-pressed={customer?.id===item.id} onClick={()=>setCustomer(item)}>{item.name}</button>)}</div>{customerCursor&&<button type="button" onClick={()=>void lookup(true)}>更多客户</button>}
      {customer&&<p>当前选择：{customer.name}</p>}
      {lookupPurpose==='audit'&&can('marketing.consent.audit')&&<section aria-label="本人许可历史"><p>仅核查本人同意、撤回及门店代记拒绝。历史同意不代表当前仍有效，也不代表微信原生订阅或消息已送达。每次查询保留核查人及原因，不显示手机号或导出名单。</p><button type="button" disabled={!customer||reason.trim().length<2} onClick={()=>void readHistory()}>读取许可历史</button>{historyLoaded&&history.length===0&&<p>没有相关许可记录。</p>}<div className="marketing-records">{history.map(row=><article key={row.id}><strong>{{granted:'本人同意',withdrawn:'已撤回',denied:'本人拒绝',stop_all:'停止全部营销'}[row.action]??'待核对决定'}</strong><p>{dateText(row.createdAt)} · {row.channel?channelNames[row.channel]:'全部渠道'} · {row.purpose==='own_activities'?'本店活动':row.purpose==='mbox_joint_activities'?'本店联系的联合活动':'全部用途'}</p><p>{row.source==='customer_self'?'客户本人操作':`员工代记拒绝：${row.actorName??'已记录员工'}`}{row.reason?`；原因：${row.reason}`:''}</p>{row.validUntil&&<p>该次许可截止：{dateText(row.validUntil)}</p>}{row.notice&&<details><summary>{row.notice.code} 第{row.notice.version}版原告知</summary><p>运营主体：{row.notice.operatorName}</p><p>{row.notice.summary}</p><p>数据范围：{row.notice.dataCategories.join('、')}</p><p>退出方式：{row.notice.withdrawalInstructions}</p></details>}</article>)}</div>{historyCursor&&<button type="button" onClick={()=>void readHistory(true)}>更早许可记录</button>}</section>}
      {lookupPurpose==='refusal'&&can('marketing.refusal.record')&&<button type="button" disabled={!customer} onClick={()=>customer&&void command('/refusals',{customerId:customer.id,reason},`记录${customer.name}明确拒绝营销，停止全部渠道未发送任务；不能代客户记录同意。`)}>记录拒绝全部营销</button>}
      {lookupPurpose==='send'&&can('marketing.send')&&<div className="marketing-grid"><label>本人已同意的告知版本<select value={task.noticeId} onChange={event=>setTask({...task,noticeId:event.target.value})}><option value="">先读取并选择已发布告知</option>{notices.filter(n=>n.status==='published').map(n=><option key={n.id} value={n.id}>{n.code} · 第{n.version}版</option>)}</select></label><label>联系渠道<select value={task.channel} onChange={event=>setTask({...task,channel:event.target.value})}>{Object.entries(channelNames).map(([key,name])=><option key={key} value={key}>{name}</option>)}</select></label><label>联系用途<select value={task.purpose} onChange={event=>setTask({...task,purpose:event.target.value})}><option value="own_activities">本店活动</option><option value="mbox_joint_activities">本店联系的联合活动</option></select></label><label>唯一活动批次<input value={task.campaignKey} onChange={event=>setTask({...task,campaignKey:event.target.value})}/></label><label>具体活动内容<textarea maxLength={2000} value={task.content} onChange={event=>setTask({...task,content:event.target.value})}/></label><label>任务截止（北京时间）<input type="datetime-local" value={task.expiresAt} onChange={event=>setTask({...task,expiresAt:event.target.value})}/></label><button type="button" disabled={!customer||!task.noticeId||!task.expiresAt} onClick={()=>customer&&void command('/jobs',{...task,customerId:customer.id,expiresAt:instant(task.expiresAt)},'仅建立任务，执行前再次核实本人许可、原生渠道、已验证地址和频次。未配置渠道不会发送。')}>建立待核验任务</button></div>}
    </fieldset></details>}
    {can('marketing.send')&&<><button disabled={busy} onClick={()=>void operate(()=>read('jobs'))}>读取联系任务</button><div className="marketing-records">{jobs.map(job=><article key={job.id}><h4>{job.campaign_key}</h4><p>{job.customer_ref} · {channelNames[job.channel]}</p><strong>{statusNames[job.status]??job.status}</strong>{job.blocked_reason&&<p>{reasonNames[job.blocked_reason]??'须核对许可与渠道证据'}</p>}{['queued','blocked'].includes(job.status)&&<button disabled={busy} onClick={()=>void command(`/jobs/${job.id}/cancel`,{reason},'取消尚未交给渠道的任务，保留审计记录。')}>取消任务</button>}</article>)}</div>{jobCursor&&<button disabled={busy} onClick={()=>void operate(()=>read('jobs',true))}>更多联系任务</button>}</>}
  </section>
}
