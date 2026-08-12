import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CalendarDays,
  Check,
  ChevronLeft,
  Clock3,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-react'
import {
  PublicReservationApi,
  PublicReservationApiError,
  withReservationSessionRecovery,
} from './reservation-api'
import {
  addCalendarDays,
  arrivalIso,
  createArrivalSlots,
  formatMoney,
  reservationArrivalHoldState,
  seatPreferenceLabel,
  shanghaiBusinessDate,
  validateConfirmation,
  validateGuestDetails,
  validateSchedule,
  DEFAULT_OPERATING_HOURS,
  type ReservationArrivalHoldState,
} from './reservation-model'
import type {
  OperatingHours,
  PublicReservation,
  PublicWaitlist,
  ReservationAvailability,
  ReservationDraft,
  ReservationIdentity,
  ReservationStep,
  SeatPreference,
} from './types'
import './reservation-booking.css'

const SEAT_PREFERENCES: ReadonlyArray<{
  value: SeatPreference
  label: string
  detail: string
}> = [
  { value: 'no_preference', label: '门店帮我安排', detail: '综合人数和现场情况' },
  { value: 'stage_atmosphere', label: '靠近舞台', detail: '氛围更热烈' },
  { value: 'quiet_chat', label: '方便聊天', detail: '相对舒缓一些' },
  { value: 'comfortable_booth', label: '卡座舒适', detail: '聚会久坐更轻松' },
  { value: 'outdoor_view', label: '室外露台', detail: '喜欢开阔和景观' },
]
const systemNow = () => new Date()

export interface ReservationBookingProps {
  identity: Readonly<ReservationIdentity>
  api?: PublicReservationApi
  operatingHours?: Readonly<OperatingHours>
  initialReservationId?: string
  now?: () => Date
  onReservationChange?: (reservation: PublicReservation | null) => void
}

export function ReservationBooking({
  identity,
  api: suppliedApi,
  operatingHours = DEFAULT_OPERATING_HOURS,
  initialReservationId,
  now = systemNow,
  onReservationChange,
}: ReservationBookingProps) {
  const api = useMemo(() => suppliedApi ?? new PublicReservationApi(), [suppliedApi])
  const today = shanghaiBusinessDate(now())
  const initialSlots = createArrivalSlots(today, now(), operatingHours)
  const [draft, setDraft] = useState<ReservationDraft>(() => createDraft(today, initialSlots[0]?.value ?? ''))
  const [step, setStep] = useState<ReservationStep>('schedule')
  const [phase, setPhase] = useState<'idle' | 'loading' | 'submitting'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [retryAt, setRetryAt] = useState<string | null>(null)
  const [sessionReady, setSessionReady] = useState(false)
  const [availability, setAvailability] = useState<ReservationAvailability | null>(null)
  const [reservation, setReservation] = useState<PublicReservation | null>(null)
  const [waitlist, setWaitlist] = useState<PublicWaitlist | null>(null)
  const [joinWaitlist, setJoinWaitlist] = useState(false)
  const [cancelArmed, setCancelArmed] = useState(false)
  const [arrivalHold, setArrivalHold] = useState<ReservationArrivalHoldState>({ kind: 'hidden', seconds: 0 })
  const editingId = reservation?.publicId ?? initialReservationId ?? null
  const request = useRef<AbortController | null>(null)

  const slots = useMemo(
    () => createArrivalSlots(draft.date, now(), operatingHours),
    [draft.date, now, operatingHours],
  )

  const run = useCallback(async <Value,>(operation: (signal: AbortSignal) => Promise<Value>): Promise<Value | null> => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setMessage(null)
    setRetryAt(null)
    try {
      return await operation(controller.signal)
    } catch (error) {
      if (error instanceof PublicReservationApiError && error.kind === 'aborted') return null
      setMessage(errorMessage(error))
      if (error instanceof PublicReservationApiError) setRetryAt(error.retryAt)
      throw error
    }
  }, [])

  const connect = useCallback(async () => {
    setPhase('loading')
    try {
      const result = await run(async (signal) => {
        await api.issueSession({
          provider: identity.provider,
          providerAssertion: identity.providerAssertion,
          deviceFingerprint: identity.deviceFingerprint,
        }, signal)
        return true
      })
      if (result === true) setSessionReady(true)
    } catch {
      setSessionReady(false)
    } finally {
      setPhase('idle')
    }
  }, [api, identity.deviceFingerprint, identity.provider, identity.providerAssertion, run])

  const runWithSession = useCallback(async <Value,>(
    operation: (signal: AbortSignal) => Promise<Value>,
  ): Promise<Value | null> => run(async (signal) => {
    try {
      return await withReservationSessionRecovery(
        () => operation(signal),
        () => api.issueSession({
          provider: identity.provider,
          providerAssertion: identity.providerAssertion,
          deviceFingerprint: identity.deviceFingerprint,
        }, signal),
      )
    } catch (error) {
      if (error instanceof PublicReservationApiError && error.sessionInvalid) setSessionReady(false)
      throw error
    }
  }), [api, identity.deviceFingerprint, identity.provider, identity.providerAssertion, run])

  useEffect(() => {
    void connect()
    return () => request.current?.abort()
  }, [connect])

  useEffect(() => {
    if (!sessionReady || initialReservationId === undefined || reservation !== null) return
    setPhase('loading')
    void runWithSession((signal) => api.getReservation(initialReservationId, signal))
      .then((value) => {
        if (value === null) return
        setReservation(value)
        setStep('complete')
      })
      .catch((error: unknown) => {
        const lookupMessage = reservationLookupMessage(error, false)
        if (lookupMessage !== null) setMessage(lookupMessage)
      })
      .finally(() => setPhase('idle'))
  }, [api, initialReservationId, now, reservation, runWithSession, sessionReady])

  useEffect(() => {
    if (reservation === null) {
      setArrivalHold({ kind: 'hidden', seconds: 0 })
      return
    }
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null
    let ticker: ReturnType<typeof globalThis.setInterval> | null = null
    const update = () => setArrivalHold(reservationArrivalHoldState(reservation, now()))
    const arm = () => {
      update()
      if (reservation.status !== 'confirmed' || reservation.arrivalState !== 'not_arrived') return
      const delay = Date.parse(reservation.arrivalAt) - now().getTime()
      if (delay > 0) {
        timer = globalThis.setTimeout(arm, Math.min(delay, 60_000))
        return
      }
      ticker = globalThis.setInterval(update, 1_000)
    }
    arm()
    return () => {
      if (timer !== null) globalThis.clearTimeout(timer)
      if (ticker !== null) globalThis.clearInterval(ticker)
    }
  }, [now, reservation])

  const refreshReservationStatus = useCallback(async (showProgress = true) => {
    const publicId = reservation?.publicId
    if (publicId === undefined || !sessionReady) return
    if (showProgress) setPhase('loading')
    try {
      const latest = await runWithSession((signal) => api.getReservation(publicId, signal))
      if (latest === null) return
      setReservation(latest)
      onReservationChange?.(latest)
    } catch (error) {
      const lookupMessage = reservationLookupMessage(error, reservation !== null)
      if (lookupMessage !== null) setMessage(lookupMessage)
      // Keep the submitted receipt visible so the guest can quote its number to the store.
    } finally {
      if (showProgress) setPhase('idle')
    }
  }, [api, onReservationChange, reservation, runWithSession, sessionReady])

  useEffect(() => {
    const shouldRefresh = reservation?.status === 'pending'
      || (reservation?.status === 'confirmed' && reservation.arrivalState === 'not_arrived')
    if (step !== 'complete' || !shouldRefresh || !sessionReady || phase !== 'idle') return
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshReservationStatus(false)
    }
    const timer = globalThis.setInterval(refreshWhenVisible, 15_000)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      globalThis.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [phase, refreshReservationStatus, reservation?.arrivalState, reservation?.status, sessionReady, step])

  const loadAvailability = useCallback(async () => {
    const validation = validateSchedule(draft, slots)
      ?? (editingId === null
        ? validateGuestDetails(draft)
        : draft.customerName.trim().length === 0 ? '请填写预约姓名' : null)
    if (validation !== null) {
      setMessage(validation)
      return
    }
    setPhase('loading')
    try {
      const arrivalAt = arrivalIso(draft.date, draft.time, operatingHours)
      const value = await run((signal) => api.availability(arrivalAt, draft.guestCount, signal))
      if (value === null) return
      setAvailability(value)
      setDraft((current) => ({ ...current, mode: 'direct' }))
      setJoinWaitlist(!value.acceptingReservations)
      setStep('confirm')
    } catch {
      // The inline notice keeps the current schedule available for retry.
    } finally {
      setPhase('idle')
    }
  }, [api, draft, editingId, operatingHours, run, slots])

  const submit = useCallback(async () => {
    if (!sessionReady) {
      setMessage('预约服务尚未连接，请先重试')
      return
    }
    const validation = joinWaitlist
      ? validateGuestDetails(draft)
      : editingId === null
        ? validateConfirmation(draft)
        : null
    if (validation !== null) {
      setMessage(validation)
      return
    }
    const arrivalAt = arrivalIso(draft.date, draft.time, operatingHours)
    setPhase('submitting')
    try {
      if (joinWaitlist) {
        const created = await runWithSession((signal) => api.createWaitlist({
          customerName: draft.customerName.trim(),
          contact: draft.contact.trim(),
          guestCount: draft.guestCount,
          desiredArrivalAt: arrivalAt,
          note: emptyToNull(draft.note),
        }, signal))
        if (created === null) return
        setWaitlist(created)
        setReservation(null)
        setStep('complete')
        return
      }

      const common = {
        customerName: draft.customerName.trim(),
        guestCount: draft.guestCount,
        arrivalAt,
        ...(availability === null ? {} : { expectedEndAt: availability.expectedEndAt }),
        note: emptyToNull(draft.note),
        seatPreference: draft.seatPreference,
      }
      const saved = editingId === null
        ? await runWithSession((signal) => api.createReservation('direct', {
          ...common,
          contact: draft.contact.trim(),
        }, signal))
        : await runWithSession((signal) => api.updateReservation(editingId, common, signal))
      if (saved === null) return
      setReservation(saved)
      setWaitlist(null)
      setStep('complete')
      onReservationChange?.(saved)
    } catch (error) {
      if (error instanceof PublicReservationApiError && error.seatConflict) {
        const conflictMessage = error.message
        setStep('schedule')
        setMessage(conflictMessage)
      } else if (error instanceof PublicReservationApiError && error.sessionInvalid) {
        setSessionReady(false)
      }
    } finally {
      setPhase('idle')
    }
  }, [api, availability, draft, editingId, joinWaitlist, onReservationChange, operatingHours, runWithSession, sessionReady])

  const cancel = useCallback(async () => {
    if (!cancelArmed) {
      setCancelArmed(true)
      return
    }
    setPhase('submitting')
    try {
      if (reservation !== null) {
        const cancelled = await runWithSession((signal) => api.cancelReservation(reservation.publicId, signal))
        if (cancelled !== null) {
          setReservation(cancelled)
          onReservationChange?.(null)
        }
      } else if (waitlist !== null) {
        const cancelled = await runWithSession((signal) => api.cancelWaitlist(waitlist.publicId, signal))
        if (cancelled !== null) setWaitlist(cancelled)
      }
      setCancelArmed(false)
    } catch {
      // The current reservation remains visible so cancellation can be retried.
    } finally {
      setPhase('idle')
    }
  }, [api, cancelArmed, onReservationChange, reservation, runWithSession, waitlist])

  const editReservation = () => {
    if (reservation === null) return
    const schedule = scheduleFromArrival(reservation.arrivalAt)
    setDraft((current) => ({
      ...current,
      date: schedule.date,
      time: schedule.time,
      guestCount: reservation.guestCount,
      mode: 'direct',
      seatPreference: reservation.seatPreference,
      customerName: reservation.customerName,
      contact: '',
      note: reservation.note ?? '',
    }))
    setAvailability(null)
    setMessage(null)
    setStep('schedule')
  }

  return (
    <ReservationBookingView
      step={step}
      phase={phase}
      message={message}
      retryAt={retryAt}
      sessionReady={sessionReady}
      draft={draft}
      slots={slots}
      availability={availability}
      reservation={reservation}
      waitlist={waitlist}
      joinWaitlist={joinWaitlist}
      cancelArmed={cancelArmed}
      arrivalHold={arrivalHold}
      minDate={today}
      maxDate={addCalendarDays(today, 90)}
      onDraftChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      onLoadAvailability={() => void loadAvailability()}
      onBack={() => {
        setMessage(null)
        setStep('schedule')
      }}
      onJoinWaitlist={() => {
        setJoinWaitlist(true)
        setStep('confirm')
      }}
      onSubmit={() => void submit()}
      onReconnect={() => void connect()}
      onRefreshStatus={() => void refreshReservationStatus()}
      onEdit={editReservation}
      onCancel={() => void cancel()}
      onDismissCancel={() => setCancelArmed(false)}
    />
  )
}

export interface ReservationBookingViewProps {
  step: ReservationStep
  phase: 'idle' | 'loading' | 'submitting'
  message: string | null
  retryAt: string | null
  sessionReady: boolean
  draft: ReservationDraft
  slots: ReturnType<typeof createArrivalSlots>
  availability: ReservationAvailability | null
  reservation: PublicReservation | null
  waitlist: PublicWaitlist | null
  joinWaitlist: boolean
  cancelArmed: boolean
  arrivalHold: ReservationArrivalHoldState
  minDate: string
  maxDate: string
  onDraftChange: (patch: Partial<ReservationDraft>) => void
  onLoadAvailability: () => void
  onBack: () => void
  onJoinWaitlist: () => void
  onSubmit: () => void
  onReconnect: () => void
  onRefreshStatus: () => void
  onEdit: () => void
  onCancel: () => void
  onDismissCancel: () => void
}

export function ReservationBookingView(props: ReservationBookingViewProps) {
  const busy = props.phase !== 'idle'
  return (
    <main className="reservation-booking" data-testid="reservation-booking">
      <header className="reservation-header">
        <span className="reservation-brand">M</span>
        <span><strong>M-BOX LIVEHOUSE</strong><small>SUPERHIGH CULTURE · 陆家嘴</small></span>
        <span className={props.sessionReady ? 'reservation-secure is-ready' : 'reservation-secure'}>
          {props.sessionReady ? '预约服务在线' : '正在连接'}
        </span>
      </header>

      {props.step !== 'complete' && <Progress step={props.step} />}
      {props.message !== null && (
        <div className="reservation-notice" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <span>{props.message}{props.retryAt === null ? '' : `，${retryLabel(props.retryAt)}`}</span>
          {!props.sessionReady && <button type="button" onClick={props.onReconnect}>重新连接</button>}
        </div>
      )}

      {props.step === 'schedule' && (
        <ScheduleStep {...props} busy={busy} />
      )}
      {props.step === 'confirm' && props.availability !== null && (
        <ConfirmStep {...props} busy={busy} />
      )}
      {props.step === 'complete' && (
        <CompleteStep {...props} busy={busy} />
      )}
    </main>
  )
}

function ScheduleStep(props: ReservationBookingViewProps & { busy: boolean }) {
  return (
    <section className="reservation-step" aria-labelledby="reservation-schedule-title">
      <div className="reservation-title-row">
        <div><p>RESERVATION</p><h1 id="reservation-schedule-title">为今晚留个位置</h1></div>
        <CalendarDays size={22} aria-hidden="true" />
      </div>
      <p className="reservation-intro">告诉我们时间和偏好，门店会结合人数与现场情况为您确认合适的位置。</p>
      <div className="reservation-schedule-grid">
        <label>日期
          <input
            type="date"
            min={props.minDate}
            max={props.maxDate}
            value={props.draft.date}
            onChange={(event) => props.onDraftChange({ date: event.target.value, time: '' })}
          />
        </label>
        <label>到店时间
          <select value={props.draft.time} onChange={(event) => props.onDraftChange({ time: event.target.value })}>
            <option value="">请选择</option>
            {props.slots.map((slot) => <option value={slot.value} key={slot.value}>{slot.label}</option>)}
          </select>
        </label>
        <label>人数
          <span className="reservation-stepper">
            <button type="button" aria-label="减少人数" onClick={() => props.onDraftChange({ guestCount: Math.max(1, props.draft.guestCount - 1) })}>−</button>
            <input
              aria-label="预约人数"
              inputMode="numeric"
              value={props.draft.guestCount}
              onChange={(event) => props.onDraftChange({ guestCount: Number(event.target.value) })}
            />
            <button type="button" aria-label="增加人数" onClick={() => props.onDraftChange({ guestCount: Math.min(200, props.draft.guestCount + 1) })}>+</button>
          </span>
        </label>
      </div>

      <fieldset className="reservation-preferences">
        <legend>位置偏好 <span>选一个就好</span></legend>
        <div className="reservation-preference-grid">
          {SEAT_PREFERENCES.map((preference) => (
            <button
              type="button"
              className={props.draft.seatPreference === preference.value ? 'is-selected' : ''}
              aria-pressed={props.draft.seatPreference === preference.value}
              onClick={() => props.onDraftChange({ seatPreference: preference.value })}
              key={preference.value}
            >
              <span>{preference.label}</span>
              <small>{preference.detail}</small>
              {props.draft.seatPreference === preference.value && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
        <small className="reservation-preference-note">偏好不等于锁台，具体位置以门店确认结果为准。</small>
      </fieldset>

      <div className="reservation-contact-grid is-first-step">
        <label>怎么称呼您
          <input value={props.draft.customerName} maxLength={128} autoComplete="name" placeholder="例如：王女士" onChange={(event) => props.onDraftChange({ customerName: event.target.value })} />
        </label>
        {props.reservation === null
          ? <label>手机或微信
            <input value={props.draft.contact} maxLength={256} autoComplete="tel" placeholder="方便门店确认预约" onChange={(event) => props.onDraftChange({ contact: event.target.value })} />
          </label>
          : <p className="reservation-protected-contact"><strong>联系方式</strong><span>沿用原预约联系方式，门店仍可正常联系您。</span></p>}
        <label>想提前告诉我们（选填）
          <textarea value={props.draft.note} maxLength={1000} rows={2} placeholder="生日、庆祝或其他到店需求" onChange={(event) => props.onDraftChange({ note: event.target.value })} />
        </label>
      </div>
      <p className="reservation-hint"><Clock3 size={16} aria-hidden="true" /> 12:00起可预约，凌晨时段会标注“次日”</p>
      <button className="reservation-primary" type="button" disabled={props.busy} onClick={props.onLoadAvailability}>
        {props.busy ? <LoaderCircle className="is-spinning" size={18} aria-hidden="true" /> : <Check size={18} aria-hidden="true" />}
        {props.busy ? '正在查询' : '核对预约信息'}
      </button>
    </section>
  )
}

function ConfirmStep(props: ReservationBookingViewProps & { busy: boolean }) {
  const slot = props.slots.find((item) => item.value === props.draft.time)
  return (
    <section className="reservation-step" aria-labelledby="reservation-confirm-title">
      <div className="reservation-title-row is-compact">
        <button className="reservation-back" type="button" aria-label="返回修改预约信息" onClick={props.onBack}><ChevronLeft size={20} /></button>
        <div><p>{props.joinWaitlist ? 'WAITLIST' : 'REQUEST'}</p><h1 id="reservation-confirm-title">{props.joinWaitlist ? '登记候补' : '提交预约申请'}</h1></div>
      </div>
      <dl className="reservation-summary">
        <div><dt>到店</dt><dd>{props.draft.date} · {slot?.label ?? '--:--'}</dd></div>
        <div><dt>人数</dt><dd>{props.draft.guestCount}位</dd></div>
        <div><dt>位置偏好</dt><dd>{props.joinWaitlist ? '有位后联系' : seatPreferenceLabel(props.draft.seatPreference)}</dd></div>
        <div><dt>称呼</dt><dd>{props.draft.customerName.trim()}</dd></div>
        <div><dt>联系方式</dt><dd>{props.reservation === null ? props.draft.contact.trim() : '沿用原预约联系方式'}</dd></div>
        {props.draft.note.trim().length > 0 && <div><dt>到店需求</dt><dd>{props.draft.note.trim()}</dd></div>}
      </dl>
      {!props.joinWaitlist && props.availability?.depositRule.enabled === true && (
        <p className="reservation-deposit">
          {props.availability.depositRule.mode === 'minimum_spend_ratio' && props.draft.mode === 'direct'
            ? '预约定金将按门店最终安排位置计算'
            : `预约定金 ${formatMoney(props.availability.depositRule.amountMinor).replace('最低消费 ', '')}`}
          {props.availability.depositRule.ruleText === null ? '' : ` · ${props.availability.depositRule.ruleText}`}
        </p>
      )}
      <div className="reservation-request-note">
        <strong>这是一份预约申请</strong>
        <span>提交后由门店核对位置；收到“预约已确认”后才算预约成功。</span>
      </div>
      <button className="reservation-primary" type="button" disabled={props.busy || !props.sessionReady} onClick={props.onSubmit}>
        {props.busy ? <LoaderCircle className="is-spinning" size={18} aria-hidden="true" /> : <Check size={18} aria-hidden="true" />}
        {props.busy ? '正在提交' : props.joinWaitlist ? '确认加入候补' : '提交预约申请'}
      </button>
    </section>
  )
}

function CompleteStep(props: ReservationBookingViewProps & { busy: boolean }) {
  const record = props.reservation ?? props.waitlist
  if (record === null) return <section className="reservation-step"><p className="reservation-empty">预约信息暂时无法显示</p></section>
  const isReservation = props.reservation !== null
  const cancelled = record.status === 'cancelled'
  const pending = isReservation && props.reservation!.status === 'pending'
  const noShow = isReservation && props.reservation!.status === 'no_show'
  const confirmed = isReservation && ['confirmed', 'arrived', 'seated', 'completed'].includes(props.reservation!.status)
  const heading = cancelled
    ? '已取消'
    : noShow
      ? '预约已结束'
      : pending
        ? '等待门店确认'
        : confirmed
          ? '预约已确认'
          : isReservation ? '预约状态已更新' : '候补已登记'
  return (
    <section className="reservation-step reservation-complete" aria-labelledby="reservation-complete-title">
      <span className={`reservation-result-icon${cancelled || noShow ? ' is-cancelled' : pending ? ' is-pending' : ''}`}>
        {cancelled || noShow ? <X size={26} /> : pending ? <Clock3 size={25} /> : <Check size={26} />}
      </span>
      <p>{pending ? 'REQUEST RECEIVED' : isReservation ? 'YOUR RESERVATION' : 'WAITLIST'}</p>
      <h1 id="reservation-complete-title">{heading}</h1>
      {pending && (
        <div className="reservation-confirmation-state is-pending" role="status">
          <strong>预约申请已收到</strong>
          <span>门店确认后才正式生效，请留意本页或微信通知。</span>
        </div>
      )}
      {confirmed && (
        <div className="reservation-confirmation-state is-confirmed" role="status">
          <strong>门店已确认本次预约</strong>
          <span>请按约定时间到店，如有变化请提前联系。</span>
        </div>
      )}
      <dl className="reservation-summary">
        <div><dt>编号</dt><dd>{record.publicId}</dd></div>
        <div><dt>到店</dt><dd>{formatDateTime(isReservation ? props.reservation!.arrivalAt : props.waitlist!.desiredArrivalAt)}</dd></div>
        <div><dt>人数</dt><dd>{record.guestCount}位</dd></div>
        <div><dt>联系</dt><dd>{record.maskedContact}</dd></div>
        {isReservation && <div><dt>位置偏好</dt><dd>{seatPreferenceLabel(props.reservation!.seatPreference)}</dd></div>}
        {isReservation && <div><dt>位置安排</dt><dd>{pending ? '确认后保留预约名额' : '到店后由门迎安排'}</dd></div>}
      </dl>
      {!cancelled && confirmed && props.arrivalHold.kind === 'active' && (
        <div className="reservation-hold" role="status">
          <strong>预约到店保留剩余 {formatCountdown(props.arrivalHold.seconds)}</strong>
          <span>本次预约为您保留到 {formatClock(props.reservation!.arrivalGraceEndsAt)}；具体位置到店后由门迎安排。</span>
        </div>
      )}
      {!cancelled && confirmed && props.arrivalHold.kind === 'expired' && (
        <div className="reservation-hold is-expired" role="status">
          <strong>预约到店保留时间已结束</strong>
          <span>如仍计划到店，请尽快联系门店重新安排位置。</span>
        </div>
      )}
      {!cancelled && (
        <div className="reservation-complete-actions">
          {pending && <button className="reservation-status-refresh" type="button" disabled={props.busy} onClick={props.onRefreshStatus}>
            <RefreshCw size={16} className={props.busy ? 'is-spinning' : ''} aria-hidden="true" />
            {props.busy ? '正在刷新' : '刷新确认状态'}
          </button>}
          {isReservation && <button className="reservation-secondary" type="button" onClick={props.onEdit}>修改预约</button>}
          <button className={props.cancelArmed ? 'reservation-danger' : 'reservation-secondary'} type="button" disabled={props.busy} onClick={props.onCancel}>
            {props.cancelArmed ? '再次点击确认取消' : isReservation ? '取消预约' : '取消候补'}
          </button>
          {props.cancelArmed && <button className="reservation-link" type="button" onClick={props.onDismissCancel}>暂不取消</button>}
        </div>
      )}
    </section>
  )
}

function Progress({ step }: { step: ReservationStep }) {
  const active = step === 'schedule' ? 1 : 2
  return (
    <ol className="reservation-progress" aria-label="预约进度">
      {['预约信息', '提交申请'].map((label, index) => (
        <li className={index + 1 <= active ? 'is-active' : ''} key={label}><span>{index + 1}</span>{label}</li>
      ))}
    </ol>
  )
}

function createDraft(date: string, time: string): ReservationDraft {
  return {
    date,
    time,
    guestCount: 2,
    mode: 'direct',
    seatPreference: 'no_preference',
    customerName: '',
    contact: '',
    note: '',
  }
}

function scheduleFromArrival(value: string): { date: string; time: string } {
  const shanghai = new Date(Date.parse(value) + 8 * 60 * 60_000)
  let date = shanghai.toISOString().slice(0, 10)
  const hour = shanghai.getUTCHours()
  const minute = hour * 60 + shanghai.getUTCMinutes()
  const businessMinute = hour < 6 ? minute + 24 * 60 : minute
  if (hour < 6) date = addCalendarDays(date, -1)
  return { date, time: `${date}|${businessMinute}` }
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '预约服务暂时没有接上，请重试'
}

function reservationLookupMessage(error: unknown, hasSubmittedReceipt: boolean): string | null {
  if (!(error instanceof PublicReservationApiError) || error.code !== 'RESERVATION_NOT_FOUND') return null
  return hasSubmittedReceipt
    ? '申请已经提交，但当前暂时无法在线核验。请勿重复提交，可将下方预约编号提供给门店查询。'
    : '没有查到这条预约。请从原预约入口打开，或联系门店并提供预约编号核对。'
}

function retryLabel(value: string): string {
  const milliseconds = Date.parse(value) - Date.now()
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '请稍后重试'
  return `${Math.max(1, Math.ceil(milliseconds / 1000))}秒后可重试`
}

function formatCountdown(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}

function formatClock(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}
