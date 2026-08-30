import { useMemo, useRef, useState } from 'react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import { shortPublicReference } from './public-reference'
import './performance-revision-panel.css'

export interface PerformanceRevisionSchedule {
  id: string
  performerStageName: string
  startsAt: string
  endsAt: string
  status: string
}

type RevisionKind = 'rescheduled' | 'cancelled' | 'replaced'

interface RevisionImpactView {
  publicId: string
  reservationPublicId: string
  reservationStatus: string
  arrivalAt: string
  acknowledgement: null | { decision: 'keep' | 'reselect' | 'clear' }
}

export function PerformanceRevisionPanel({ api, auth, schedules, onChanged }: {
  api: NormalizedApiClient
  auth: StaffAuthView
  schedules: readonly PerformanceRevisionSchedule[]
  onChanged(): Promise<void>
}) {
  const candidates = useMemo(() => schedules.filter((schedule) => schedule.status === 'scheduled'), [schedules])
  const [open, setOpen] = useState(false)
  const [scheduleId, setScheduleId] = useState('')
  const [kind, setKind] = useState<RevisionKind>('rescheduled')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [replacementScheduleId, setReplacementScheduleId] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [latestImpacts, setLatestImpacts] = useState<RevisionImpactView[]>([])
  const pendingAttempt = useRef<{ fingerprint: string; key: string } | null>(null)
  const canRevise = auth.permissions.includes('performance.schedule.revise')
  if (!canRevise) return null
  const selectedId = scheduleId || candidates[0]?.id || ''
  const replacements = candidates.filter((schedule) => schedule.id !== selectedId)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy || selectedId === '') return
    if (reason.trim().length < 2) { setNotice('请填写可复核的调整原因'); return }
    let startIso: string | null = null
    let endIso: string | null = null
    if (kind === 'rescheduled') {
      startIso = localIso(startsAt)
      endIso = localIso(endsAt)
      if (startIso === null || endIso === null || Date.parse(endIso) <= Date.parse(startIso)) {
        setNotice('改期必须填写有效的新开始和结束时间')
        return
      }
    }
    if (kind === 'replaced' && replacementScheduleId === '') {
      setNotice('换场必须选择另一场已排期演出')
      return
    }
    setBusy(true)
    setNotice('')
    const request = {
      scheduleId: selectedId,
      kind,
      startsAt: startIso,
      endsAt: endIso,
      replacementScheduleId: kind === 'replaced' ? replacementScheduleId : null,
      reason: reason.trim(),
    }
    const fingerprint = JSON.stringify(request)
    if (pendingAttempt.current?.fingerprint !== fingerprint) {
      pendingAttempt.current = {
        fingerprint,
        key: `performance-revision-${crypto.randomUUID()}`,
      }
    }
    try {
      const response = await api.postEndpoint('/api/staff/performance-revisions', request, {
        idempotencyKey: pendingAttempt.current.key,
      })
      const data = record(response) && record(response.data) ? response.data : response
      const affected = record(data) && typeof data.affectedReservations === 'number'
        ? data.affectedReservations : null
      const revisionPublicId = record(data) && typeof data.publicId === 'string' ? data.publicId : null
      setNotice(affected === null
        ? '演出调整已保存，受影响预约将等待顾客重新确认'
        : `演出调整已保存，${affected}条预约等待顾客重新确认`)
      setReason('')
      setStartsAt('')
      setEndsAt('')
      setReplacementScheduleId('')
      pendingAttempt.current = null
      if (revisionPublicId !== null) {
        try {
          const impactsResponse = await api.getEndpoint<unknown>(
            `/api/staff/performance-revisions/${encodeURIComponent(revisionPublicId)}/impacts`,
          )
          const payload = record(impactsResponse) && record(impactsResponse.data)
            ? impactsResponse.data : impactsResponse
          setLatestImpacts(record(payload) && Array.isArray(payload.impacts)
            ? payload.impacts.filter(isImpactView) : [])
        } catch {
          setLatestImpacts([])
          setNotice((current) => `${current}；受影响清单暂时未读到，可刷新后复核`)
        }
      }
      await onChanged()
    } catch (error) {
      setNotice(error instanceof Error ? `${error.message}；内容已保留，可核对后重试` : '调整未完成；内容已保留，可核对后重试')
    } finally {
      setBusy(false)
    }
  }

  return <section className="performance-revision-panel">
    <header>
      <div><strong>演出调整与预约影响</strong><small>演出偏好不是座位或场次保证；调整不会自动取消顾客预约。</small></div>
      <button type="button" disabled={candidates.length === 0} onClick={() => setOpen((value) => !value)}>
        {open ? '收起' : '取消、改期或换场'}
      </button>
    </header>
    {notice !== '' && <p role="status">{notice}</p>}
    {latestImpacts.length > 0 && <div className="performance-revision-impacts">
      <strong>本次受影响预约</strong>
      {latestImpacts.map((impact) => <div key={impact.publicId}>
        <span>{dateTime(impact.arrivalAt)} · {shortPublicReference(impact.reservationPublicId)}</span>
        <small>{impact.acknowledgement === null ? '等待顾客确认' : decisionLabel(impact.acknowledgement.decision)}</small>
      </div>)}
    </div>}
    {open && <form onSubmit={(event) => void submit(event)}>
      <label>原演出<select value={selectedId} onChange={(event) => { setScheduleId(event.target.value); setReplacementScheduleId('') }}>
        {candidates.map((schedule) => <option key={schedule.id} value={schedule.id}>
          {schedule.performerStageName} · {dateTime(schedule.startsAt)}
        </option>)}
      </select></label>
      <label>调整方式<select value={kind} onChange={(event) => setKind(event.target.value as RevisionKind)}>
        <option value="rescheduled">改期</option><option value="replaced">换到另一场</option><option value="cancelled">取消本场</option>
      </select></label>
      {kind === 'rescheduled' && <div className="performance-revision-times">
        <label>新的开始时间<input type="datetime-local" required value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label>
        <label>新的结束时间<input type="datetime-local" required value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label>
      </div>}
      {kind === 'replaced' && <label>替代演出<select required value={replacementScheduleId} onChange={(event) => setReplacementScheduleId(event.target.value)}>
        <option value="">请选择</option>{replacements.map((schedule) => <option key={schedule.id} value={schedule.id}>
          {schedule.performerStageName} · {dateTime(schedule.startsAt)}
        </option>)}
      </select></label>}
      <label>调整原因<textarea required minLength={2} maxLength={500} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="顾客可看到该原因，请写清楚，不要填写手机号等隐私信息" /></label>
      <div className="performance-revision-warning">
        <strong>提交后</strong><span>系统会生成不可覆盖的修订和受影响预约清单；顾客可保留预约、接受调整、另选演出或清空演出偏好。</span>
      </div>
      <button type="submit" disabled={busy || selectedId === ''}>{busy ? '保存中' : '确认调整并通知受影响预约'}</button>
    </form>}
  </section>
}

function localIso(value: string): string | null {
  const date = new Date(value)
  return value.trim() !== '' && Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isImpactView(value: unknown): value is RevisionImpactView {
  if (!record(value) || typeof value.publicId !== 'string'
    || typeof value.reservationPublicId !== 'string' || typeof value.reservationStatus !== 'string'
    || typeof value.arrivalAt !== 'string') return false
  return value.acknowledgement === null || (record(value.acknowledgement)
    && ['keep','reselect','clear'].includes(String(value.acknowledgement.decision)))
}

function decisionLabel(value: RevisionImpactView['acknowledgement'] extends infer A
  ? A extends { decision: infer D } ? D : never : never): string {
  return value === 'reselect' ? '顾客已改选' : value === 'clear' ? '顾客未指定演出' : '顾客已接受调整'
}
