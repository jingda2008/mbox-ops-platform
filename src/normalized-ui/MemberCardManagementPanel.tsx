import {useEffect,useRef,useState} from 'react'
import type {NormalizedApiClient,StaffAuthView} from '../normalized-api'
import {executeRecoverableCommand} from './recoverable-command'
import {createIdempotencyKey} from './cashier-mutation'
import {useConfirmationDialog} from './ConfirmationDialog'
import './member-card-management-panel.css'
interface Application{id:string;project_name:string;customer_reference:string;member_no:string|null;member_level:string|null;requested_at:string}
interface Project{id:string;code:string;name:string;kind:string;status:string;terms:string;available_until:string;created_by_employee_id:string}
interface Holding{id:string;project_name:string;customer_reference:string;status:string;expired:boolean;valid_until:string}
const names:Record<string,string>={draft:'草稿',open:'开放申请',paused:'暂停申请',closed:'已关闭',member:'会员',silver:'银卡',gold:'金卡',black:'黑卡'}
export function MemberCardManagementPanel({api,auth}:{api:NormalizedApiClient;auth:StaffAuthView}){
  const manage=auth.permissions.includes('member.card.manage'),review=auth.permissions.includes('member.card.review')
  const [projects,setProjects]=useState<Project[]>([]),[applications,setApplications]=useState<Application[]>([]),[selected,setSelected]=useState<string[]>([])
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[reason,setReason]=useState('符合申请条件')
  const [holdings,setHoldings]=useState<Holding[]>([]),[holdingCursor,setHoldingCursor]=useState<string|null>(null),[cardReason,setCardReason]=useState('')
  const [projectCursor,setProjectCursor]=useState<string|null>(null),[applicationCursor,setApplicationCursor]=useState<string|null>(null)
  const [form,setForm]=useState({code:'',name:'',terms:'',kind:'interest',availableFrom:'',availableUntil:'',cooperationReference:'',cooperationValidUntil:'',cooperationConfirmed:false})
  const generation=useRef(0),mounted=useRef(true),{confirmAction}=useConfirmationDialog()
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++}},[])
  const path='/api/staff/member-cards'
  if(!manage&&!review)return null
  async function load(){
    const current=++generation.current;setBusy(true);setMessage('')
    try{
      if(manage){const response=await api.getEndpoint<{data:{items:Project[];nextCursor:string|null}}>(`${path}/projects`);if(current===generation.current){setProjects(response.data.items);setProjectCursor(response.data.nextCursor)}}
      if(review){const response=await api.getEndpoint<{data:{items:Application[];nextCursor:string|null}}>(`${path}/applications`);if(current===generation.current){setApplications(response.data.items);setApplicationCursor(response.data.nextCursor);setSelected([])}}
    }catch(error){if(current===generation.current)setMessage(error instanceof Error?error.message:'读取失败，请重试')}
    finally{if(current===generation.current)setBusy(false)}
  }
  async function command<T=unknown>(url:string,data:unknown){return executeRecoverableCommand(`${auth.employee.id}:${url}`,data,createIdempotencyKey('member-card'),key=>api.postEndpoint<T>(url,data,{idempotencyKey:key}))}
  async function loadMore(kind:'projects'|'applications'){
    const cursor=kind==='projects'?projectCursor:applicationCursor
    if(busy||!cursor)return
    const current=++generation.current;setBusy(true)
    try{
      if(kind==='projects'){
        const response=await api.getEndpoint<{data:{items:Project[];nextCursor:string|null}}>(`${path}/projects?cursor=${encodeURIComponent(cursor)}`)
        if(current===generation.current){setProjects(previous=>[...new Map([...previous,...response.data.items].map(item=>[item.id,item])).values()]);setProjectCursor(response.data.nextCursor)}
      }else{
        const response=await api.getEndpoint<{data:{items:Application[];nextCursor:string|null}}>(`${path}/applications?cursor=${encodeURIComponent(cursor)}`)
        if(current===generation.current){setApplications(previous=>[...new Map([...previous,...response.data.items].map(item=>[item.id,item])).values()]);setApplicationCursor(response.data.nextCursor)}
      }
    }catch(error){if(current===generation.current)setMessage(error instanceof Error?error.message:'翻页失败，可重试；已读记录保留')}
    finally{if(current===generation.current)setBusy(false)}
  }
  async function loadHoldings(more=false){
    if(busy)return
    const current=++generation.current;setBusy(true)
    try{
      const result=await api.getEndpoint<{data:{items:Holding[];nextCursor:string|null}}>(`${path}/holdings${more&&holdingCursor?`?cursor=${encodeURIComponent(holdingCursor)}`:''}`)
      if(current===generation.current){setHoldings(previous=>more?[...new Map([...previous,...result.data.items].map(item=>[item.id,item])).values()]:result.data.items);setHoldingCursor(result.data.nextCursor)}
    }catch(error){if(current===generation.current)setMessage(error instanceof Error?error.message:'读取失败，请重试')}
    finally{if(current===generation.current)setBusy(false)}
  }
  async function changeHolding(card:Holding,action:'suspend'|'resume'|'revoke'){
    if(busy)return
    if(cardReason.trim().length<2){setMessage('请先填写持卡状态变更原因');return}
    const current=generation.current,label=action==='suspend'?'冻结':action==='resume'?'恢复':'撤销'
    const confirmed=await confirmAction({title:`${label}：${card.project_name}`,description:`确认${label}此客户的卡？消费等级不变，不删除已合法发放的优惠券。${action==='revoke'?'撤销后不能直接恢复。':''}`,confirmLabel:'确认'})
    if(!confirmed||!mounted.current||current!==generation.current)return
    setBusy(true)
    try{
      const result=await command<{status:string}>(`${path}/holdings/${card.id}/state`,{action,reason:cardReason})
      if(mounted.current){setHoldings(previous=>previous.map(item=>item.id===card.id?{...item,status:result.status}:item));setMessage(`持卡已${label}。`)}
    }catch(error){if(mounted.current)setMessage(error instanceof Error?error.message:'结果未确认，请刷新核对')}
    finally{if(mounted.current)setBusy(false)}
  }
  async function save(){
    if(busy)return;setBusy(true);setMessage('')
    try{
      if(!form.availableFrom||!form.availableUntil)throw new Error('请填写明确的开始和结束时间（北京时间）')
      await command(`${path}/projects`,{...form,availableFrom:`${form.availableFrom}:00+08:00`,availableUntil:`${form.availableUntil}:00+08:00`,cooperationReference:form.kind==='cobrand'?form.cooperationReference:null,
        cooperationValidUntil:form.kind==='cobrand'&&form.cooperationValidUntil?`${form.cooperationValidUntil}:00+08:00`:null,cooperationConfirmed:form.kind==='cobrand'&&form.cooperationConfirmed})
      if(!mounted.current)return
      await load();setMessage('已保存草稿，尚未开放申请、发卡或发券。')
    }catch(error){if(mounted.current)setMessage(error instanceof Error?error.message:'保存结果未确认，请核对后重试')}
    finally{if(mounted.current)setBusy(false)}
  }
  async function decide(ids:string[],decision:'approve'|'reject'){
    if(busy||!ids.length)return
    if(reason.trim().length<2){setMessage('请选择或填写简短审核原因');return}
    setBusy(true);setMessage('')
    const results:string[]=[]
    const decisionReason=decision==='reject'&&reason==='符合申请条件'?'不符合本卡申请条件':reason
    for(const id of ids){
      try{await command(`${path}/applications/${id}/review`,{decision,reason:decisionReason});results.push(`${applications.find(item=>item.id===id)?.member_no||id.slice(-8)}：${decision==='approve'?'通过':'拒绝'}成功`)}
      catch(error){results.push(`${id.slice(-8)}：${error instanceof Error?error.message:'未确认，请核对'}`)}
      if(!mounted.current)return
    }
    await load();if(mounted.current){setMessage(results.join('\n'));setBusy(false)}
  }
  async function state(project:Project,next:'open'|'paused'|'closed'){
    if(busy)return
    const confirmed=await confirmAction({title:`${names[next]}：${project.name}`,description:next==='closed'?'关闭后不再受理新申请，既有卡和合法发放的券不删除；关闭不可直接撤销。':'只改变卡项目申请状态，不自动发券，也不改变客户营销授权。',confirmLabel:'确认'})
    if(!confirmed||!mounted.current)return
    setBusy(true)
    try{await command(`${path}/projects/${project.id}/state`,{state:next,reason:`员工确认${names[next]}`});if(mounted.current){await load();setMessage('项目状态已更新。')}}
    catch(error){if(mounted.current)setMessage(error instanceof Error?error.message:'状态未确认，请刷新')}
    finally{if(mounted.current)setBusy(false)}
  }
  return <section className="member-card-management"><header><div><h3>兴趣卡与联名卡</h3><p>消费等级保持独立。普通申请一名授权员工处理即可；通过不代表发券或营销授权成功。</p></div><button type="button" disabled={busy} onClick={()=>void load()}>读取 / 刷新</button></header>
    {message&&<p role="status" className="member-card-management__message">{message}</p>}
    {review&&<div><h4>普通申请审核</h4><label>审核原因<input value={reason} maxLength={300} disabled={busy} onChange={event=>setReason(event.target.value)}/></label><div className="member-card-management__actions"><button type="button" disabled={busy||!selected.length} onClick={()=>void decide(selected,'approve')}>通过选中 {selected.length} 项</button><button type="button" disabled={busy||!selected.length} onClick={()=>void decide(selected,'reject')}>拒绝选中 {selected.length} 项</button></div>
      {!applications.length&&<p>读取后将在这里显示待审核申请。</p>}
      {applicationCursor&&<button type="button" disabled={busy} onClick={()=>void loadMore('applications')}>加载更多待审核申请</button>}
      <label>常用审核理由<select disabled={busy} value={['符合申请条件','不符合本卡申请条件','资料不完整，请核对后重新申请'].includes(reason)?reason:''} onChange={event=>setReason(event.target.value)}><option value="">自定义原因</option><option>符合申请条件</option><option>不符合本卡申请条件</option><option>资料不完整，请核对后重新申请</option></select></label>
      {applications.map(item=><article key={item.id}><label className="member-card-management__select"><input type="checkbox" checked={selected.includes(item.id)} disabled={busy} onChange={event=>setSelected(value=>event.target.checked?[...value,item.id]:value.filter(id=>id!==item.id))}/><span>{item.member_no||item.customer_reference}<small>{names[item.member_level||'']||'等级待核实'} · {item.project_name}</small><small>申请于 {new Date(item.requested_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} · 待审核</small></span></label><div className="member-card-management__actions"><button type="button" disabled={busy} onClick={()=>void decide([item.id],'approve')}>通过</button><button type="button" disabled={busy} onClick={()=>void decide([item.id],'reject')}>拒绝</button></div></article>)}
    </div>}
    {manage&&<details><summary>持卡状态管理</summary><p>冻结、恢复和撤销独立于会员等级。退出和撤销的卡不直接恢复；已到期卡不能恢复。</p><label>变更原因<input maxLength={300} value={cardReason} disabled={busy} onChange={event=>setCardReason(event.target.value)}/></label><button type="button" disabled={busy} onClick={()=>void loadHoldings()}>读取 / 刷新持卡</button>
      {holdings.map(card=><article key={card.id}><div><strong>{card.project_name}</strong><small>{card.customer_reference} · {card.expired?'已到期':({active:'有效',suspended:'已冻结',withdrawn:'已退出',revoked:'已撤销'}[card.status]||card.status)}</small></div><div className="member-card-management__actions">
        {card.status==='active'&&!card.expired&&<button type="button" disabled={busy} onClick={()=>void changeHolding(card,'suspend')}>冻结</button>}
        {card.status==='suspended'&&!card.expired&&<button type="button" disabled={busy} onClick={()=>void changeHolding(card,'resume')}>恢复</button>}
        {['active','suspended'].includes(card.status)&&<button type="button" disabled={busy} onClick={()=>void changeHolding(card,'revoke')}>撤销</button>}
      </div></article>)}
      {holdingCursor&&<button type="button" disabled={busy} onClick={()=>void loadHoldings(true)}>加载更多持卡</button>}
    </details>}
    {manage&&<details><summary>卡项目配置与开放</summary><fieldset disabled={busy}><div className="member-card-management__grid">
      <label>项目编号<input value={form.code} maxLength={40} placeholder="如 FAN_MUSIC" onChange={event=>setForm({...form,code:event.target.value.toUpperCase()})}/></label>
      <label>名称<input value={form.name} maxLength={60} onChange={event=>setForm({...form,name:event.target.value})}/></label>
      <label>类型<select value={form.kind} onChange={event=>setForm({...form,kind:event.target.value,cooperationConfirmed:false})}><option value="interest">免费兴趣卡</option><option value="cobrand">免费联名卡</option></select></label>
      <label>开始时间（北京时间）<input type="datetime-local" value={form.availableFrom} onChange={event=>setForm({...form,availableFrom:event.target.value})}/></label>
      <label>结束时间（北京时间）<input type="datetime-local" value={form.availableUntil} onChange={event=>setForm({...form,availableUntil:event.target.value})}/></label>
      {form.kind==='cobrand'&&<><label>合作依据（仅内部）<input value={form.cooperationReference} maxLength={500} onChange={event=>setForm({...form,cooperationReference:event.target.value})}/></label><label>合作到期（北京时间）<input type="datetime-local" value={form.cooperationValidUntil} onChange={event=>setForm({...form,cooperationValidUntil:event.target.value})}/></label><label className="member-card-management__select"><input type="checkbox" checked={form.cooperationConfirmed} onChange={event=>setForm({...form,cooperationConfirmed:event.target.checked})}/>已核实合作许可和对外表述</label></>}
    </div><label>顾客申请说明<textarea value={form.terms} maxLength={6000} rows={4} onChange={event=>setForm({...form,terms:event.target.value})}/></label><p>保存后条款不可覆盖；需修订时新建项目。未配置入卡礼，不承诺自动发券。</p><button type="button" onClick={()=>void save()}>保存未开放草稿</button></fieldset>
      {projects.map(project=><article key={project.id}><div><strong>{project.name}</strong><small>{project.code} · {names[project.status]||project.status}</small><details><summary>申请说明</summary><p className="member-card-management__message">{project.terms}</p></details></div><div className="member-card-management__actions">
        {project.status!=='closed'&&project.status!=='open'&&project.created_by_employee_id!==auth.employee.id&&auth.permissions.includes('loyalty.policy.publish')&&<button type="button" disabled={busy} onClick={()=>void state(project,'open')}>开放申请</button>}
        {project.status==='open'&&<button type="button" disabled={busy} onClick={()=>void state(project,'paused')}>暂停申请</button>}{project.status!=='closed'&&<button type="button" disabled={busy} onClick={()=>void state(project,'closed')}>关闭项目</button>}
      </div></article>)}
      {projectCursor&&<button type="button" disabled={busy} onClick={()=>void loadMore('projects')}>加载更多卡项目</button>}
    </details>}
  </section>
}
