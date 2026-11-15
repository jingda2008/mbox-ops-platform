import { useEffect,useMemo,useRef,useState } from 'react'
import { ArrowRightLeft,Check,LoaderCircle,X } from 'lucide-react'
import type { StaffActionsApiPort } from './staff-actions-api'
import type {MovementRecoverySummary} from './participant-movement-recovery'
import {ParticipantMovementHistoryPanel} from './ParticipantMovementHistoryPanel'
import type {
  StaffActionTable,StaffParticipantMovementPreview,StaffTableParticipant,
} from './types'

export function ParticipantMovementSheet(props:Readonly<{
  api:StaffActionsApiPort
  table:StaffActionTable
  allTables:StaffActionTable[]
  onClose():void
  onDone(message:string):void
}>) {
  const session=props.table.activeSession!
  const [participants,setParticipants]=useState<StaffTableParticipant[]>([])
  const [selected,setSelected]=useState<string[]>([])
  const [kind,setKind]=useState<'participant_split'|'participant_merge'>('participant_split')
  const [targetId,setTargetId]=useState('')
  const [guestCount,setGuestCount]=useState('1')
  const [reason,setReason]=useState('顾客确认调整所在桌次')
  const [capacityReason,setCapacityReason]=useState('')
  const [preview,setPreview]=useState<StaffParticipantMovementPreview|null>(null)
  const [reloadKey,setReloadKey]=useState(0)
  const [phase,setPhase]=useState<'loading'|'edit'|'preview'|'saving'|'error'>('loading')
  const [error,setError]=useState<string|null>(null)
  const [recovery,setRecovery]=useState<MovementRecoverySummary|null>(null)
  const [historyLoaded,setHistoryLoaded]=useState(false),[historyConfirmed,setHistoryConfirmed]=useState(false)
  const historyReview=useRef({loaded:false,confirmed:false})
  const scope=JSON.stringify([session.id,props.table.id,session.locationVersion,session.guestCount])
  const currentScope=useRef({scope,api:props.api});currentScope.current={scope,api:props.api}
  const flight=useRef<object|null>(null),confirmedSnapshot=useRef<string|null>(null)
  const recoveryNotice=useRef<string|null>(null)
  const mounted=useRef(true)
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
  useEffect(() => {
    const controller=new AbortController()
    setParticipants([]);setSelected([]);setPreview(null);setPhase('loading');setError(recoveryNotice.current);recoveryNotice.current=null
    confirmedSnapshot.current=null
    setHistoryLoaded(false);setHistoryConfirmed(false)
    historyReview.current={loaded:false,confirmed:false}
    setRecovery(props.api.pendingParticipantMovement?.()??null)
    props.api.loadTableParticipants(session.id,controller.signal).then((items) => {
      if (!controller.signal.aborted && currentScope.current.scope===scope && currentScope.current.api===props.api) { setParticipants(items); setPhase('edit') }
    }).catch((cause:unknown) => {
      if (!controller.signal.aborted && currentScope.current.scope===scope && currentScope.current.api===props.api) { setError(message(cause));setPhase('error') }
    })
    return () => controller.abort()
  },[props.api,reloadKey,session.id,scope])
  const targets=useMemo(() => props.allTables.filter((candidate) => candidate.id!==props.table.id
    && (kind==='participant_split'
      ? candidate.status==='available' && candidate.activeSession===null
      : candidate.activeSession?.status==='open')),[kind,props.allTables,props.table.id])
  const target=targets.find((item) => item.id===targetId) ?? null
  const targetGuestCount=kind==='participant_merge' ? target?.activeSession?.guestCount ?? 0 : 0
  const targetCapacity=kind==='participant_merge'
    ? target?.activeSession?.capacityAtOpen ?? 0
    : target?.capacity ?? 0
  const needsCapacityReason=target!==null && targetGuestCount+Number(guestCount)>targetCapacity
  const input=() => ({
    sourceTableSessionId:session.id, movementKind:kind,targetTableId:targetId,
    targetTableSessionId:kind==='participant_merge' ? target?.activeSession?.id ?? null : null,
    movedGuestCount:Number(guestCount),participantPublicIds:selected,
    ...(needsCapacityReason?{ capacityOverrideReason:capacityReason.trim() }:{}),
  })
  const snapshot=JSON.stringify([scope,input(),target?.activeSession,target?.capacity,target?.status,reason])
  const currentSnapshot=useRef(snapshot);currentSnapshot.current=snapshot
  const sameScope=()=>mounted.current && currentScope.current.scope===scope && currentScope.current.api===props.api
  const current=()=>sameScope() && currentSnapshot.current===snapshot
  const previewAction=async () => {
    if (flight.current || !current()) return
    const pending=props.api.pendingParticipantMovement?.();if(pending){setRecovery(pending);return}
    if (!target || !Number.isInteger(Number(guestCount)) || Number(guestCount)<1) {
      setError('请选择目标桌并填写实际移动人数');return
    }
    if (needsCapacityReason && capacityReason.trim().length<2) {
      setError(`目标桌容量${targetCapacity}人，请填写现场加座与通道安全说明`);return
    }
    if (kind==='participant_split' && selected.length===0) {
      setError('拆桌至少选择一名已识别顾客');return
    }
    if (kind==='participant_merge' && participants.length>0 && selected.length===0) {
      setError('人员并桌需要选择顾客；如需全员并桌，请点击“选择全部”并确认整桌人数');return
    }
    const isFullMerge=kind==='participant_merge' && Number(guestCount)===session.guestCount
    if (!isFullMerge && Number(guestCount)<selected.length) { setError('部分移动人数不能少于已选择的顾客账号数');return }
    if (kind==='participant_split' && Number(guestCount)>=session.guestCount) {
      setError('拆桌后源桌必须至少保留一人；全员移动请使用人员并桌');return
    }
    if (kind==='participant_merge' && Number(guestCount)>session.guestCount) {
      setError('移动人数不能超过源桌当前人数');return
    }
    if (kind==='participant_merge' && Number(guestCount)===session.guestCount
      && selected.length!==participants.length) {
      setError('全员并桌必须选择源桌全部已识别顾客');return
    }
    const token={};flight.current=token;confirmedSnapshot.current=null
    setPhase('loading');setError(recoveryNotice.current);recoveryNotice.current=null;setPreview(null);setHistoryLoaded(false);setHistoryConfirmed(false)
    historyReview.current={loaded:false,confirmed:false}
    try {
      const result=await props.api.previewParticipantMovement(input())
      if (!result.movementGuard || !/^\d+$/.test(result.movementGuard.movementRevision??'')) throw new Error('预检结果缺少桌位信息，请刷新后重新预检')
      if (current()) { confirmedSnapshot.current=snapshot;setPreview(result);setPhase('preview') }
    }
    catch (cause) { if (current()) { setError(message(cause));setPhase('edit') } }
    finally {
      if (flight.current===token) flight.current=null
      if (sameScope() && !current()) { setPreview(null);setError('桌次或人数已变化，请重新预检');setPhase('edit') }
    }
  }
  const execute=async () => {
    if (flight.current || !current()) return
    const pending=props.api.pendingParticipantMovement?.();if(pending){setRecovery(pending);return}
    if (confirmedSnapshot.current!==snapshot || !preview || preview.blockers.length>0) {
      setPreview(null);setError('桌次或人数已变化，请重新预检');setPhase('edit');return
    }
    if(preview.movementGuard.movementRevision!=='0'&&(!historyReview.current.loaded||!historyReview.current.confirmed)){setError('请先查询历史记录，并确认这是新的拆并桌');return}
    const token={};flight.current=token
    setPhase('saving');setError(null)
    try {
      await props.api.moveParticipants({ ...input(),reason:reason.trim(),movementGuard:preview.movementGuard,movementHistoryConfirmed:historyConfirmed })
      if (current()) props.onDone(kind==='participant_split' ? '人员拆桌已完成，请让被移动顾客扫描新桌二维码' : '人员并桌已完成，请让被移动顾客扫描目标桌二维码')
    } catch (cause) { if (sameScope()) { setRecovery(props.api.pendingParticipantMovement?.()??null);setPreview(null);setError(message(cause));setPhase('edit') } }
    finally {
      if (flight.current===token) flight.current=null
      if (sameScope() && !current()) { setPreview(null);setError('桌次状态已变化，请刷新名单核对原操作结果');setPhase('edit') }
    }
  }
  const resetSelection=() => {
    setTargetId('');setPreview(null);setSelected([]);setGuestCount('1');setCapacityReason('');setPhase('edit');setError(null)
  }
  const recover=async(seal=false)=>{
    const operation=seal?props.api.sealParticipantMovement:props.api.recoverParticipantMovement
    if(flight.current||!operation)return
    const token={};flight.current=token;recoveryNotice.current=null;setPhase('saving');setError(null)
    try{await operation.call(props.api);if(sameScope())props.onDone('原拆并桌结果已核对，请以刷新后的桌号和名单为准')}
    catch(cause){if(sameScope()){
      const error=cause as {code?:string;commitDisposition?:string}
      if(error.code==='TABLE_MOVEMENT_REQUEST_SEALED'&&error.commitDisposition==='not_committed'&&!props.api.pendingParticipantMovement?.()){
        props.onDone('原请求已撤回，迟到请求不会执行；需要继续操作时，请核对现场并重新预检')
      }else{recoveryNotice.current=message(cause);setError(recoveryNotice.current)}
    }}
    finally{if(flight.current===token)flight.current=null;if(sameScope()){
      const pending=props.api.pendingParticipantMovement?.()??null
      setRecovery(pending);setPreview(null);setPhase('edit');if(!pending)setReloadKey(value=>value+1)
    }}
  }
  if(recovery)return <div className="staff-participant-mask" role="dialog" aria-modal="true" aria-label="核对原拆并桌"><section className="staff-participant-sheet">
    <header><strong>核对原拆并桌</strong><button disabled={phase==='saving'} onClick={props.onClose}>关闭</button></header>
    <p>{recovery.message}</p><p>保留原桌次、原名单和原请求编号；恢复只核对原回执，不执行新的拆并桌。</p>
    <button type="button" disabled={phase==='saving'||!recovery.canRecover} onClick={()=>void recover()}>核对原拆并桌结果</button>
    {recovery.canSeal&&props.api.sealParticipantMovement&&<><p>撤回仅封存未执行的原编号，阻止迟到请求；若已经执行，只核对回执，不撤销移动。</p><button type="button" disabled={phase==='saving'} onClick={()=>void recover(true)}>撤回未确认的原请求</button></>}
    {error&&<p role="alert">{error}</p>}
  </section></div>
  return <div className="staff-participant-mask" role="dialog" aria-modal="true" aria-label="人员拆并桌">
    <section className="staff-participant-sheet">
      <header><div><strong>人员拆并桌</strong><small>{props.table.code} · 登记{session.guestCount}人</small></div>
        <button type="button" disabled={phase==='saving'} onClick={props.onClose} aria-label="关闭"><X size={19}/></button></header>
      {phase==='loading' ? <p className="staff-participant-loading"><LoaderCircle className="is-spinning"/>正在核对当前位置…</p> : <>
        {participants.length>session.guestCount&&<p>关联账号数不等于现场人数。全员并桌请选择全部账号，人数按两桌登记人数合计。</p>}
        <div className="staff-participant-kinds">
          <button disabled={phase==='saving'} className={kind==='participant_split'?'is-active':''} onClick={() => {if(flight.current)return;setKind('participant_split');resetSelection()}}>人员拆桌</button>
          <button disabled={phase==='saving'} className={kind==='participant_merge'?'is-active':''} onClick={() => {if(flight.current)return;setKind('participant_merge');resetSelection()}}>人员并桌</button>
        </div>
        {phase!=='preview' && phase!=='saving' ? <>
          <p className="staff-participant-help">只移动明确选中的顾客位置；历史订单、付款、任务和观察不复制。</p>
          <div className="staff-participant-list">
            {kind==='participant_merge' && participants.length>0 && <button type="button" onClick={() => {
              setSelected(participants.map((item) => item.publicId));setGuestCount(String(session.guestCount))
            }}>选择全部（仅业务已结清时可全员并桌）</button>}
            {participants.map((participant,index) => <label key={participant.publicId}>
              <input type="checkbox" checked={selected.includes(participant.publicId)} onChange={() => setSelected((current) => current.includes(participant.publicId)
                ? current.filter((id) => id!==participant.publicId) : [...current,participant.publicId])}/>
              <span><strong>{participant.seatLabel?.trim() || `${participant.identityLevel==='member'?'会员':participant.identityLevel==='identified'?'已识别顾客':'临时顾客'} ${index+1}`}</strong>
                <small>{roleLabel(participant.role)} · {confirmationLabel(participant.confirmationState)} · {participant.seatLabel?.trim() ? '请当面确认身份' : '无座位标签，请逐人确认'}</small></span>
            </label>)}
            {participants.length===0 && <p>本桌尚无已识别顾客。仅在全部业务结清后可按整桌人数并入另一营业桌。</p>}
          </div>
          <label>实际移动人数<input inputMode="numeric" value={guestCount} onChange={(event) => setGuestCount(event.target.value.replace(/\D/g,'').slice(0,3))}/></label>
          <label>目标桌<select value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">请选择</option>
            {targets.map((item) => <option key={item.id} value={item.id}>{item.code} · {kind==='participant_split'?'空闲':`${item.activeSession?.guestCount ?? 0}人`}</option>)}</select></label>
          <label>现场原因<input value={reason} maxLength={1000} onChange={(event) => setReason(event.target.value)}/></label>
          {needsCapacityReason && <label>加座与安全说明<input value={capacityReason} maxLength={1000}
            placeholder={`目标容量${targetCapacity}人，请说明临时加座与通道确认`}
            onChange={(event) => setCapacityReason(event.target.value)}/></label>}
          <button className="staff-primary-action" type="button" onClick={() => void previewAction()}><ArrowRightLeft size={17}/>下一步：执行前预检</button>
        </> : <div className="staff-participant-preview">
          <strong>基础条件已核对，提交时仍检查未结业务</strong><p>{preview?.accountingBoundary}</p>
          {preview && preview.blockers.length>0 && <div className="staff-inline-error"><span>请先处理以下未结事项：</span><ul>
            {preview.blockers.map((blocker) => <li key={blocker.code}>{blocker.label} {blocker.count}项；{blocker.resolution}</li>)}
          </ul></div>}
          <ul><li>{kind==='participant_split'?'人员拆桌':'人员并桌'}：{props.table.code} → {target?.code}</li>
            <li>移动人数：{preview?.movedGuestCount}人；关联账号：{preview?.selectedParticipantCount}个</li>
            <li>预计目标桌：{preview?.projectedGuestCount} / 容量{preview?.targetCapacity}人{preview?.requiresCapacityOverride?'（已填写加座说明）':''}</li>
            {preview?.roleAdjustments.map((adjustment) => <li key={adjustment.participantPublicId}>角色调整：{adjustment.reason}</li>)}
            <li>现场原因：{reason.trim()}</li>{needsCapacityReason && <li>加座说明：{capacityReason.trim()}</li>}
            <li>转桌后请让顾客扫描新桌二维码</li></ul>
          {confirmedSnapshot.current!==snapshot && <p>桌次或人数已变化，请返回修改并重新预检。</p>}
          {preview&&preview.movementGuard.movementRevision!=='0'&&<>
            <p>源桌或目标桌已有移动记录。丢失本地记录不能证明原操作未执行。</p>
            <ParticipantMovementHistoryPanel key={snapshot} api={props.api} ownerKey={scope} onVerified={()=>{if(current()){historyReview.current.loaded=true;setHistoryLoaded(true)}}} onInvalidated={()=>{if(current()){historyReview.current={loaded:false,confirmed:false};setHistoryLoaded(false);setHistoryConfirmed(false)}}}/>
            <label><input type="checkbox" disabled={!historyLoaded||phase==='saving'} checked={historyConfirmed} onChange={e=>{historyReview.current.confirmed=e.target.checked;setHistoryConfirmed(e.target.checked)}}/>已核对服务端记录及现场名单，本次是新的拆并桌</label>
          </>}
          <button className="staff-primary-action" type="button" disabled={phase==='saving' || confirmedSnapshot.current!==snapshot || (preview?.blockers.length ?? 0)>0 || !!preview&&preview.movementGuard.movementRevision!=='0'&&(!historyLoaded||!historyConfirmed)} onClick={() => void execute()}>
            {phase==='saving'?<LoaderCircle className="is-spinning" size={17}/>:<Check size={17}/>}确认执行</button>
          <button type="button" disabled={phase==='saving'} onClick={() => setPhase('edit')}>返回修改</button>
        </div>}
      </>}
      {error && <div className="staff-inline-error"><span>{error}</span><button type="button" onClick={() => {
        setSelected([]);setPreview(null);setError(null);setPhase('loading');setReloadKey((value) => value+1)
      }}>刷新名单并重新预检</button></div>}
    </section>
  </div>
  }

function message(error:unknown) { return error instanceof Error ? error.message : '操作失败，请刷新后重试' }
function roleLabel(role:StaffTableParticipant['role']) {
  return ({ reservation_owner:'预约人',organizer:'主联系人',payer:'付款人',companion:'同行顾客',unknown:'角色待确认' } as const)[role]
}
function confirmationLabel(state:StaffTableParticipant['confirmationState']) {
  return ({ unconfirmed:'身份待确认',confirmed:'身份已确认',corrected:'身份已更正' } as const)[state]
}
