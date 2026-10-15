import {useEffect,useRef,useState} from 'react'
import type {NormalizedApiClient,StaffAuthView} from '../normalized-api'
import type {ManualPointsBoard,ManualPointsResult} from '../shared/manual-points'
import {ManualPointsRecovery,type ManualPointsCommand,type ManualPointsIntent} from './manual-points-recovery'
import {useConfirmationDialog} from './ConfirmationDialog'
import './manual-points.css'
export function ManualPointsPanel({api,auth}:{api:NormalizedApiClient;auth:StaffAuthView}){
 return auth.permissions.includes('loyalty.adjust.manual')?<Workspace key={`${auth.employee.id}:${auth.session.id}`} api={api} auth={auth}/>:null
}
function Workspace({api,auth}:{api:NormalizedApiClient;auth:StaffAuthView}){
 const {confirmAction}=useConfirmationDialog()
 const [board,setBoard]=useState<ManualPointsBoard|null>(null),[pending,setPending]=useState<ManualPointsIntent|null>(null),[notice,setNotice]=useState(''),[storageError,setStorageError]=useState(''),[busy,setBusy]=useState(false),[ready,setReady]=useState(false)
 const [memberNo,setMemberNo]=useState(''),[points,setPoints]=useState(''),[reason,setReason]=useState('')
 const alive=useRef(true),revision=useRef(0),flight=useRef(false),current=useRef(auth);current.current=auth
 async function load(page=0,expectedScope?:string){
  const turn=++revision.current;setReady(false)
  const r=await api.getEndpoint<{data:ManualPointsBoard}>(`/api/staff/loyalty/manual-points?page=${page}`).catch(e=>{if(alive.current&&turn===revision.current)setBoard(null);throw e})
  if(!alive.current||turn!==revision.current)throw new Error('读取已中断，请恢复原操作')
  if(r.data.employeeId!==current.current.employee.id||!r.data.scopeKey||!Array.isArray(r.data.items)||(expectedScope&&r.data.scopeKey!==expectedScope))throw new Error('员工或门店已改变，请切回原身份核对')
  setBoard(r.data);setReady(true)
  try{setPending(new ManualPointsRecovery(r.data.scopeKey,auth.employee.id,localStorage).pending());setStorageError('')}catch(e){setStorageError(message(e))}
 }
 useEffect(()=>{alive.current=true;void load().catch(e=>{if(alive.current)setNotice(message(e))});return()=>{alive.current=false;revision.current++}},[]) // Identity/session changes remount the workspace.
 async function execute(command:ManualPointsCommand|null){
  if(flight.current||!board||!ready||storageError)return
  flight.current=true;setBusy(true);setNotice('')
  const recovery=new ManualPointsRecovery(board.scopeKey,auth.employee.id,localStorage)
  try{
   if(command){
    const row=command.kind==='decision'?board.items.find(r=>r.id===command.body.requestId):null
    const description=command.kind==='request'?`会员 ${command.body.memberNo}，申请变动 ${command.body.pointsDelta} 分。仅保存申请，审核后才改变余额。依据：${command.body.reason}`:`会员 ${row?.memberNo??'无法确认'}，申请变动 ${row?.pointsDelta??'无法确认'} 分，${command.body.decision==='approve'?'通过后立即调整积分':'驳回后不调整积分'}。依据：${command.body.reason}`
    if(!await confirmAction({title:'核对人工积分操作',description,confirmLabel:'确认执行'})||!alive.current)return
   }
   const result=await recovery.execute(command,current.current.permissions,async intent=>{
    if(!alive.current||current.current.employee.id!==intent.employeeId||!current.current.permissions.includes('loyalty.adjust.manual'))throw new Error('原员工授权已变化，未发起新请求')
    setPending(intent)
    const r=await api.postEndpoint<ManualPointsResult>(`/api/staff/loyalty/manual-points/${intent.kind==='request'?'requests':'decisions'}`,intent.body,{idempotencyKey:intent.key,timeoutMs:20000})
    return r
   },()=>load(board.page,board.scopeKey))
   if(alive.current){setReason('');setNotice(result.status==='requested'?'申请已保存，等待另一名授权员工复核；尚未改变余额。':result.status==='rejected'?'已驳回，余额未改变。':`已审核入账：申请变动 ${result.pointsDelta} 分，可用余额变动 ${result.availableDelta} 分，当前可用 ${result.balance} 分，待回收 ${result.pendingRecoveryPoints} 分。`)}
  }catch(e){if(alive.current){setNotice(`${message(e)}；结果未知时请恢复原操作。`);if([401,403].includes((e as {status?:number}).status??0)){setBoard(null);setReady(false)}}}
  finally{flight.current=false;if(alive.current){setBusy(false);try{setPending(recovery.pending())}catch(e){setStorageError(message(e))}}}
 }
 const disabled=busy||!ready||!!pending||!!storageError
 return <section className="staff-module-summary loyalty-policy-panel manual-points-panel" aria-label="人工积分申请与审核"><div>
  <h3>人工积分申请与审核</h3><p>用于有依据的关怀补发或余额纠错；原消费漏发请走订单对账。每积分按1元核对审批额度，申请人与审核人必须不同。正数补发优先抵扣历史欠分，有效期沿当前已发布规则；不增加成长值。</p>
  <p>审核需人工积分权限、积分复核权限，以及管理员在权限管理中明确配置的“人工积分调整审批”人民币额度。</p>
  {notice&&<p role="status">{notice}</p>}{storageError&&<p role="alert">{storageError}</p>}
  <button type="button" disabled={busy} onClick={()=>void load(board?.page??0).catch(e=>setNotice(message(e)))}>重新读取</button>
  {pending&&<div><p>原{pending.kind==='request'?`会员 ${pending.body.memberNo} 的 ${pending.body.pointsDelta} 分申请`:'审核操作'}等待核对，不能另建请求。</p><button type="button" disabled={busy||!ready||!!storageError} onClick={()=>void execute(null)}>恢复原积分操作</button></div>}
  <fieldset disabled={disabled}><legend>按会员号申请</legend>
   <label>会员号<input value={memberNo} maxLength={64} onChange={e=>setMemberNo(e.target.value)}/></label>
   <label>变动积分（正数补发，负数纠错扣减）<input value={points} inputMode="text" onChange={e=>setPoints(e.target.value)}/></label>
   <label>申请或复核依据<textarea value={reason} maxLength={240} onChange={e=>setReason(e.target.value)}/></label>
   <button type="button" onClick={()=>{if(!/^-?[1-9]\d*$/.test(points)){setNotice('积分须填写非零整数');return}void execute({kind:'request',body:{memberNo:memberNo.trim(),pointsDelta:Number(points),reason:reason.trim()}})}}>提交申请，不立即入账</button>
  </fieldset>
  {board?.items.map(r=><article key={r.id}><strong>会员 {r.memberNo} · {r.pointsDelta>0?'+':''}{r.pointsDelta} 分 · {({requested:'待复核',approved:'已入账',rejected:'已驳回'})[r.status]}</strong><p>{r.requesterName}：{r.reason}</p>{r.decisionReason&&<p>{r.deciderName}：{r.decisionReason}；可用积分变动 {r.availableDelta??'—'}；有效期 {r.expiresAt??'不适用'}</p>}{r.status==='requested'&&r.requestedBy===auth.employee.id&&<p>本人申请，请由其他授权员工复核。</p>}{r.status==='requested'&&r.requestedBy!==auth.employee.id&&auth.permissions.includes('loyalty.accrual.approve')&&<><button type="button" disabled={disabled} onClick={()=>void execute({kind:'decision',requestedBy:r.requestedBy,body:{requestId:r.id,decision:'approve',reason:reason.trim()}})}>复核通过并入账</button><button type="button" disabled={disabled} onClick={()=>void execute({kind:'decision',requestedBy:r.requestedBy,body:{requestId:r.id,decision:'reject',reason:reason.trim()}})}>驳回申请</button></>}</article>)}
  {board&&<div><button type="button" disabled={busy||board.page===0} onClick={()=>void load(board.page-1).catch(e=>setNotice(message(e)))}>上一页</button><span>第 {board.page+1} 页</span><button type="button" disabled={busy||!board.hasMore} onClick={()=>void load(board.page+1).catch(e=>setNotice(message(e)))}>下一页</button></div>}
 </div></section>
}
function message(e:unknown){return e instanceof Error?e.message:'积分数据无法确认'}
