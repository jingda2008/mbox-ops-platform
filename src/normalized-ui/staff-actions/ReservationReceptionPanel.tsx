import {useEffect,useRef,useState} from 'react'
import type {StaffReservation} from './types'
import {ReservationReception,type ReceptionCandidates,type ReceptionCreateInput,type ReceptionDetail,type ReceptionOptions,type ReceptionReceipt} from './reservation-reception'
import './reservation-reception.css'
type ReadContext={api:ReservationReception;employeeId:string;permissionKey:string;selectedId:string|undefined}
type ScopedRead<T>={context:ReadContext;value:T}
const preferences=[['no_preference','门店安排'],['stage_atmosphere','靠近舞台'],['quiet_chat','方便聊天'],['comfortable_booth','卡座舒适'],['outdoor_view','室外露台']]as const
function localTime(value:string){if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw new Error('请填写上海时间的到店和结束日期时间');return new Date(value+':00+08:00').toISOString()}
export function ReservationReceptionPanel({api,employeeId,permissions,selected,onClose,onOpenTables,onChanged}:{api:ReservationReception;employeeId:string;permissions:readonly string[];selected:StaffReservation|null;onClose():void;onOpenTables():void;onChanged():Promise<void>}){
  const [caps,setCaps]=useState<{create:boolean;seat:boolean}|null>(null),[capError,setCapError]=useState('')
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0)
  const [creating,setCreating]=useState(false),[name,setName]=useState(''),[contact,setContact]=useState(''),[count,setCount]=useState('1')
  const [arrivalDate,setArrivalDate]=useState(''),[arrivalTime,setArrivalTime]=useState(''),[endDate,setEndDate]=useState(''),[endTime,setEndTime]=useState(''),[source,setSource]=useState<'phone'|'employee'>('phone'),[initial,setInitial]=useState<'pending'|'confirmed'>('confirmed')
  const [preference,setPreference]=useState<ReceptionCreateInput['seatPreference']>('no_preference'),[note,setNote]=useState(''),[optionsRead,setOptionsRead]=useState<ScopedRead<ReceptionOptions>|null>(null)
  const [detailRead,setDetailRead]=useState<ScopedRead<ReceptionDetail>|null>(null),[candidatesRead,setCandidatesRead]=useState<ScopedRead<ReceptionCandidates>|null>(null),[chosen,setChosen]=useState<string[]>([]),[reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false)
  const [receipt,setReceipt]=useState<ReceptionReceipt|null>(null)
  const alive=useRef(true),lock=useRef(false)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  const permissionKey=[...permissions].sort().join('|'),selectedId=selected?.id
  // Advance before rendering controls: an A→B→A or permission round trip
  // must invalidate the original read, even before effect cleanup runs.
  const contextRef=useRef<ReadContext>({api,employeeId,permissionKey,selectedId})
  if(contextRef.current.api!==api||contextRef.current.employeeId!==employeeId||contextRef.current.permissionKey!==permissionKey||contextRef.current.selectedId!==selectedId)contextRef.current={api,employeeId,permissionKey,selectedId}
  const context=contextRef.current
  const isCurrent=(captured:ReadContext)=>alive.current&&contextRef.current===captured
  const detail=detailRead?.context===context&&detailRead.value.reservation.id===selectedId?detailRead.value:null
  const candidates=candidatesRead?.context===context&&candidatesRead.value.reservationId===selectedId&&detail?.reservation.id===selectedId?candidatesRead.value:null
  const options=optionsRead?.context===context?optionsRead.value:null
  const canManage=permissions.includes('reservation.manage'),canSeat=canManage&&permissions.includes('table.open')
  const pending=api.pending(),pendingCreate=pending.some(p=>p.kind==='create'),pendingSeat=pending.some(p=>p.kind==='seat')
  async function loadCaps(){setCapError('');try{const c=await api.capabilities();if(alive.current)setCaps(c)}catch(error){if(alive.current){setCaps(null);setCapError(error instanceof Error?error.message:'接待能力暂时无法读取')}}}
  useEffect(()=>{void loadCaps()},[api,employeeId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{if(!canManage){setCreating(false);setName('');setContact('');setNote('');setReceipt(null)}},[canManage])
  useEffect(()=>{let current=true;setDetailRead(null);setCandidatesRead(null);setChosen([]);setReason('');setConfirmed(false);if(selectedId&&canManage){void api.detail(selectedId).then(value=>{if(current&&isCurrent(context)&&value.reservation.id===selectedId)setDetailRead({context,value})}).catch(e=>{if(current&&isCurrent(context))setMessage(e instanceof Error?e.message:'预约详情未能读取')})}return()=>{current=false}},[context,revision,canManage]) // eslint-disable-line react-hooks/exhaustive-deps
  async function run(work:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setMessage('');try{await work()}catch(error){if(isCurrent(context)){setMessage(error instanceof Error?error.message:'接待结果未确认，请核对原请求');if((error as {commitDisposition?:string}).commitDisposition==='not_committed'){setOptionsRead(null);setCandidatesRead(null);setChosen([]);setConfirmed(false)}}}finally{lock.current=false;if(alive.current){setBusy(false)}}}
  async function completed(result:ReceptionReceipt){if(!alive.current)return;setReceipt(result);setRevision(n=>n+1);if(result.operation==='create'){setContact('');setName('');setNote('');setCreating(false);setOptionsRead(null)}await onChanged()}
  async function loadCandidates(){if(!isCurrent(context)||!canSeat||!selectedId||detail?.reservation.id!==selectedId)return;const value=await api.candidates(selectedId);if(isCurrent(context)&&value.reservationId===selectedId){setCandidatesRead({context,value});setChosen([]);setConfirmed(false)}}
  const selectedSessions=candidates?.sessions.filter(s=>chosen.includes(s.tableSessionId))??[],actualGuests=selectedSessions.reduce((n,s)=>n+s.guestCount,0)
  const arrival=arrivalDate&&arrivalTime?arrivalDate+'T'+arrivalTime:'',end=endDate&&endTime?endDate+'T'+endTime:''
  const optionsMatch=options!==null&&(()=>{try{return options.arrivalAt===localTime(arrival)&&options.expectedEndAt===localTime(end)}catch{return false}})()
  return <section className="staff-reception" aria-label="预约名额与实际接待">
    <header><div><h2>预约名额与实际接待</h2><p>先登记人数、时间和偏好；到店后开台，再一次确认本组全部实际桌位。预约不预绑物理桌位。</p></div></header>
    {capError&&<p role="alert">{capError} <button type="button" disabled={busy} onClick={()=>void loadCaps()}>重新读取接待能力</button></p>}
    {caps===null&&!capError&&<p role="status">正在读取接待能力…</p>}
    {caps&&!caps.create&&<p role="status">新预约登记暂未开放，仍可处理原预约及核对原请求。</p>}
    {caps&&!caps.seat&&<p role="status">实际桌次关联暂不可用，原请求仍可核对。</p>}
    {pending.map(p=><div role="alert" className="staff-reception-pending" key={p.kind}><p>{p.message}</p>{p.kind==='create'&&<p>刷新后只查询原公开号；暂未查到不代表未提交，请勿重新代订。</p>}<button type="button" disabled={busy||!p.canRecover||!canManage} onClick={()=>void run(async()=>completed(await api.recover(p.kind)))}>核对原{p.kind==='create'?'预约创建':'入座'}请求</button></div>)}
    {message&&<p role="alert">{message}</p>}
    {receipt&&canManage&&<div role="status" className="staff-reception-receipt"><strong>{receipt.operation==='create'?'预约已登记，尚未安排实际桌位':'本组实际入座已确认'}</strong><p>预约编号：{receipt.reservation.publicId}</p>{receipt.maskedContact&&<p>联系方式：{receipt.maskedContact}</p>}{receipt.seating&&<p>{receipt.seating.sessions.map(s=>s.tableCodeAtSeating).join('、')} · 实际 {receipt.seating.seatedGuestCount} 人</p>}</div>}
    {canManage&&caps?.create===true&&<button type="button" disabled={busy||pendingCreate} onClick={()=>setCreating(!creating)}>{creating?'收起代订表单':'登记电话或员工代订'}</button>}
    {creating&&canManage&&caps?.create===true&&<form onSubmit={event=>{event.preventDefault();void run(async()=>{if(!isCurrent(context)||!canManage||caps?.create!==true||!options||!optionsMatch||options.creationEnabled!==true)throw Error('请先按当前时间读取名额与规则');await completed(await api.create({customerName:name.trim(),contact:contact.trim(),guestCount:Number(count),arrivalAt:options.arrivalAt,expectedEndAt:options.expectedEndAt,source,initialStatus:initial,note:note.trim()||null,seatPreference:preference,reservationPolicyVersion:options.policy.version,preferredScheduleId:null}))})}}>
      <fieldset disabled={busy||pendingCreate||!canManage||caps?.create!==true}><legend>登记接待名额</legend>
        <label>顾客称呼<input value={name} maxLength={120} required autoComplete="off" onChange={e=>setName(e.target.value)}/></label>
        <label>手机号或微信<input value={contact} minLength={3} maxLength={256} required autoComplete="off" onChange={e=>setContact(e.target.value)}/><small>仅用于本次接待；不会按手机号自动绑定旧会员。</small></label>
        <label>预约人数<input type="number" min={1} max={200} step={1} value={count} required onChange={e=>setCount(e.target.value)}/></label>
        <label>到店日期（上海）<input type="date" value={arrivalDate} required onChange={e=>{setArrivalDate(e.target.value);setOptionsRead(null)}}/></label>
        <label>到店时间（上海）<input type="time" value={arrivalTime} required onChange={e=>{setArrivalTime(e.target.value);setOptionsRead(null)}}/></label>
        <label>预计结束日期（上海）<input type="date" value={endDate} required onChange={e=>{setEndDate(e.target.value);setOptionsRead(null)}}/></label>
        <label>预计结束时间（上海）<input type="time" value={endTime} required onChange={e=>{setEndTime(e.target.value);setOptionsRead(null)}}/></label>
        <button type="button" disabled={!arrival||!end} onClick={()=>void run(async()=>{const value=await api.options(localTime(arrival),localTime(end));if(isCurrent(context)&&canManage)setOptionsRead({context,value})})}>读取名额与规则</button>
        {optionsMatch&&options&&options.creationEnabled!==true&&<p role="status">新预约登记暂未开放，仍可处理原预约及核对原请求。</p>}
        {optionsMatch&&options&&<p>该时段总接待容量 {options.capacity.totalGuests} 人，已登记 {options.capacity.committedGuests} 人。提交时会再次核对名额。</p>}
        <label>预约来源<select value={source} onChange={e=>setSource(e.target.value as typeof source)}><option value="phone">电话预约</option><option value="employee">员工代订</option></select></label>
        <label>登记状态<select value={initial} onChange={e=>setInitial(e.target.value as typeof initial)}><option value="confirmed">已与顾客确认</option><option value="pending">待确认</option></select></label>
        <label>位置偏好<select value={preference} onChange={e=>setPreference(e.target.value as typeof preference)}>{preferences.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>接待备注（可选）<textarea value={note} maxLength={1000} onChange={e=>setNote(e.target.value)}/></label>
        <button type="submit" disabled={!optionsMatch||options?.creationEnabled!==true}>确认登记名额</button>
      </fieldset>
    </form>}
    {selected&&<section className="staff-reception-detail" aria-label="实际接待详情"><header><h3>{detail?.reservation.customerName??'预约'} · 接待详情</h3><button type="button" onClick={onClose}>收起接待详情</button></header>
      {!detail&&<p>正在读取当前预约与接待关系；失败时请重新读取。</p>}
      <button type="button" disabled={busy} onClick={()=>setRevision(n=>n+1)}>重新读取接待详情</button>
      {detail?.seating&&<><p>已确认整组入座：预约 {detail.seating.reservationGuestCount} 人，实际 {detail.seating.seatedGuestCount} 人。</p><p>核对说明：{detail.seating.reason}</p>{detail.seating.sessions.map(s=><p key={s.tableSessionId}>入座时 {s.tableCodeAtSeating} · {s.guestCountAtSeating} 人；当前 {s.currentTableCode??s.tableCodeAtSeating} · {s.currentStatus==='closed'?'已结束':s.currentStatus==='open'?'营业中':s.currentStatus??'请刷新核对'}</p>)}<p>同一预约仅确认一组完整接待，已关联桌次不能重复加入。</p></>}
      {detail?.reservation.status==='arrived'&&!detail.seating&&<><p>顾客已到店。请先沿桌台页面为本组实际开台，全部安排就绪后一次确认；不支持先关联一部分再追加。</p><button type="button" disabled={busy} onClick={onOpenTables}>去桌台安排实际开台</button>{!canSeat&&<p>实际桌次关联需要预约管理和开台权限，请联系有权限的员工。</p>}{canSeat&&<button type="button" disabled={busy||pendingSeat||caps?.seat!==true} onClick={()=>void run(loadCandidates)}>读取可关联实际桌次</button>}
        {candidates&&<fieldset disabled={busy||pendingSeat||!canSeat||caps?.seat!==true}><legend>本组全部实际桌次</legend>{candidates.sessions.length===0?<p>当前没有可关联桌次。请完成实际开台，或由有桌台责任的员工读取。</p>:candidates.sessions.map(s=><label className="staff-reception-choice" key={s.tableSessionId}><input type="checkbox" checked={chosen.includes(s.tableSessionId)} onChange={e=>{setChosen(old=>e.target.checked?[...old,s.tableSessionId]:old.filter(id=>id!==s.tableSessionId));setConfirmed(false)}}/><span>{s.tableCode} · 实际 {s.guestCount} 人</span></label>)}<p>预约 {candidates.reservationGuestCount} 人；已选 {chosen.length} 桌，实际合计 {actualGuests} 人。</p>{chosen.length>0&&actualGuests!==candidates.reservationGuestCount&&<p role="alert">实际人数与预约不同，请在核对说明中记录实际原因。</p>}<label>实际接待核对说明<textarea value={reason} minLength={4} maxLength={1000} onChange={e=>setReason(e.target.value)} placeholder="核对整组桌位、实际人数及差异原因"/></label><label className="staff-reception-choice"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/><span>本组全部桌位已安排完毕，已核对实际人数</span></label><button type="button" disabled={!confirmed||!chosen.length||chosen.length>20||reason.trim().length<4} onClick={()=>void run(async()=>{if(!isCurrent(context)||!canSeat||detail?.reservation.id!==selected.id||candidates.reservationId!==selected.id)throw Error('当前预约或权限已变化，请重新读取实际桌次');await completed(await api.seat(selected.id,{protocol:1,reservationVersion:candidates.reservationVersion,sessions:selectedSessions.map(s=>({tableSessionId:s.tableSessionId,expectedTableId:s.tableId,expectedLocationVersion:s.locationVersion,expectedGuestCount:s.guestCount})),reason:reason.trim()}))})}>确认本组实际入座</button></fieldset>}
      </>}
      {detail&&!['arrived','seated'].includes(detail.reservation.status)&&!detail.seating&&<p>当前预约尚未登记到店或已结束；请按预约列表的当前状态处理。</p>}
    </section>}
  </section>
}
