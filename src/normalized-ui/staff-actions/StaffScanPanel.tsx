import { useEffect, useMemo, useRef, useState } from 'react'
import { ScanLine } from 'lucide-react'
import type { NormalizedApiClient, StaffAuthView } from '../../normalized-api'
import type { ActivityDoorCommand, ActivityServiceView } from '../../shared/activity-service'
import { InventoryBarcodeScanner } from '../InventoryBarcodeScanner'
import { StaffActionsApi } from './staff-actions-api'
import { MemberParticipationCard } from './MemberParticipationCard'
import { ActivityServiceExceptionPanel } from './ActivityServiceExceptionPanel'
import { activityDoorRecoveryKey, isActivityCredential, readActivityDoorAttempt, type ActivityDoorAttempt } from './activity-door-recovery'
import './staff-scan-panel.css'

export function StaffScanPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const memberApi = useMemo(() => new StaffActionsApi({ staffSessionId: auth.session.id }), [auth.session.id])
  const [input, setInput] = useState('')
  const [camera, setCamera] = useState(false)
  const [memberCode, setMemberCode] = useState<string | null>(null)
  const [credential, setCredential] = useState('')
  const [service, setService] = useState<ActivityServiceView | null>(null)
  const [arrivals, setArrivals] = useState('1')
  const [admit, setAdmit] = useState(true)
  const [redeem, setRedeem] = useState(true)
  const [location, setLocation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<ActivityDoorAttempt | null>(null)
  const [recoveryBlocked, setRecoveryBlocked] = useState(false)
  const inFlight = useRef(false)
  const revision = useRef(0)
  const attempts = useRef(new Map<string, ActivityDoorAttempt>())
  const canManage = auth.permissions.includes('community.activity.manage')
  const canHandle = canManage || auth.permissions.includes('community.activity.verify')
  useEffect(() => () => { revision.current++ }, [])

  function keepAttempt(attempt: ActivityDoorAttempt | null, registration: string) {
    const key = activityDoorRecoveryKey(auth.employee.id, registration)
    if (attempt) {
      const safe = readActivityDoorAttempt(JSON.stringify(attempt), registration)
      if (!safe) throw new Error('原操作记录无法保留，请交由领班核对。')
      const serialized = JSON.stringify(safe)
      localStorage.setItem(key, serialized)
      if (localStorage.getItem(key) !== serialized) throw new Error('设备无法保存原操作，请恢复存储后继续。')
    } else localStorage.removeItem(key)
    if (attempt) attempts.current.set(key, attempt)
    else attempts.current.delete(key)
    setPending(attempt)
  }

  function reset(openCamera = false) {
    revision.current++
    setInput(''); setCredential(''); setMemberCode(null); setService(null)
    setPending(null); setRecoveryBlocked(false); setError(''); setNotice(''); setCamera(openCamera)
  }

  async function lookup(value: string) {
    if (inFlight.current) return
    const code = value.trim()
    if (!code) return
    const generation = ++revision.current
    setCamera(false); setError(''); setNotice(''); setService(null); setMemberCode(null); setPending(null); setRecoveryBlocked(false)
    setInput(code)
    if (!code.startsWith('MBOX_ACTIVITY_')) {
      if (!auth.permissions.includes('loyalty.account.view')) return setError('当前账号没有会员查询权限，请由有权限的同事处理。')
      setMemberCode(code)
      return
    }
    if (!isActivityCredential(code)) return setError('活动码不完整，请重新扫描顾客小程序中的套餐码。')
    inFlight.current = true; setBusy(true)
    try {
      const data = await api.postEndpoint<ActivityServiceView>('/api/staff/activity-operations/scan', { code })
      if (revision.current !== generation) return
      setCredential(code); setService(data); setLocation(data.meal?.location ?? '')
      setArrivals(String(Math.max(1, Math.min(data.partySize, data.remainingAdmission))))
      setAdmit(data.includesAdmission && data.remainingAdmission > 0)
      setRedeem(data.hasMeal === true && data.meal === null)
      const key = activityDoorRecoveryKey(auth.employee.id, data.registrationPublicId)
      let attempt = attempts.current.get(key) ?? null
      try {
        const saved = localStorage.getItem(key)
        attempt ??= readActivityDoorAttempt(saved, data.registrationPublicId)
        if (saved && !attempt) throw new Error('原操作记录无法读取，请交由领班核对，勿重复登记。')
      } catch (cause) {
        setRecoveryBlocked(true)
        setError(cause instanceof Error ? cause.message : '无法读取原操作，请恢复设备存储。')
      }
      setPending(attempt)
    } catch (cause) {
      if (revision.current === generation) setError(cause instanceof Error ? cause.message : '暂时无法查到结果，请重试原码。')
    } finally { inFlight.current = false; setBusy(false) }
  }

  async function command(body: ActivityDoorCommand, next = false) {
    if (!service || inFlight.current || !canHandle || recoveryBlocked) return
    const generation = revision.current
    const attempt = pending ?? { registrationPublicId: service.registrationPublicId, command: body, key: `activity-door-${crypto.randomUUID()}` }
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    try {
      keepAttempt(attempt, service.registrationPublicId)
      const data = await api.postEndpoint<ActivityServiceView>(
        `/api/staff/activity-operations/registrations/${encodeURIComponent(attempt.registrationPublicId)}/service`,
        { ...attempt.command, credential }, { idempotencyKey: attempt.key },
      )
      if (revision.current !== generation) return
      keepAttempt(null, attempt.registrationPublicId)
      setService(data)
      setAdmit(false); setRedeem(false)
      setNotice(data.meal ? `办理完成，餐号 ${data.meal.number}` : '本批入场已登记')
      if (next) reset(true)
    } catch (cause) {
      if (revision.current !== generation) return
      const status = cause && typeof cause === 'object' && 'status' in cause ? cause.status : null
      const notCommitted = cause && typeof cause === 'object' && 'commitDisposition' in cause && cause.commitDisposition === 'not_committed'
      // A definitive validation refusal can be corrected. Unknown and access
      // failures retain the original command; reading counts is not a retry.
      if (!pending && typeof status === 'number' && ([400, 404, 422].includes(status) || status === 409 && notCommitted)) {
        try { keepAttempt(null, attempt.registrationPublicId) } catch { setRecoveryBlocked(true) }
      }
      setError(cause instanceof Error ? cause.message : '办理结果待核对，请恢复原操作，不要重复登记。')
    } finally { inFlight.current = false; setBusy(false) }
  }

  const remaining = service?.remainingAdmission ?? 0
  const count = Number(arrivals)
  const validCount = !admit || (Number.isInteger(count) && count >= 1 && count <= remaining)
  return <section className="staff-scan-panel" aria-label="连续扫码与活动核销">
    <header><div><h1>扫码与活动核销</h1><p>会员码查询；套餐码办理入场与出餐。</p></div>
      <button type="button" disabled={busy} onClick={() => setCamera(true)}><ScanLine size={20}/>扫码</button></header>
    <form onSubmit={event => { event.preventDefault(); void lookup(input) }}>
      <label>会员号或套餐码<input value={input} maxLength={280} disabled={busy} autoComplete="off" onChange={event => setInput(event.target.value)}/></label>
      <button disabled={busy || !input.trim()}>{busy ? '正在核对…' : '查询'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {memberCode && <MemberParticipationCard key={memberCode} code={memberCode} api={memberApi} onClose={() => reset()}/>}
    {service && <article>
      <h2>{service.activityTitle} · {service.packageName || '活动入场'}</h2>
      <p>报名号：{service.registrationPublicId}</p>
      <p>本份预计 {service.partySize} 人 · 已入场 {service.admittedCount} 人 · 剩余入场 {remaining} 人</p>
      {service.meal && <div className="activity-number"><span>餐号</span><strong>{service.meal.number}</strong>
        <span>{service.meal.plaqueState === 'pending' ? '请交付对应号码牌，再点下一位' : service.meal.plaqueState === 'returned' ? '号码牌已归还' : '号码牌已发出'}</span>
        <span>{service.meal.location || '请在固定位置摆好号码牌'}</span></div>}
      {!!service.pendingAddonCount&&<p role="alert">还有 {service.pendingAddonCount} 笔已付款加购待续办，请交领班查原号和制作明细，勿重新收费。</p>}
      {pending ? <div role="status"><p>有一笔原操作待核对，请恢复原结果；不会重新增加一批人数或再做一份餐。</p>
        <button type="button" disabled={busy || !canHandle || recoveryBlocked} onClick={() => void command(pending.command)}>恢复原操作</button>{!canHandle && <p>当前账号无权恢复，请交有活动办理权限的同事或领班核对原操作，勿重新登记。</p>}</div> : <>
        {!canHandle && <p>当前账号可查询，请由有活动办理权限的同事完成核销。</p>}
        <fieldset disabled={busy || !canHandle || recoveryBlocked}>
          {service.includesAdmission && remaining > 0 && <label><input type="checkbox" checked={admit} onChange={event => setAdmit(event.target.checked)}/>登记本批首次入场
            {admit && <input aria-label="本批首次入场人数" type="number" min={1} max={remaining} step={1} value={arrivals} onChange={event => setArrivals(event.target.value)}/>}</label>}
          {service.hasMeal === true && service.meal === null && <label><input type="checkbox" checked={redeem} onChange={event => setRedeem(event.target.checked)}/>本份套餐现在开始出餐</label>}
          {redeem && !service.meal && <label>收餐区域（可选）<input maxLength={100} value={location} onChange={event => setLocation(event.target.value)}/></label>}
          {admit && !validCount && <p role="alert">请填写 1 至 {remaining} 的整数人数；仅登记本批实际首次入场人数。</p>}
          {(admit || redeem) && <button type="button" disabled={!validCount} onClick={() => void command({ action: admit && redeem ? 'admit_and_redeem' : admit ? 'admit' : 'redeem', ...(admit ? { arrivedCount: count } : {}), ...(location.trim() ? { location: location.trim() } : {}) })}>确认本次办理</button>}
          {service.meal?.plaqueState === 'issued' && <button type="button" onClick={() => void command({ action: 'return_plaque' })}>已收回号码牌</button>}
          {service.meal?.plaqueState === 'returned' && !canManage && <p>恢复原号码牌需领班或活动管理人员处理，请保留原号。</p>}
          {service.meal?.plaqueState === 'returned' && canManage && <button type="button" onClick={() => void command({ action: 'restore_plaque' })}>恢复原号码牌</button>}
        </fieldset>
        {service.meal && <details><summary>制作明细与异常恢复</summary>
          <label>当前固定收餐位置<input maxLength={100} value={location} onChange={event=>setLocation(event.target.value)} disabled={busy||!!pending||!canHandle}/></label>
          <button type="button" disabled={busy||!!pending||!canHandle||!location.trim()||location.trim()===service.meal.location} onClick={()=>void command({action:'update_location',location:location.trim()})}>更新收餐位置</button>
          <ul>{service.meal.lines.map(line => <li key={line.id}>{line.name} × {line.quantity} · 已取 {line.takenQuantity}</li>)}</ul>
          <button type="button" disabled={busy || !canManage || recoveryBlocked} onClick={() => void command({ action: 'recover' })}>核对并恢复缺失任务</button>
          {!canManage && <p>当前账号无权恢复缺失任务，请联系领班或活动管理人员核对原号；不要重新核销。</p>}
          {auth.permissions.includes('kds.exception.manage') && <ActivityServiceExceptionPanel key={service.registrationPublicId} api={api} service={service} scope={auth.employee.id} disabled={busy || !!pending || recoveryBlocked} onChanged={async()=>{
            const generation=revision.current,registration=service.registrationPublicId
            const response=await api.getEndpoint<{data:ActivityServiceView}>(`/api/staff/activity-operations/registrations/${encodeURIComponent(registration)}/service`)
            if(generation!==revision.current)throw new Error('已切换报名，请回原报名恢复核对')
            setService(response.data)
          }}/>}
        </details>}
      </>}
    </article>}
    <footer><button type="button" disabled={busy || !!pending || recoveryBlocked || (service?.meal?.plaqueState === 'pending' && !canHandle)} onClick={() => {
      if (service?.meal?.plaqueState === 'pending') void command({ action: 'plaque_issued' }, true)
      else reset(true)
    }}>下一位</button>
      {(pending || recoveryBlocked) && <button type="button" disabled={busy} onClick={() => reset(true)}>交领班处理，继续下一位</button>}
    </footer>
    {camera && <InventoryBarcodeScanner title="扫描会员码或套餐码" cameraLabel="连续核销扫码画面" maxCodeLength={280} autoAccept onClose={() => setCamera(false)} onDetected={code => void lookup(code)}/>}
  </section>
}
