import {
  CalendarDays, Check, CheckCircle2, LoaderCircle, MapPin, MessageCircle,
  Banknote, Pencil, Phone, RefreshCw, RotateCcw, UsersRound, X, XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  cancelPublicReservation, createPublicReservation, listPublicReservations, updatePublicReservation,
} from '../public-reservation-api'
import { PendingActionRegistry } from '../pending-action-registry'
import type {
  PublicReservationConfigView, PublicReservationListResponse, PublicReservationView,
} from '../shared/public-reservation-contracts'
import type { ReservationOccasionCode, ReservationStatus } from '../shared/reservation-contracts'
import './PublicReservationPortal.css'

const statusNames: Record<ReservationStatus, string> = {
  requested: '等门店确认', confirmed: '已为你留位', arrived: '已到店', seated: '已入座', cancelled: '已取消', no_show: '未到店',
}

function clockMinutes(value: string) {
  const [hour = 0, minute = 0] = value.split(':').map(Number)
  return hour * 60 + minute
}

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function zonedParts(value: Date | string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(typeof value === 'string' ? new Date(value) : value)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ''
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` }
}

function today(timeZone = 'Asia/Shanghai') {
  return zonedParts(new Date(), timeZone).date
}

function defaultDate(timeZone = 'Asia/Shanghai') {
  return shiftDate(today(timeZone), 1)
}

function zonedLocalIso(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const desired = Date.UTC(year!, month! - 1, day!, hour!, minute!)
  let candidate = desired
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(candidate), timeZone)
    const [actualYear, actualMonth, actualDay] = actual.date.split('-').map(Number)
    const [actualHour, actualMinute] = actual.time.split(':').map(Number)
    const actualWallTime = Date.UTC(actualYear!, actualMonth! - 1, actualDay!, actualHour!, actualMinute!)
    candidate += desired - actualWallTime
  }
  return new Date(candidate).toISOString()
}

function scheduledIso(date: string, time: string, config: PublicReservationConfigView) {
  const opening = clockMinutes(config.businessHours.openingTime)
  const closing = clockMinutes(config.businessHours.closingTime)
  const selected = clockMinutes(time)
  const crossesMidnight = closing < opening
  const calendarDate = crossesMidnight && selected < closing ? shiftDate(date, 1) : date
  return zonedLocalIso(calendarDate, time, config.businessHours.timeZone)
}

function businessDateFor(value: string, config: PublicReservationConfigView) {
  const local = zonedParts(value, config.businessHours.timeZone)
  const opening = clockMinutes(config.businessHours.openingTime)
  const closing = clockMinutes(config.businessHours.closingTime)
  return closing < opening && clockMinutes(local.time) < closing ? shiftDate(local.date, -1) : local.date
}

function slotOptions(config?: PublicReservationConfigView) {
  if (!config) return ['12:00']
  const opening = clockMinutes(config.businessHours.openingTime)
  const closing = clockMinutes(config.businessHours.closingTime)
  const duration = closing > opening ? closing - opening : 1_440 - opening + closing
  const options: Array<{ value: string; label: string }> = []
  for (let elapsed = 0; elapsed < duration; elapsed += config.businessHours.slotMinutes) {
    const total = (opening + elapsed) % 1_440
    const value = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
    options.push({ value, label: elapsed >= 1_440 - opening ? `次日 ${value}` : value })
  }
  return options
}

function formatDateTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}

export function PublicReservationPortal() {
  const [data, setData] = useState<PublicReservationListResponse | null>(null)
  const [customerName, setCustomerName] = useState('')
  const [phone, setPhone] = useState('')
  const [wechatId, setWechatId] = useState('')
  const [partySize, setPartySize] = useState(2)
  const [date, setDate] = useState(() => defaultDate())
  const [time, setTime] = useState('12:00')
  const [areaPreferenceCode, setAreaPreferenceCode] = useState('')
  const [occasionCode, setOccasionCode] = useState<'' | ReservationOccasionCode>('')
  const [occasionNote, setOccasionNote] = useState('')
  const [editingId, setEditingId] = useState('')
  const [confirmingCancelId, setConfirmingCancelId] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [busyReservationIds, setBusyReservationIds] = useState<ReadonlySet<string>>(() => new Set())
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const busyReservationIdsRef = useRef(new PendingActionRegistry())
  const loadSequenceRef = useRef(0)

  const load = useCallback(async () => {
    const sequence = ++loadSequenceRef.current
    setLoading(true)
    try {
      const response = await listPublicReservations()
      if (sequence === loadSequenceRef.current) {
        setData(response)
        setError('')
      }
    } catch (loadError) {
      if (sequence === loadSequenceRef.current) setError(loadError instanceof Error ? loadError.message : '预约数据加载失败')
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!data || editingId) return
    setTime(data.config.businessHours.openingTime)
    setDate((current) => current || defaultDate(data.config.businessHours.timeZone))
  }, [data, editingId])

  const areaNames = useMemo(() => new Map(data?.config.areaPreferences.map((item) => [item.code, item.name])), [data?.config.areaPreferences])
  const slots = useMemo(() => slotOptions(data?.config), [data?.config])
  const selectedDateOverride = data?.config.capacity.dateOverrides.find((item) => item.date === date)
  const closedWeekday = data ? data.config.businessHours.closedWeekdays.includes(new Date(`${date}T12:00:00.000Z`).getUTCDay()) : false
  const dateClosed = closedWeekday || selectedDateOverride?.enabled === false
  const acceptedContacts = new Set(data?.config.publicRules.acceptedContactMethods ?? ['phone', 'wechat'])
  const selectedDepositRule = data?.config.depositPolicy.areaRules.find((rule) => rule.areaPreferenceCode === areaPreferenceCode)
  const depositPreview = data?.config.depositPolicy.enabled ? {
    amount: selectedDepositRule?.depositAmount ?? data.config.depositPolicy.defaultDepositAmount,
    minimumSpend: selectedDepositRule?.minimumSpendAmount ?? data.config.depositPolicy.defaultMinimumSpendAmount,
    deductibleRateBps: selectedDepositRule?.deductibleRateBps ?? data.config.depositPolicy.defaultDeductibleRateBps,
    notice: selectedDepositRule?.customerNotice || data.config.depositPolicy.customerNotice,
  } : null

  function resetForm() {
    const config = data?.config
    setEditingId('')
    setCustomerName('')
    setPhone('')
    setWechatId('')
    setPartySize(Math.max(2, config?.minimumPartySize ?? 1))
    setDate(defaultDate(config?.businessHours.timeZone))
    setTime(config?.businessHours.openingTime ?? '12:00')
    setAreaPreferenceCode('')
    setOccasionCode('')
    setOccasionNote('')
  }

  function editReservation(reservation: PublicReservationView) {
    if (!data) return
    const local = zonedParts(reservation.scheduledAt, data.config.businessHours.timeZone)
    setEditingId(reservation.id)
    setCustomerName(reservation.customerName)
    setPhone(reservation.phone ?? '')
    setWechatId(reservation.wechatId ?? '')
    setPartySize(reservation.partySize)
    setDate(businessDateFor(reservation.scheduledAt, data.config))
    setTime(local.time)
    setAreaPreferenceCode(reservation.areaPreferenceCode ?? '')
    setOccasionCode(reservation.occasionCode ?? '')
    setOccasionNote(reservation.occasionNote)
    setNotice('正在修改这笔预约，改好后点“保存修改”。')
    setError('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!data) return
    if (!phone.trim() && !wechatId.trim()) {
      setError('留一个手机号或微信号吧，门店确认预约时才能找到你。')
      return
    }
    if (dateClosed) {
      setError('这一天门店暂停预约，换一天再来吧。')
      return
    }
    setSubmitting(true)
    setError('')
    setNotice('')
    try {
      const common = {
        customerName: customerName.trim(), phone: phone.trim() || undefined, wechatId: wechatId.trim() || undefined,
        partySize, scheduledAt: scheduledIso(date, time, data.config),
        areaPreferenceCode: areaPreferenceCode || undefined,
        occasionCode: occasionCode || undefined, occasionNote: occasionNote.trim() || undefined,
        idempotencyKey: `public-reservation-${crypto.randomUUID()}`,
      }
      if (editingId) {
        await updatePublicReservation(editingId, { ...common, occasionCode: occasionCode || null })
        setNotice('已经替你改好啦，门店会按新时间和人数准备。')
      } else {
        await createPublicReservation(common)
        setNotice('收到啦，门店确认后，这里会变成“已为你留位”。')
      }
      resetForm()
      await load()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : editingId ? '预约修改失败' : '预约提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function cancelReservation(reservation: PublicReservationView) {
    if (confirmingCancelId !== reservation.id) {
      setConfirmingCancelId(reservation.id)
      return
    }
    if (!busyReservationIdsRef.current.begin(reservation.id)) return
    setBusyReservationIds(busyReservationIdsRef.current.snapshot())
    setError('')
    try {
      await cancelPublicReservation(reservation.id, {
        reason: '客人行程有变，在线取消', idempotencyKey: `public-reservation-cancel-${crypto.randomUUID()}`,
      })
      setNotice('已经帮你取消，不占着位置；下次想来，随时再约。')
      setConfirmingCancelId('')
      if (editingId === reservation.id) resetForm()
      await load()
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : '取消没有成功，请稍后再试')
    } finally {
      busyReservationIdsRef.current.finish(reservation.id)
      setBusyReservationIds(busyReservationIdsRef.current.snapshot())
    }
  }

  return <main className="public-reservation-shell">
    <header className="public-reservation-header">
      <div className="public-reservation-brand"><span>M</span><div><strong>M-BOX</strong><small>陆家嘴店</small></div></div>
      <CalendarDays size={22} />
    </header>

    <section className="public-reservation-intro">
      <span>线上预约</span><h1>今晚，给你留个好位置</h1>
      <p>提交后由门店确认；有生日、聚会或特别安排，提前告诉我们。</p>
    </section>

    {notice && <div className="public-reservation-notice" role="status"><CheckCircle2 size={19} />{notice}</div>}
    {error && <div className="public-reservation-error" role="alert"><XCircle size={19} />{error}</div>}

    <form className="public-reservation-form" onSubmit={submit}>
      <div className="public-reservation-section-title">
        <strong>{editingId ? '修改预约' : '预约信息'}</strong>
        {editingId ? <button className="public-reservation-text-button" type="button" onClick={resetForm}><RotateCcw size={14} />放弃修改</button> : <span>门店确认后生效</span>}
      </div>
      <label><span>怎么称呼你</span><input required maxLength={100} placeholder="例如：Amy" value={customerName} onChange={(event) => setCustomerName(event.target.value)} /></label>
      <div className="public-reservation-field-row">
        {acceptedContacts.has('phone') && <label><span><Phone size={13} />手机号</span><input inputMode="tel" autoComplete="tel" maxLength={24} placeholder="方便确认预约" value={phone} onChange={(event) => setPhone(event.target.value)} /></label>}
        {acceptedContacts.has('wechat') && <label><span><MessageCircle size={13} />微信号</span><input autoComplete="off" maxLength={128} placeholder="二选一即可" value={wechatId} onChange={(event) => setWechatId(event.target.value)} /></label>}
      </div>
      <div className="public-reservation-field-row is-compact">
        <label><span>人数</span><input required type="number" min={data?.config.minimumPartySize ?? 1} max={data?.config.maximumPartySize ?? 100} value={partySize} onChange={(event) => setPartySize(Number(event.target.value))} /></label>
        <label><span>区域偏好</span><select value={areaPreferenceCode} onChange={(event) => setAreaPreferenceCode(event.target.value)}><option value="">不限区域</option>{data?.config.areaPreferences.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
      </div>
      <div className="public-reservation-field-row">
        <label><span>哪一天</span><input required type="date" min={today(data?.config.businessHours.timeZone)} value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label><span>几点到</span><select required value={time} onChange={(event) => setTime(event.target.value)}>{slots.map((slot) => typeof slot === 'string' ? <option key={slot}>{slot}</option> : <option key={slot.value} value={slot.value}>{slot.label}</option>)}</select></label>
      </div>
      {dateClosed && <p className="public-reservation-inline-error">这一天暂停预约，换一天看看吧。</p>}
      <label><span>这次有什么特别的</span><select value={occasionCode} onChange={(event) => setOccasionCode(event.target.value as '' | ReservationOccasionCode)}><option value="">轻松来坐坐</option>{data?.config.occasions.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
      <label><span>悄悄告诉我们</span><input maxLength={500} placeholder="例如：生日，希望21:30安排生日歌" value={occasionNote} onChange={(event) => setOccasionNote(event.target.value)} /></label>
      {depositPreview && <div className="public-reservation-deposit"><Banknote size={18} /><div><strong>预约定金 ¥{(depositPreview.amount / 100).toFixed(2)}</strong><span>可抵消费 {(depositPreview.deductibleRateBps / 100).toFixed(0)}% · 此位置低消 ¥{(depositPreview.minimumSpend / 100).toFixed(2)}</span><small>{depositPreview.notice}</small></div></div>}
      <button className="public-reservation-submit" type="submit" disabled={submitting || loading || dateClosed}>{submitting ? <LoaderCircle className="spin" size={18} /> : editingId ? <Check size={18} /> : <CalendarDays size={18} />}{editingId ? '保存修改' : '提交预约'}</button>
    </form>

    <section className="public-reservation-history">
      <div className="public-reservation-section-title"><strong>我的预约</strong><button type="button" title="刷新" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={17} /></button></div>
      {!loading && !data?.reservations.length && <div className="public-reservation-empty">这里还没有预约，选个喜欢的时间吧。</div>}
      {data?.reservations.map((reservation) => {
        const canChange = ['requested', 'confirmed'].includes(reservation.status)
        return <article key={reservation.id}>
          <div className="public-reservation-card-heading"><strong>{formatDateTime(reservation.scheduledAt, data.config.businessHours.timeZone)}</strong><span className={`public-reservation-status is-${reservation.status}`}>{statusNames[reservation.status]}</span></div>
          <p><UsersRound size={15} />{reservation.partySize}人 <MapPin size={15} />{reservation.tableCode ?? areaNames.get(reservation.areaPreferenceCode ?? '') ?? '区域待定'}</p>
          {reservation.occasionNote && <small>{reservation.occasionNote}</small>}
          {canChange && <div className="public-reservation-card-actions">
            <button type="button" disabled={busyReservationIds.has(reservation.id)} onClick={() => editReservation(reservation)}><Pencil size={14} />修改</button>
            {confirmingCancelId === reservation.id
              ? <><button className="is-danger" type="button" disabled={busyReservationIds.has(reservation.id)} onClick={() => void cancelReservation(reservation)}>{busyReservationIds.has(reservation.id) ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}确认取消</button><button type="button" onClick={() => setConfirmingCancelId('')}><X size={14} />保留预约</button></>
              : <button type="button" disabled={busyReservationIds.has(reservation.id)} onClick={() => void cancelReservation(reservation)}><X size={14} />取消</button>}
          </div>}
        </article>
      })}
    </section>
  </main>
}
