import {
  CalendarDays, Check, CheckCircle2, ChevronLeft, LoaderCircle, MapPin,
  MessageCircle, Pencil, Phone, RefreshCw, RotateCcw, UsersRound, X, XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  cancelPublicReservation,
  createPublicReservation,
  getPublicReservationAvailability,
  listPublicReservations,
  updatePublicReservation,
} from '../public-reservation-api'
import { PendingActionRegistry } from '../pending-action-registry'
import type {
  PublicReservationConfigView,
  PublicReservationListResponse,
  PublicReservationTableView,
  PublicReservationView,
} from '../shared/public-reservation-contracts'
import type {
  ReservationAssignmentMode,
  ReservationOccasionCode,
  ReservationStatus,
} from '../shared/reservation-contracts'
import './PublicReservationPortal.css'

const statusNames: Record<ReservationStatus, string> = {
  requested: '等门店确认',
  confirmed: '已为你留位',
  arrived: '已到店',
  seated: '已入座',
  cancelled: '已取消',
  no_show: '未到店',
}

const seatPositions: Record<string, [number, number]> = {
  VIP5: [14.6, 14.1], VIP4: [13.6, 20.4], VIP3: [14.3, 27.9], VIP2: [54.7, 31.2], VIP1: [68.1, 31],
  '666': [14, 34.5], '888': [14, 39.5],
  L07: [32, 24.5], L06: [40.3, 25.8], L03: [29.8, 28.5], L02: [33.9, 29.4], L01: [41.8, 30.5], L05: [57.9, 26.9], L04: [66.2, 27],
  A08: [28.2, 37.1], A07: [32.8, 37.1], A06: [37.9, 37.1], A05: [42.6, 37.1], A04: [47.2, 37.1], A03: [51.6, 37.1], A02: [57, 37.1], A01: [61.2, 37.1],
  B08: [28.2, 41.6], B07: [32.8, 41.6], B06: [37.9, 41.6], B05: [42.6, 41.6], B04: [47.2, 41.6], B03: [51.6, 41.6], B02: [57, 41.6], B01: [61.2, 41.6],
  S4: [67.8, 36.8], S1: [73.2, 38.9], S5: [67.8, 40.9], S2: [73.3, 42.9], S6: [67.8, 45], S3: [73.3, 47], S7: [67.8, 49.3],
  C07: [28.9, 49.6], C06: [32.9, 49.6], C05: [39.2, 49.6], C04: [43.3, 49.6], C03: [47.4, 49.6], C02: [57.5, 49.6], C01: [61.5, 49.6],
  W01: [29.2, 57.1], W02: [39.7, 57.1], W03: [45.6, 57.1], W04: [52.3, 57.1], W05: [58.3, 57.1], W06: [64.1, 57.1],
  W07: [53.9, 67.5], W08: [79.6, 59.3], W09: [65.8, 66], W10: [41.6, 72.8], W11: [51.9, 72.8],
  W12: [52.6, 81.2], W13: [41.7, 81.2], W14: [31, 81.2], W15: [52.6, 85.2], W16: [41.7, 85.2], W17: [31.1, 85.2],
  BAR1: [53.2, 19.4], BAR2: [58.4, 19.4], BAR3: [63.6, 19.4], BAR4: [68.8, 19.4],
}

type MapZone = 'indoor' | 'stage' | 'outdoor'

interface MapFrame {
  x: number
  y: number
  width: number
  height: number
}

interface MapZoneDefinition {
  code: MapZone
  name: string
  description: string
  frame: MapFrame
  matches: (tableCode: string) => boolean
}

const FLOOR_PLAN_WIDTH = 941
const FLOOR_PLAN_HEIGHT = 1672

const mapZones: MapZoneDefinition[] = [
  {
    code: 'indoor',
    name: '室内全景',
    description: 'VIP、L区、大厅与舞台侧',
    frame: { x: 6, y: 11, width: 88, height: 43 },
    matches: (code) => !code.startsWith('W'),
  },
  {
    code: 'stage',
    name: '舞台侧',
    description: '靠近舞台的互动位置',
    frame: { x: 42, y: 28, width: 53, height: 25 },
    matches: (code) => /^S[1-7]$/.test(code)
      || /^(?:VIP[12]|L0[1-5]|[ABC]0[1-2])$/.test(code),
  },
  {
    code: 'outdoor',
    name: '室外区域',
    description: 'W01-W17露台位置',
    frame: { x: 6, y: 52, width: 88, height: 40 },
    matches: (code) => /^W(?:0[1-9]|1[0-7])$/.test(code),
  },
]

function mapFrameStyle(frame: MapFrame) {
  return {
    aspectRatio: `${(frame.width * FLOOR_PLAN_WIDTH) / (frame.height * FLOOR_PLAN_HEIGHT)}`,
  }
}

function mapImageStyle(frame: MapFrame) {
  return {
    left: `${(-frame.x / frame.width) * 100}%`,
    top: `${(-frame.y / frame.height) * 100}%`,
    width: `${100 / frame.width * 100}%`,
    height: `${100 / frame.height * 100}%`,
  }
}

function mapSeatStyle(position: [number, number], frame: MapFrame) {
  return {
    left: `${((position[0] - frame.x) / frame.width) * 100}%`,
    top: `${((position[1] - frame.y) / frame.height) * 100}%`,
  }
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
    candidate += desired - Date.UTC(actualYear!, actualMonth! - 1, actualDay!, actualHour!, actualMinute!)
  }
  return new Date(candidate).toISOString()
}

function scheduledIso(date: string, time: string, config: PublicReservationConfigView) {
  const opening = clockMinutes(config.businessHours.openingTime)
  const closing = clockMinutes(config.businessHours.closingTime)
  const selected = clockMinutes(time)
  const calendarDate = closing < opening && selected < closing ? shiftDate(date, 1) : date
  return zonedLocalIso(calendarDate, time, config.businessHours.timeZone)
}

function businessDateFor(value: string, config: PublicReservationConfigView) {
  const local = zonedParts(value, config.businessHours.timeZone)
  const opening = clockMinutes(config.businessHours.openingTime)
  const closing = clockMinutes(config.businessHours.closingTime)
  return closing < opening && clockMinutes(local.time) < closing ? shiftDate(local.date, -1) : local.date
}

function slotOptions(config?: PublicReservationConfigView) {
  if (!config) return [{ value: '19:30', label: '19:30' }]
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

function money(value: number) {
  return `¥${(value / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`
}

export function PublicReservationPortal() {
  const [data, setData] = useState<PublicReservationListResponse | null>(null)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [assignmentMode, setAssignmentMode] = useState<ReservationAssignmentMode>('direct')
  const [availability, setAvailability] = useState<PublicReservationTableView[]>([])
  const [mapZone, setMapZone] = useState<MapZone>('indoor')
  const [selectedTableCode, setSelectedTableCode] = useState('')
  const [inspectedTableCode, setInspectedTableCode] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [phone, setPhone] = useState('')
  const [wechatId, setWechatId] = useState('')
  const [partySize, setPartySize] = useState(2)
  const [date, setDate] = useState(() => defaultDate())
  const [time, setTime] = useState('19:30')
  const [occasionCode, setOccasionCode] = useState<'' | ReservationOccasionCode>('')
  const [occasionNote, setOccasionNote] = useState('')
  const [editingId, setEditingId] = useState('')
  const [confirmingCancelId, setConfirmingCancelId] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingSeats, setLoadingSeats] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [busyReservationIds, setBusyReservationIds] = useState<ReadonlySet<string>>(() => new Set())
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const busyReservationIdsRef = useRef(new PendingActionRegistry())
  const loadSequenceRef = useRef(0)
  const seatDetailRef = useRef<HTMLElement | null>(null)

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
    setDate((current) => current || defaultDate(data.config.businessHours.timeZone))
  }, [data, editingId])

  const slots = useMemo(() => slotOptions(data?.config), [data?.config])
  const selectedDateOverride = data?.config.capacity.dateOverrides.find((item) => item.date === date)
  const closedWeekday = data ? data.config.businessHours.closedWeekdays.includes(new Date(`${date}T12:00:00.000Z`).getUTCDay()) : false
  const dateClosed = closedWeekday || selectedDateOverride?.enabled === false
  const acceptedContacts = new Set(data?.config.publicRules.acceptedContactMethods ?? ['phone', 'wechat'])
  const selectedTable = availability.find((table) => table.code === selectedTableCode)
  const inspectedTable = availability.find((table) => table.code === inspectedTableCode) ?? selectedTable

  function resetForm() {
    const config = data?.config
    setEditingId('')
    setStep(1)
    setAssignmentMode('direct')
    setSelectedTableCode('')
    setInspectedTableCode('')
    setCustomerName('')
    setPhone('')
    setWechatId('')
    setPartySize(Math.max(2, config?.minimumPartySize ?? 1))
    setDate(defaultDate(config?.businessHours.timeZone))
    setTime('19:30')
    setOccasionCode('')
    setOccasionNote('')
  }

  async function beginReservation(mode: ReservationAssignmentMode) {
    if (!data || dateClosed) return
    setAssignmentMode(mode)
    setError('')
    if (mode === 'direct') {
      setSelectedTableCode('')
      setStep(3)
      return
    }
    setLoadingSeats(true)
    try {
      const response = await getPublicReservationAvailability(scheduledIso(date, time, data.config), partySize)
      setAvailability(response.tables)
      setSelectedTableCode('')
      setMapZone('indoor')
      setInspectedTableCode(response.tables.find((table) => mapZones[0]!.matches(table.code) && table.status === 'available')?.code ?? '')
      setStep(2)
    } catch (availabilityError) {
      setError(availabilityError instanceof Error ? availabilityError.message : '桌位状态加载失败')
    } finally {
      setLoadingSeats(false)
    }
  }

  function chooseTable(table: PublicReservationTableView) {
    setInspectedTableCode(table.code)
    if (table.status === 'available') setSelectedTableCode(table.code)
    requestAnimationFrame(() => {
      seatDetailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  function chooseMapZone(zone: MapZone) {
    setMapZone(zone)
    const definition = mapZones.find((item) => item.code === zone)
    const next = availability.find((table) => definition?.matches(table.code) && table.status === 'available')
      ?? availability.find((table) => definition?.matches(table.code))
    setInspectedTableCode(next?.code ?? '')
  }

  function editReservation(reservation: PublicReservationView) {
    if (!data) return
    const local = zonedParts(reservation.scheduledAt, data.config.businessHours.timeZone)
    setEditingId(reservation.id)
    setAssignmentMode(reservation.assignmentMode)
    setSelectedTableCode(reservation.requestedTableCode ?? '')
    setInspectedTableCode(reservation.requestedTableCode ?? '')
    setCustomerName(reservation.customerName)
    setPhone(reservation.phone ?? '')
    setWechatId(reservation.wechatId ?? '')
    setPartySize(reservation.partySize)
    setDate(businessDateFor(reservation.scheduledAt, data.config))
    setTime(local.time)
    setOccasionCode(reservation.occasionCode ?? '')
    setOccasionNote(reservation.occasionNote)
    setStep(3)
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
    if (assignmentMode === 'self_select' && !selectedTableCode) {
      setError('请先选择一个可以预约的桌位。')
      return
    }
    setSubmitting(true)
    setError('')
    setNotice('')
    try {
      const common = {
        customerName: customerName.trim(),
        phone: phone.trim() || undefined,
        wechatId: wechatId.trim() || undefined,
        partySize,
        assignmentMode,
        requestedTableCode: assignmentMode === 'self_select' ? selectedTableCode : undefined,
        scheduledAt: scheduledIso(date, time, data.config),
        occasionCode: occasionCode || undefined,
        occasionNote: occasionNote.trim() || undefined,
        idempotencyKey: `public-reservation-${crypto.randomUUID()}`,
      }
      if (editingId) {
        await updatePublicReservation(editingId, { ...common, occasionCode: occasionCode || null })
        setNotice('已经替你改好啦，门店会按新时间和人数准备。')
      } else {
        await createPublicReservation(common)
        setNotice(assignmentMode === 'self_select'
          ? `已收到${selectedTableCode}预约申请，门店确认后会通知你。`
          : '预约申请已收到，门店会根据人数安排合适桌位。')
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
        reason: '客人行程有变，在线取消',
        idempotencyKey: `public-reservation-cancel-${crypto.randomUUID()}`,
      })
      setNotice('已经帮你取消，桌位也已释放；下次想来，随时再约。')
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

  return <main className={`public-reservation-shell is-step-${step}`}>
    <header className="public-reservation-header">
      <div className="public-reservation-brand"><span>M</span><div><strong>M-BOX LIVEHOUSE</strong><small>LUJIAZUI · SHANGHAI</small></div></div>
      <span className="public-reservation-channel">公众号预约</span>
    </header>

    <nav className="public-reservation-steps" aria-label="预约进度">
      <span className={step === 1 ? 'is-active' : step > 1 ? 'is-done' : ''}>1 时间人数</span>
      <span className={step === 2 ? 'is-active' : step > 2 ? 'is-done' : ''}>2 {assignmentMode === 'self_select' ? '选择桌位' : '门店安排'}</span>
      <span className={step === 3 ? 'is-active' : ''}>3 确认预约</span>
    </nav>

    {notice && <div className="public-reservation-notice" role="status"><CheckCircle2 size={19} />{notice}</div>}
    {error && <div className="public-reservation-error" role="alert"><XCircle size={19} />{error}</div>}

    {step === 1 && <section className="public-reservation-stage">
      <div className="public-reservation-intro">
        <span>RESERVATION</span><h1>今晚，给你留个好位置</h1>
        <p>先选择到店时间和人数；可以让门店安排，也可以自己在座位图上选。</p>
      </div>
      <section className="public-reservation-panel">
        <div className="public-reservation-section-title"><strong>选择日期</strong><CalendarDays size={18} /></div>
        <label className="public-reservation-date"><span>哪一天</span><input required type="date" min={today(data?.config.businessHours.timeZone)} value={date} onChange={(event) => setDate(event.target.value)} /></label>
        {dateClosed && <p className="public-reservation-inline-error">这一天暂停预约，换一天看看吧。</p>}
      </section>
      <section className="public-reservation-panel">
        <div className="public-reservation-section-title"><strong>预计到店</strong><span>座位保留20分钟</span></div>
        <div className="public-reservation-periods"><b>晚间演出</b><span>20:30开演，建议20:00前到店</span></div>
        <div className="public-reservation-times">
          {slots.map((slot) => <button type="button" key={slot.value} className={time === slot.value ? 'is-active' : ''} onClick={() => setTime(slot.value)}>{slot.label}</button>)}
        </div>
      </section>
      <section className="public-reservation-panel public-reservation-party">
        <div><strong>到店人数</strong><small>人多可由门店协调加座</small></div>
        <div><button type="button" aria-label="减少人数" onClick={() => setPartySize(Math.max(data?.config.minimumPartySize ?? 1, partySize - 1))}>−</button><b>{partySize} 位</b><button type="button" aria-label="增加人数" onClick={() => setPartySize(Math.min(data?.config.maximumPartySize ?? 100, partySize + 1))}>＋</button></div>
      </section>
    </section>}

    {step === 2 && <section className="public-reservation-stage is-seat-selection">
      <div className="public-reservation-intro">
        <span>AVAILABLE TABLES</span><h1>选个喜欢的位置</h1>
        <p>点桌号，即可查看预约状态、定金和最低消费。</p>
      </div>
      <div className="public-reservation-map-zones" role="tablist" aria-label="座位区域">
        {mapZones.map((zone) => <button
          key={zone.code}
          type="button"
          role="tab"
          aria-selected={mapZone === zone.code}
          className={mapZone === zone.code ? 'is-active' : ''}
          onClick={() => chooseMapZone(zone.code)}
        ><strong>{zone.name}</strong><small>{zone.description}</small></button>)}
      </div>
      <div className="public-reservation-map-legend"><span><i />可预约</span><span className="is-reserved"><i />已预订</span><span className="is-locked"><i />临时锁定</span></div>
      <div
        className={`public-reservation-map-viewport is-${mapZone}`}
        style={mapFrameStyle(mapZones.find((zone) => zone.code === mapZone)!.frame)}
      >
        <div className="public-reservation-map-world">
          <img
            src="/assets/mbox-floorplan-2026.webp"
            alt="M-BOX可预约座位图"
            style={mapImageStyle(mapZones.find((zone) => zone.code === mapZone)!.frame)}
          />
          {availability.filter((table) => mapZones.find((zone) => zone.code === mapZone)?.matches(table.code)).map((table) => {
            const position = seatPositions[table.code]
            if (!position) return null
            return <button
              key={table.id}
              type="button"
              aria-label={`${table.code} ${table.statusReason}`}
              className={`public-reservation-map-seat is-${table.status}${selectedTableCode === table.code ? ' is-selected' : ''}`}
              style={mapSeatStyle(position, mapZones.find((zone) => zone.code === mapZone)!.frame)}
              onClick={() => chooseTable(table)}
            >{table.code}</button>
          })}
        </div>
      </div>
      {inspectedTable && <section ref={seatDetailRef} className="public-reservation-seat-detail">
        <div><strong>{inspectedTable.displayName}</strong><span>{inspectedTable.capacity}位建议人数 · {inspectedTable.statusReason}</span><small>{inspectedTable.depositAmount ? `${money(inspectedTable.depositAmount)}定金可抵消费` : '免定金'} · {inspectedTable.minimumSpendAmount ? `最低消费${money(inspectedTable.minimumSpendAmount)}` : '无最低消费'}</small></div>
        <b className={`is-${inspectedTable.status}`}>{inspectedTable.status === 'available' ? '可预约' : inspectedTable.status === 'reserved' ? '已预订' : '暂不可选'}</b>
      </section>}
    </section>}

    {step === 3 && <form id="public-reservation-form" className="public-reservation-stage public-reservation-form" onSubmit={submit}>
      <div className="public-reservation-intro">
        <span>CONFIRM BOOKING</span><h1>确认预约安排</h1>
        <p>{assignmentMode === 'self_select' ? `已选择${selectedTableCode}，门店确认后正式留位。` : '提交后由门店根据人数和现场情况安排合适桌位。'}</p>
      </div>
      <section className="public-reservation-choice-summary">
        <div className="public-reservation-choice-icon">{assignmentMode === 'self_select' ? selectedTableCode : '安排'}</div>
        <div><strong>{assignmentMode === 'self_select' ? selectedTable?.displayName ?? selectedTableCode : '门店安排合适桌位'}</strong><span>{date} · {time} · {partySize}位</span><small>{assignmentMode === 'self_select' && selectedTable ? `${selectedTable.depositAmount ? `${money(selectedTable.depositAmount)}定金` : '免定金'} · ${selectedTable.minimumSpendAmount ? `最低消费${money(selectedTable.minimumSpendAmount)}` : '无最低消费'}` : '确认桌位后告知定金和最低消费'}</small></div>
      </section>
      <section className="public-reservation-panel public-reservation-contact">
        <div className="public-reservation-section-title"><strong>联系信息</strong>{editingId && <button className="public-reservation-text-button" type="button" onClick={resetForm}><RotateCcw size={14} />放弃修改</button>}</div>
        <label><span>怎么称呼你</span><input required maxLength={100} placeholder="例如：Amy" value={customerName} onChange={(event) => setCustomerName(event.target.value)} /></label>
        <div className="public-reservation-field-row">
          {acceptedContacts.has('phone') && <label><span><Phone size={13} />手机号</span><input inputMode="tel" autoComplete="tel" maxLength={24} placeholder="方便确认预约" value={phone} onChange={(event) => setPhone(event.target.value)} /></label>}
          {acceptedContacts.has('wechat') && <label><span><MessageCircle size={13} />微信号</span><input autoComplete="off" maxLength={128} placeholder="二选一即可" value={wechatId} onChange={(event) => setWechatId(event.target.value)} /></label>}
        </div>
        <label><span>这次有什么特别的</span><select value={occasionCode} onChange={(event) => setOccasionCode(event.target.value as '' | ReservationOccasionCode)}><option value="">轻松来坐坐</option>{data?.config.occasions.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
        <label><span>补充说明（选填）</span><input maxLength={500} placeholder="例如：生日，希望21:30安排生日歌" value={occasionNote} onChange={(event) => setOccasionNote(event.target.value)} /></label>
      </section>
      <p className="public-reservation-agreement">{assignmentMode === 'self_select'
        ? '提交后由门店确认桌位。需要定金时，确认金额和抵扣规则后再付款，不会自动扣费。'
        : '提交后由门店确认桌位、最低消费和定金；你确认后再付款，不会自动扣费。'}</p>
    </form>}

    {step === 1 && <section className="public-reservation-history">
      <div className="public-reservation-section-title"><strong>我的预约</strong><button type="button" title="刷新" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={17} /></button></div>
      {!loading && !data?.reservations.length && <div className="public-reservation-empty">这里还没有预约，选个喜欢的时间吧。</div>}
      {data?.reservations.map((reservation) => {
        const canChange = ['requested', 'confirmed'].includes(reservation.status)
        return <article key={reservation.id}>
          <div className="public-reservation-card-heading"><strong>{formatDateTime(reservation.scheduledAt, data.config.businessHours.timeZone)}</strong><span className={`public-reservation-status is-${reservation.status}`}>{statusNames[reservation.status]}</span></div>
          <p><UsersRound size={15} />{reservation.partySize}人 <MapPin size={15} />{reservation.tableCode ?? reservation.requestedTableCode ?? '门店安排'}</p>
          {reservation.occasionNote && <small>{reservation.occasionNote}</small>}
          {canChange && <div className="public-reservation-card-actions">
            <button type="button" onClick={() => editReservation(reservation)}><Pencil size={14} />修改</button>
            <button type="button" className={confirmingCancelId === reservation.id ? 'is-danger' : ''} disabled={busyReservationIds.has(reservation.id)} onClick={() => void cancelReservation(reservation)}>
              {busyReservationIds.has(reservation.id) ? <LoaderCircle className="spin" size={14} /> : confirmingCancelId === reservation.id ? <Check size={14} /> : <X size={14} />}
              {confirmingCancelId === reservation.id ? '确认取消' : '取消预约'}
            </button>
          </div>}
        </article>
      })}
    </section>}

    {step === 1 && <div className="public-reservation-actions">
      <button type="button" disabled={loading || loadingSeats || dateClosed} onClick={() => void beginReservation('direct')}>直接预约</button>
      <button className="is-primary" type="button" disabled={loading || loadingSeats || dateClosed} onClick={() => void beginReservation('self_select')}>{loadingSeats ? <LoaderCircle className="spin" size={17} /> : <MapPin size={17} />}座位自选</button>
    </div>}
    {step === 2 && <div className="public-reservation-actions">
      <button type="button" onClick={() => setStep(1)}><ChevronLeft size={17} />上一步</button>
      <button className="is-primary" type="button" disabled={!selectedTableCode} onClick={() => setStep(3)}>{selectedTableCode ? `选择${selectedTableCode}，下一步` : '请选择可预约桌位'}</button>
    </div>}
    {step === 3 && <div className="public-reservation-actions">
      <button type="button" onClick={() => setStep(assignmentMode === 'self_select' && !editingId ? 2 : 1)}><ChevronLeft size={17} />上一步</button>
      <button className="is-primary" type="submit" form="public-reservation-form" disabled={submitting || loading}>{submitting ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{editingId ? '保存修改' : '提交预约'}</button>
    </div>}
  </main>
}
