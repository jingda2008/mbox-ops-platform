import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react'
import type {NormalizedApiClient,StaffAuthView} from '../normalized-api'
import type {OrderFinancialRecoveryDimensions,OrderFinancialRecoveryPage,OrderFinancialRecoveryPreview,OrderFinancialRecoveryRequestView,OrderRecoverySnapshot} from '../shared/order-financial-recovery'
import {canSendFinancialRecovery,financialRecoveryPermissions,OrderFinancialRecoveryJournal,recoveryDefinitelyNotCommitted,sendFinancialRecoveryIntent,type FinancialRecoveryCommand,type FinancialRecoveryIntent} from './order-financial-recovery'

export function OrderFinancialRecoveryPanel({api,auth}:{api:NormalizedApiClient;auth:StaffAuthView}){
  if(!financialRecoveryPermissions(auth.permissions).view)return null
  return <RecoveryWorkspace key={`${auth.employee.id}:${auth.session.id}`} api={api} auth={auth}/>
}
function RecoveryWorkspace({api,auth}:{api:NormalizedApiClient;auth:StaffAuthView}){
  const [rows,setRows]=useState<OrderFinancialRecoveryPreview[]>([]),[search,setSearch]=useState(''),[cursor,setCursor]=useState<string|null>(null)
  const [scopeKey,setScopeKey]=useState(''),[phase,setPhase]=useState<'loading'|'ready'|'error'|'forbidden'>('loading'),[notice,setNotice]=useState(''),[storageError,setStorageError]=useState('')
  const [pending,setPending]=useState<FinancialRecoveryIntent|null>(null),[busy,setBusy]=useState(false)
  const alive=useRef(true),revision=useRef(0),flight=useRef(false),authRef=useRef(auth);authRef.current=auth
  const load=useCallback(async(orderPublicId='',after?:string,expectedScope?:string)=>{
    const turn=++revision.current;setPhase('loading')
    try{
      const params=new URLSearchParams();if(orderPublicId)params.set('orderPublicId',orderPublicId);if(after)params.set('after',after)
      const response=await api.getEndpoint<{data:OrderFinancialRecoveryPage;meta:{scopeKey:string}}>(`/api/staff/order-financial-recovery?${params}`)
      if(!response.meta?.scopeKey||expectedScope&&response.meta.scopeKey!==expectedScope)throw new Error('当前门店已变化，请回原门店恢复原操作')
      if(!alive.current||turn!==revision.current)throw new Error('员工或查询范围已变化，请恢复原操作后核对')
      if(!financialRecoveryPermissions(authRef.current.permissions).view)throw new Error('当前没有财务查询权限')
      setScopeKey(response.meta.scopeKey);setRows(current=>after?[...current.filter(r=>!response.data.orders.some(n=>n.orderId===r.orderId)),...response.data.orders]:response.data.orders);setCursor(response.data.nextCursor);setPhase('ready')
      try{setPending(new OrderFinancialRecoveryJournal(response.meta.scopeKey,auth.employee.id,localStorage).pending());setStorageError('')}catch(error){setStorageError(message(error))}
    }catch(error){
      if(alive.current&&turn===revision.current){
        const denied=[401,403].includes((error as {status?:number})?.status??0)
        if(denied){setRows([]);setPending(null);setPhase('forbidden')}else setPhase('error')
        setNotice(message(error))
      }
      throw error
    }
  },[api,auth.employee.id])
  useEffect(()=>{alive.current=true;void load().catch(()=>{});return()=>{alive.current=false;revision.current++}},[load])
  async function execute(command:FinancialRecoveryCommand|null){
    if(flight.current||!scopeKey)return
    flight.current=true;setBusy(true);setNotice('')
    const journal=new OrderFinancialRecoveryJournal(scopeKey,auth.employee.id,localStorage)
    try{
      const result=await journal.execute(command,authRef.current.permissions,async original=>{
        if(!alive.current||authRef.current.employee.id!==original.employeeId)throw new Error('请由原员工恢复此操作')
        return sendFinancialRecoveryIntent(api,original)
      },async original=>{await load(original.orderPublicId,undefined,original.scopeKey);if(!alive.current||authRef.current.employee.id!==original.employeeId)throw new Error('员工已变化，请恢复原操作')})
      if(alive.current)setNotice(result.status==='requested'?'申请已保存，请由另一名授权员工复核。':result.status==='rejected'?'原申请已驳回。':`原事实已恢复：商品归属 ${money(result.itemAmountMinor)}，推荐归属 ${money(result.recommendationAmountMinor)}，积分贡献 ${result.pointsDelta}，成长 ${result.growthDelta}；可用积分变动 ${result.availablePointsDelta}。未再次收款或出品。`)
    }catch(error){if(alive.current){if([401,403].includes((error as {status?:number})?.status??0)){setRows([]);setPending(null);setPhase('forbidden')}setNotice(recoveryDefinitelyNotCommitted(error)?`${message(error)}。本次明确未提交，请刷新事实后重新核对。`:`${message(error)}。结果尚未确认，请保留原凭据并恢复原操作，不要重复申请。`)}}
    finally{if(alive.current){try{setPending(journal.pending())}catch(error){setStorageError(message(error))}setBusy(false)}flight.current=false}
  }
  if(phase==='forbidden')return <section aria-label="原订单权益与归属恢复"><p role="alert">{notice}</p><button onClick={()=>void load().catch(()=>{})}>重新核验权限</button></section>
  return <section id="order-financial-recovery" className="staff-module-summary loyalty-policy-panel" aria-label="原订单权益与归属恢复"><div>
    <strong>原订单权益与归属恢复</strong><p>核对原普通退款与明确补收后的商品、推荐及会员贡献。所有差额按原事实与规则计算；不修改原付款退款，不再次收款、退款或出品。</p>
    <p>积分沿用原有效期。规则尚未确认时仅显示待核，不自动增加可用积分；无需会员也可核对商品与推荐归属。</p>
    <form className="staff-module-form" onSubmit={(event:FormEvent)=>{event.preventDefault();void load(search.trim()).catch(()=>{})}}><label>完整原订单号<input value={search} onChange={e=>setSearch(e.target.value)} maxLength={160} placeholder="输入完整订单号；留空浏览已明确补收的订单"/></label><button disabled={busy||phase==='loading'}>读取恢复预览</button><button type="button" disabled={busy||phase==='loading'} onClick={()=>{setSearch('');void load().catch(()=>{})}}>浏览原补收订单</button></form>
    {notice&&<p role="status">{notice}</p>}{storageError&&<p role="alert">{storageError}；恢复存储前暂停提交。</p>}
    {pending&&<section aria-label="原恢复操作待确认"><p>原订单 {pending.orderPublicId} 的{pending.kind==='request'?'申请':'复核'}结果待确认，已保留原内容和凭据。</p><button disabled={busy||!canSendFinancialRecovery(pending,auth.employee.id,auth.permissions)} onClick={()=>void execute(null)}>恢复原操作结果</button>{!canSendFinancialRecovery(pending,auth.employee.id,auth.permissions)&&<p>请恢复原员工对应权限后核对，不能改由另一员工重放。</p>}</section>}
    {phase==='loading'&&<p>正在读取原事实…</p>}{phase==='ready'&&!rows.length&&<p>本次查询没有符合范围的原订单。可按完整订单号核对；此结果不代表全部历史均已恢复。</p>}
    <div className="activity-admin-list">{rows.map(row=><RecoveryCard key={`${row.orderId}:${row.basisVersion}`} row={row} auth={auth} disabled={busy||!!pending||!!storageError||phase!=='ready'} execute={execute}/>)}</div>
    {cursor&&<button type="button" disabled={busy||phase==='loading'} onClick={()=>void load(search.trim(),cursor).catch(()=>{})}>继续读取下一批原订单</button>}
  </div></section>
}
function RecoveryCard({row,auth,disabled,execute}:{row:OrderFinancialRecoveryPreview;auth:StaffAuthView;disabled:boolean;execute(command:FinancialRecoveryCommand):Promise<void>}){
  const [reason,setReason]=useState(''),[dimensions,setDimensions]=useState<OrderFinancialRecoveryDimensions>(row.availableDimensions[0]??'attribution'),[error,setError]=useState('')
  const pending=row.requests.some(r=>r.status==='requested'),canRequest=canSendFinancialRecovery({kind:'request',orderId:row.orderId,orderPublicId:row.orderPublicId,body:{basisVersion:row.basisVersion,dimensions,reason:'权限核对'}},auth.employee.id,auth.permissions)
  async function request(event:FormEvent){event.preventDefault();if(disabled||!canRequest)return;if(reason.trim().length<3||reason.trim().length>1000)return setError('核对依据请填写3至1000字');setError('');await execute({kind:'request',orderId:row.orderId,orderPublicId:row.orderPublicId,body:{basisVersion:row.basisVersion,dimensions,reason:reason.trim()}})}
  return <article><div style={{minWidth:0,width:'100%'}}><strong>原订单 {row.orderPublicId}</strong><RecoveryAmounts snapshot={row}/>
    {row.availableDimensions.length>0&&!pending&&<form className="staff-module-form" onSubmit={e=>void request(e)}><fieldset disabled={disabled}><legend>申请恢复原事实</legend><label>本次范围<select value={dimensions} onChange={e=>setDimensions(e.target.value as OrderFinancialRecoveryDimensions)}>{row.availableDimensions.map(d=><option key={d} value={d}>{dimensionLabel(d)}</option>)}</select></label><label>核对依据<textarea minLength={3} maxLength={1000} required value={reason} onChange={e=>setReason(e.target.value)}/></label>{error&&<p role="alert">{error}</p>}<button disabled={!canRequest} type="submit">提交申请，交另一人复核</button>{!canRequest&&<p>当前权限不包含所选恢复范围，请交对应财务或会员负责人处理。</p>}</fieldset></form>}
    {row.availableDimensions.length===0&&<p>当前没有可直接申请的恢复差额；按上方原事实与待核原因处理。</p>}
    {row.requests.map(request=><RecoveryRequest key={request.requestId} request={request} row={row} auth={auth} disabled={disabled} execute={execute}/>)}
  </div></article>
}
function RecoveryRequest({request,row,auth,disabled,execute}:{request:OrderFinancialRecoveryRequestView;row:OrderFinancialRecoveryPreview;auth:StaffAuthView;disabled:boolean;execute(command:FinancialRecoveryCommand):Promise<void>}){
  const [reason,setReason]=useState(''),[error,setError]=useState('')
  const base={kind:'decision' as const,orderId:row.orderId,orderPublicId:row.orderPublicId,requestId:request.requestId,requestedByEmployeeId:request.requestedByEmployeeId,dimensions:request.dimensions}
  const permitted=canSendFinancialRecovery({...base,body:{basisVersion:request.basisVersion,decision:'approve',reason:'权限核对'}},auth.employee.id,auth.permissions)
  const actionable=request.status==='requested'||request.status==='stale',stale=request.basisVersion!==row.basisVersion||request.status==='stale'
  async function decide(decision:'approve'|'reject'){if(disabled||!permitted)return;if(reason.trim().length<3||reason.trim().length>1000)return setError('复核说明请填写3至1000字');setError('');await execute({...base,body:{basisVersion:request.basisVersion,decision,reason:reason.trim()}})}
  return <section aria-label={`恢复申请 ${request.requestId}`}><strong>{({requested:'待异人复核',approved:'已按原事实恢复',rejected:'已驳回',stale:'原事实已变化',superseded:'已有后续申请'})[request.status]} · {dimensionLabel(request.dimensions)}</strong><p>{request.requestedByName} · {request.reason}</p><details><summary>查看原申请预览</summary><RecoveryAmounts snapshot={request.snapshot}/></details>{request.decisionReason&&<p>{request.decidedByName}：{request.decisionReason}</p>}
    {actionable&&request.requestedByEmployeeId===auth.employee.id&&<p>这是本人申请，必须由另一名授权员工复核。</p>}
    {actionable&&stale&&<p>事实已变化，不能按原预览批准。请驳回或刷新后重新申请。</p>}
    {actionable&&permitted&&<fieldset disabled={disabled}><legend>异人复核</legend><label>复核说明<textarea minLength={3} maxLength={1000} required value={reason} onChange={e=>setReason(e.target.value)}/></label>{error&&<p role="alert">{error}</p>}<button type="button" disabled={stale||!row.availableDimensions.includes(request.dimensions)} onClick={()=>void decide('approve')}>确认按原事实恢复</button><button type="button" onClick={()=>void decide('reject')}>驳回申请</button></fieldset>}
  </section>
}
export function RecoveryAmounts({snapshot}:{snapshot:OrderRecoverySnapshot}){
  const {attribution,loyalty}=snapshot
  return <><p>待补商品归属 {money(attribution.itemAmountMinor)}；推荐净归属已记 {money(attribution.recommendationCurrentMinor)} / 应记 {money(attribution.recommendationExpectedMinor)}，待补 {money(attribution.recommendationDeltaMinor)}。推荐归属不代表现金佣金。</p><ul>{attribution.items.map((item,i)=><li key={`${item.orderItemId}:${i}`}>{item.productName} · {money(item.amountMinor)} · {item.restored?'已有恢复事实':'待核原商品归属'}</li>)}</ul>{attribution.blockReasons.map(reason=><p key={reason}>{blockReason(reason)}</p>)}
    {loyalty.status==='permission_required'?<p>会员奖账需会员异常查看权限；当前仍可独立处理商品与推荐归属。</p>:<><p>{loyalty.memberNo?`会员 ${loyalty.memberNo}`:'原订单无可恢复会员奖账'} · 待恢复积分贡献 {loyalty.pointsDelta} / 成长 {loyalty.growthDelta}；可用积分变动 {loyalty.availablePointsDelta}；待回收积分变动 {loyalty.pendingRecoveryPointsDelta}。</p>{loyalty.policyVersionId&&<small>原规则 {loyalty.policyVersionId}；原有效期 {loyalty.expiresAt?new Date(loyalty.expiresAt).toLocaleString('zh-CN'):'无到期日'}，本操作不延长。</small>}{loyalty.status==='rule_pending'&&<p role="alert">原积分过期与后续抵债的归属规则待确认，本次不能恢复会员贡献；可独立核对已确定的商品与推荐归属。</p>}{loyalty.blockReasons.map(reason=><p key={reason}>{blockReason(reason)}</p>)}</>}</>
}
function dimensionLabel(v:OrderFinancialRecoveryDimensions){return ({attribution:'仅商品与推荐归属',loyalty:'仅会员积分与成长',all:'商品、推荐及会员贡献'})[v]}
function blockReason(code:string){return ({collection_not_settled:'原消费尚未按真实入账结清，请先核对原收款。',no_authorized_ordinary_refund:'缺少明确普通退款补收义务，不能自动推定恢复。',settlement_receipt_not_proven:'补收实收凭据尚未证明，请交财务核对。',loyalty_permission_required:'当前无会员奖账查看权限。',refund_review_required:'商品退款归属待核，请先完成原退款核对。',LOYALTY_REFUND_REVIEW_REQUIRED:'商品退款归属待核，请先完成原退款核对。',LOYALTY_RECOLLECTION_DEBT_EXPIRY_RULE_PENDING:'原积分期限与后续抵债规则待确认，暂不恢复会员贡献。',LOYALTY_POINTS_ACCRUAL_PAUSED:'当前会员积分发放已暂停，请由负责人核验运行开关。'} as Record<string,string>)[code]??'原事实尚有待核内容，请由财务负责人核对原单。'}
function money(v:number){return `¥${(v/100).toFixed(2)}`}
function message(error:unknown){return error instanceof Error?error.message:'原恢复状态暂时无法读取'}
