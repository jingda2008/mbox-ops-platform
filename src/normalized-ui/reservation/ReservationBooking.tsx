import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CalendarDays,
  Check,
  ChevronLeft,
  Clock3,
  LoaderCircle,
  MapPin,
  X,
} from 'lucide-react'
import { PublicReservationApi, PublicReservationApiError } from './reservation-api'
import {
  addCalendarDays,
  arrivalIso,
  createArrivalSlots,
  findTable,
  formatMoney,
  remainingHoldSeconds,
  shanghaiBusinessDate,
  tableStatusLabel,
  tablesForZone,
  validateConfirmation,
  validateGuestDetails,
  validateSchedule,
  zoneLabel,
  DEFAULT_OPERATING_HOURS,
} from './reservation-model'
import type {
  BookingMode,
  OperatingHours,
  PublicReservation,
  PublicWaitlist,
  ReservationAvailability,
  ReservationDraft,
  ReservationIdentity,
  ReservationStep,
  ReservationTable,
  ReservationZone,
} from './types'
import './reservation-booking.css'

const ZONES: readonly ReservationZone[] = ['stage-front', 'indoor-middle', 'outdoor']
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
  const [selectedZone, setSelectedZone] = useState<ReservationZone>('stage-front')
  const [focusedTableCode, setFocusedTableCode] = useState<string | null>(null)
  const [reservation, setReservation] = useState<PublicReservation | null>(null)
  const [waitlist, setWaitlist] = useState<PublicWaitlist | null>(null)
  const [joinWaitlist, setJoinWaitlist] = useState(false)
  const [cancelArmed, setCancelArmed] = useState(false)
  const [holdSeconds, setHoldSeconds] = useState(0)
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

  useEffect(() => {
    void connect()
    return () => request.current?.abort()
  }, [connect])

  useEffect(() => {
    if (!sessionReady || initialReservationId === undefined || reservation !== null) return
    setPhase('loading')
    void run((signal) => api.getReservation(initialReservationId, signal))
      .then((value) => {
        if (value === null) return
        setReservation(value)
        setStep('complete')
        setHoldSeconds(remainingHoldSeconds(value.holdExpiresAt, now()))
      })
      .catch(() => undefined)
      .finally(() => setPhase('idle'))
  }, [api, initialReservationId, now, reservation, run, sessionReady])

  useEffect(() => {
    if (reservation?.holdExpiresAt === null || reservation?.holdExpiresAt === undefined) return
    const update = () => setHoldSeconds(remainingHoldSeconds(reservation.holdExpiresAt, now()))
    update()
    const timer = globalThis.setInterval(update, 1_000)
    return () => globalThis.clearInterval(timer)
  }, [now, reservation])

  const loadAvailability = useCallback(async () => {
    const validation = validateSchedule(draft, slots)
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
      setDraft((current) => ({ ...current, tableCodes: [] }))
      setFocusedTableCode(null)
      setJoinWaitlist(value.areas.every((area) => area.tables.length === 0))
      setSelectedZone(firstZone(value) ?? 'stage-front')
      setStep('seat')
    } catch {
      // The inline notice keeps the current schedule available for retry.
    } finally {
      setPhase('idle')
    }
  }, [api, draft, operatingHours, run, slots])

  const chooseMode = (mode: BookingMode) => {
    setJoinWaitlist(false)
    setDraft((current) => ({ ...current, mode, tableCodes: mode === 'direct' ? [] : current.tableCodes }))
    if (mode === 'direct') setStep('confirm')
  }

  const chooseTable = (table: ReservationTable) => {
    setFocusedTableCode(table.code)
    if (table.status !== 'available') return
    setDraft((current) => {
      const selected = current.tableCodes.includes(table.code)
      const tableCodes = selected
        ? current.tableCodes.filter((code) => code !== table.code)
        : current.tableCodes.length < 4 ? [...current.tableCodes, table.code] : current.tableCodes
      return { ...current, mode: 'self_select', tableCodes }
    })
  }

  const submit = useCallback(async () => {
    if (!sessionReady) {
      setMessage('微信身份尚未连接，请先重试连接')
      return
    }
    const validation = joinWaitlist
      ? validateGuestDetails(draft)
      : editingId === null
        ? validateConfirmation(draft)
      : draft.mode === 'self_select' && draft.tableCodes.length === 0 ? '请选择一个座位' : null
    if (validation !== null) {
      setMessage(validation)
      return
    }
    const arrivalAt = arrivalIso(draft.date, draft.time, operatingHours)
    setPhase('submitting')
    try {
      if (joinWaitlist) {
        const created = await run((signal) => api.createWaitlist({
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
        ...(draft.mode === 'self_select' ? { tableCodes: draft.tableCodes } : {}),
      }
      const saved = editingId === null
        ? await run((signal) => api.createReservation(draft.mode, {
          ...common,
          contact: draft.contact.trim(),
        }, signal))
        : await run((signal) => api.updateReservation(editingId, {
          ...common,
          tableCodes: draft.tableCodes,
        }, signal))
      if (saved === null) return
      setReservation(saved)
      setWaitlist(null)
      setStep('complete')
      setHoldSeconds(remainingHoldSeconds(saved.holdExpiresAt, now()))
      onReservationChange?.(saved)
    } catch (error) {
      if (error instanceof PublicReservationApiError && error.seatConflict) {
        const conflictMessage = error.message
        setStep('seat')
        setDraft((current) => ({ ...current, tableCodes: [] }))
        await loadAvailability()
        setMessage(conflictMessage)
      } else if (error instanceof PublicReservationApiError && error.sessionInvalid) {
        setSessionReady(false)
      }
    } finally {
      setPhase('idle')
    }
  }, [api, availability, draft, editingId, joinWaitlist, loadAvailability, now, onReservationChange, operatingHours, run, sessionReady])

  const cancel = useCallback(async () => {
    if (!cancelArmed) {
      setCancelArmed(true)
      return
    }
    setPhase('submitting')
    try {
      if (reservation !== null) {
        const cancelled = await run((signal) => api.cancelReservation(reservation.publicId, signal))
        if (cancelled !== null) {
          setReservation(cancelled)
          onReservationChange?.(null)
        }
      } else if (waitlist !== null) {
        const cancelled = await run((signal) => api.cancelWaitlist(waitlist.publicId, signal))
        if (cancelled !== null) setWaitlist(cancelled)
      }
      setCancelArmed(false)
    } catch {
      // The current reservation remains visible so cancellation can be retried.
    } finally {
      setPhase('idle')
    }
  }, [api, cancelArmed, onReservationChange, reservation, run, waitlist])

  const editReservation = () => {
    if (reservation === null) return
    const schedule = scheduleFromArrival(reservation.arrivalAt)
    setDraft((current) => ({
      ...current,
      date: schedule.date,
      time: schedule.time,
      guestCount: reservation.guestCount,
      mode: 'self_select',
      tableCodes: reservation.tableCodes,
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
      selectedZone={selectedZone}
      focusedTable={findTable(availability?.areas ?? [], focusedTableCode)}
      reservation={reservation}
      waitlist={waitlist}
      joinWaitlist={joinWaitlist}
      cancelArmed={cancelArmed}
      holdSeconds={holdSeconds}
      minDate={today}
      maxDate={addCalendarDays(today, 90)}
      onDraftChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      onLoadAvailability={() => void loadAvailability()}
      onChooseMode={chooseMode}
      onZoneChange={setSelectedZone}
      onChooseTable={chooseTable}
      onContinue={() => setStep('confirm')}
      onBack={() => {
        setMessage(null)
        setStep(step === 'confirm' ? 'seat' : 'schedule')
      }}
      onJoinWaitlist={() => {
        setJoinWaitlist(true)
        setStep('confirm')
      }}
      onSubmit={() => void submit()}
      onReconnect={() => void connect()}
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
  selectedZone: ReservationZone
  focusedTable: ReservationTable | null
  reservation: PublicReservation | null
  waitlist: PublicWaitlist | null
  joinWaitlist: boolean
  cancelArmed: boolean
  holdSeconds: number
  minDate: string
  maxDate: string
  onDraftChange: (patch: Partial<ReservationDraft>) => void
  onLoadAvailability: () => void
  onChooseMode: (mode: BookingMode) => void
  onZoneChange: (zone: ReservationZone) => void
  onChooseTable: (table: ReservationTable) => void
  onContinue: () => void
  onBack: () => void
  onJoinWaitlist: () => void
  onSubmit: () => void
  onReconnect: () => void
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
        <span><strong>M-BOX LIVEHOUSE</strong><small>陆家嘴 · 上海</small></span>
        <span className={props.sessionReady ? 'reservation-secure is-ready' : 'reservation-secure'}>
          {props.sessionReady ? '已连接微信' : '正在连接'}
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
      {props.step === 'seat' && props.availability !== null && (
        <SeatStep {...props} busy={busy} />
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
        <div><p>RESERVATION</p><h1 id="reservation-schedule-title">今晚几点来？</h1></div>
        <CalendarDays size={22} aria-hidden="true" />
      </div>
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
      <p className="reservation-hint"><Clock3 size={16} aria-hidden="true" /> 午间12:00起可预约，凌晨时段标注“次日”</p>
      <button className="reservation-primary" type="button" disabled={props.busy} onClick={props.onLoadAvailability}>
        {props.busy ? <LoaderCircle className="is-spinning" size={18} aria-hidden="true" /> : <MapPin size={18} aria-hidden="true" />}
        查看可订座位
      </button>
    </section>
  )
}

function SeatStep(props: ReservationBookingViewProps & { busy: boolean }) {
  const availability = props.availability!
  const zoneAreas = tablesForZone(availability.areas, props.selectedZone)
  const availableCount = availability.areas.flatMap((area) => area.tables).filter((table) => table.status === 'available').length
  return (
    <section className="reservation-step reservation-seat-step" aria-labelledby="reservation-seat-title">
      <div className="reservation-title-row is-compact">
        <button className="reservation-back" type="button" aria-label="返回时间选择" onClick={props.onBack}><ChevronLeft size={20} /></button>
        <div><p>AVAILABLE TABLES</p><h1 id="reservation-seat-title">选一种预约方式</h1></div>
        <strong className="reservation-count">余 {availableCount} 桌</strong>
      </div>

      <div className="reservation-mode-grid">
        <button type="button" disabled={availableCount === 0} onClick={() => props.onChooseMode('direct')}>
          <strong>直接预约</strong><small>系统安排合适位置</small>
        </button>
        <button className={props.draft.mode === 'self_select' ? 'is-selected' : ''} type="button" onClick={() => props.onChooseMode('self_select')}>
          <strong>座位自选</strong><small>查看低消和位置</small>
        </button>
      </div>

      {props.draft.mode === 'self_select' && (
        <>
          <div className="reservation-zone-tabs" role="tablist" aria-label="座位区域">
            {ZONES.map((zone) => (
              <button
                type="button"
                role="tab"
                aria-selected={props.selectedZone === zone}
                className={props.selectedZone === zone ? 'is-active' : ''}
                onClick={() => props.onZoneChange(zone)}
                key={zone}
              >{zoneLabel(zone)}</button>
            ))}
          </div>
          <div className="reservation-legend" aria-label="桌位状态说明">
            <span><i className="is-available" />可预约</span>
            <span><i className="is-reserved" />已预订</span>
            <span><i className="is-locked" />临时锁定</span>
          </div>
          <div className="reservation-area-list">
            {zoneAreas.length === 0 ? (
              <p className="reservation-empty">这个区域当前没有适合{props.draft.guestCount}位的桌位</p>
            ) : zoneAreas.map((area) => (
              <section className="reservation-area" aria-label={area.name} key={area.code}>
                <h2>{area.name}</h2>
                <div className="reservation-table-grid">
                  {area.tables.map((table) => (
                    <button
                      type="button"
                      className={`reservation-table is-${table.status}${props.draft.tableCodes.includes(table.code) ? ' is-selected' : ''}`}
                      aria-pressed={props.draft.tableCodes.includes(table.code)}
                      onClick={() => props.onChooseTable(table)}
                      key={table.code}
                    >
                      <strong>{table.code}</strong><small>{table.capacity}位</small>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
          {props.focusedTable !== null && (
            <div className="reservation-table-detail" aria-live="polite">
              <span><strong>{props.focusedTable.code}</strong> · {props.focusedTable.capacity}位</span>
              <span>{formatMoney(props.focusedTable.minimumSpendMinor, props.focusedTable.currency)}</span>
              <em>{tableStatusLabel(props.focusedTable.status)}</em>
            </div>
          )}
          <div className="reservation-sticky-action">
            <span>{props.draft.tableCodes.length === 0 ? '请选择桌位' : `已选 ${props.draft.tableCodes.join('、')}`}</span>
            <button type="button" disabled={props.draft.tableCodes.length === 0} onClick={props.onContinue}>下一步</button>
          </div>
        </>
      )}

      {availableCount === 0 && (
        <button className="reservation-secondary is-full" type="button" onClick={props.onJoinWaitlist}>没有合适位置，先加入候补</button>
      )}
    </section>
  )
}

function ConfirmStep(props: ReservationBookingViewProps & { busy: boolean }) {
  const selectedTables = props.draft.mode === 'direct' ? '由门店安排' : props.draft.tableCodes.join('、')
  const slot = props.slots.find((item) => item.value === props.draft.time)
  return (
    <section className="reservation-step" aria-labelledby="reservation-confirm-title">
      <div className="reservation-title-row is-compact">
        <button className="reservation-back" type="button" aria-label="返回座位选择" onClick={props.onBack}><ChevronLeft size={20} /></button>
        <div><p>{props.joinWaitlist ? 'WAITLIST' : 'CONFIRM'}</p><h1 id="reservation-confirm-title">{props.joinWaitlist ? '登记候补' : '确认预约'}</h1></div>
      </div>
      <dl className="reservation-summary">
        <div><dt>到店</dt><dd>{props.draft.date} · {slot?.label ?? '--:--'}</dd></div>
        <div><dt>人数</dt><dd>{props.draft.guestCount}位</dd></div>
        <div><dt>位置</dt><dd>{props.joinWaitlist ? '有位后联系' : selectedTables}</dd></div>
      </dl>
      <div className="reservation-contact-grid">
        <label>预约姓名<input value={props.draft.customerName} maxLength={128} autoComplete="name" onChange={(event) => props.onDraftChange({ customerName: event.target.value })} /></label>
        {props.reservation === null && (
          <label>手机或微信<input value={props.draft.contact} maxLength={256} autoComplete="tel" onChange={(event) => props.onDraftChange({ contact: event.target.value })} /></label>
        )}
        <label>备注（选填）<textarea value={props.draft.note} maxLength={1000} rows={2} placeholder="生日、到店需求等" onChange={(event) => props.onDraftChange({ note: event.target.value })} /></label>
      </div>
      {!props.joinWaitlist && props.availability?.depositRule.enabled === true && (
        <p className="reservation-deposit">
          {props.availability.depositRule.mode === 'minimum_spend_ratio' && props.draft.mode === 'direct'
            ? '预约定金将按门店最终安排位置计算'
            : `预约定金 ${formatMoney(props.availability.depositRule.amountMinor).replace('最低消费 ', '')}`}
          {props.availability.depositRule.ruleText === null ? '' : ` · ${props.availability.depositRule.ruleText}`}
        </p>
      )}
      <p className="reservation-hint">座位提交后保留{props.availability?.holdMinutes ?? 20}分钟，请留意门店确认。</p>
      <button className="reservation-primary" type="button" disabled={props.busy || !props.sessionReady} onClick={props.onSubmit}>
        {props.busy ? <LoaderCircle className="is-spinning" size={18} aria-hidden="true" /> : <Check size={18} aria-hidden="true" />}
        {props.busy ? '正在提交' : props.joinWaitlist ? '确认加入候补' : '确认预约'}
      </button>
    </section>
  )
}

function CompleteStep(props: ReservationBookingViewProps & { busy: boolean }) {
  const record = props.reservation ?? props.waitlist
  if (record === null) return <section className="reservation-step"><p className="reservation-empty">预约信息暂时无法显示</p></section>
  const isReservation = props.reservation !== null
  const cancelled = record.status === 'cancelled'
  return (
    <section className="reservation-step reservation-complete" aria-labelledby="reservation-complete-title">
      <span className={cancelled ? 'reservation-result-icon is-cancelled' : 'reservation-result-icon'}>
        {cancelled ? <X size={26} /> : <Check size={26} />}
      </span>
      <p>{isReservation ? 'YOUR RESERVATION' : 'WAITLIST'}</p>
      <h1 id="reservation-complete-title">{cancelled ? '已取消' : isReservation ? '预约已提交' : '候补已登记'}</h1>
      <dl className="reservation-summary">
        <div><dt>编号</dt><dd>{record.publicId}</dd></div>
        <div><dt>到店</dt><dd>{formatDateTime(isReservation ? props.reservation!.arrivalAt : props.waitlist!.desiredArrivalAt)}</dd></div>
        <div><dt>人数</dt><dd>{record.guestCount}位</dd></div>
        <div><dt>联系</dt><dd>{record.maskedContact}</dd></div>
        {isReservation && <div><dt>位置</dt><dd>{props.reservation!.tableCodes.join('、') || '门店安排'}</dd></div>}
      </dl>
      {!cancelled && isReservation && props.reservation!.status === 'pending' && (
        <p className={props.holdSeconds > 0 ? 'reservation-hold' : 'reservation-hold is-expired'}>
          {props.holdSeconds > 0 ? `座位保留 ${formatCountdown(props.holdSeconds)}` : '座位保留时间已结束，请重新选择'}
        </p>
      )}
      {!cancelled && (
        <div className="reservation-complete-actions">
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
  const active = step === 'schedule' ? 1 : step === 'seat' ? 2 : 3
  return (
    <ol className="reservation-progress" aria-label="预约进度">
      {['时间人数', '选择桌位', '确认预约'].map((label, index) => (
        <li className={index + 1 <= active ? 'is-active' : ''} key={label}><span>{index + 1}</span>{label}</li>
      ))}
    </ol>
  )
}

function createDraft(date: string, time: string): ReservationDraft {
  return { date, time, guestCount: 2, mode: 'direct', tableCodes: [], customerName: '', contact: '', note: '' }
}

function firstZone(availability: ReservationAvailability): ReservationZone | null {
  return ZONES.find((zone) => tablesForZone(availability.areas, zone).length > 0) ?? null
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
