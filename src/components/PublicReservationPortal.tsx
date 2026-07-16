import { CalendarDays, CheckCircle2, LoaderCircle, MapPin, RefreshCw, UsersRound } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { createPublicReservation, listPublicReservations } from '../public-reservation-api'
import type { PublicReservationListResponse } from '../shared/public-reservation-contracts'
import type { ReservationOccasionCode, ReservationStatus } from '../shared/reservation-contracts'
import './PublicReservationPortal.css'

const statusNames: Record<ReservationStatus, string> = {
  requested: '待门店确认',
  confirmed: '已确认',
  arrived: '已到店',
  seated: '已入座',
  cancelled: '已取消',
  no_show: '未到店',
}

function defaultDate() {
  const value = new Date()
  value.setDate(value.getDate() + 1)
  return value.toISOString().slice(0, 10)
}

function scheduledIso(date: string, time: string) {
  const value = new Date(`${date}T${time}:00`)
  if (!Number.isFinite(value.getTime())) throw new Error('请选择有效预约时间')
  return value.toISOString()
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}

export function PublicReservationPortal() {
  const [data, setData] = useState<PublicReservationListResponse | null>(null)
  const [customerName, setCustomerName] = useState('')
  const [partySize, setPartySize] = useState(2)
  const [date, setDate] = useState(defaultDate)
  const [time, setTime] = useState('20:00')
  const [areaPreferenceCode, setAreaPreferenceCode] = useState('')
  const [occasionCode, setOccasionCode] = useState<'' | ReservationOccasionCode>('')
  const [occasionNote, setOccasionNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await listPublicReservations())
      setError('')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '预约数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const areaNames = useMemo(() => new Map(data?.config.areaPreferences.map((item) => [item.code, item.name])), [data?.config.areaPreferences])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    setNotice('')
    try {
      await createPublicReservation({
        customerName: customerName.trim(),
        partySize,
        scheduledAt: scheduledIso(date, time),
        areaPreferenceCode: areaPreferenceCode || undefined,
        occasionCode: occasionCode || undefined,
        occasionNote: occasionNote.trim() || undefined,
        idempotencyKey: `public-reservation-${crypto.randomUUID()}`,
      })
      setNotice('预约已提交，门店确认后本页会更新状态。')
      setOccasionNote('')
      await load()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '预约提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="public-reservation-shell">
      <header className="public-reservation-header">
        <div className="public-reservation-brand"><span>M</span><div><strong>M-BOX</strong><small>陆家嘴店</small></div></div>
        <CalendarDays size={22} />
      </header>

      <section className="public-reservation-intro">
        <span>线上预约</span>
        <h1>预约到店</h1>
        <p>提交后由门店确认，入桌后扫描桌上二维码呼叫服务。</p>
      </section>

      {notice && <div className="public-reservation-notice" role="status"><CheckCircle2 size={19} />{notice}</div>}
      {error && <div className="error-banner" role="alert">{error}</div>}

      <form className="public-reservation-form" onSubmit={submit}>
        <div className="public-reservation-section-title"><strong>预约信息</strong><span>门店确认后生效</span></div>
        <label><span>预约称呼</span><input required maxLength={100} placeholder="例如：Amy" value={customerName} onChange={(event) => setCustomerName(event.target.value)} /></label>
        <div className="public-reservation-field-row">
          <label><span>人数</span><input required type="number" min={data?.config.minimumPartySize ?? 1} max={data?.config.maximumPartySize ?? 100} value={partySize} onChange={(event) => setPartySize(Number(event.target.value))} /></label>
          <label><span>区域偏好</span><select value={areaPreferenceCode} onChange={(event) => setAreaPreferenceCode(event.target.value)}><option value="">不限区域</option>{data?.config.areaPreferences.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
        </div>
        <div className="public-reservation-field-row">
          <label><span>日期</span><input required type="date" min={new Date().toISOString().slice(0, 10)} value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <label><span>时间</span><input required type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
        </div>
        <label><span>到店场景</span><select value={occasionCode} onChange={(event) => setOccasionCode(event.target.value as '' | ReservationOccasionCode)}><option value="">普通到店</option>{data?.config.occasions.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
        <label><span>备注</span><input maxLength={500} placeholder="例如：生日，希望21:30安排生日歌" value={occasionNote} onChange={(event) => setOccasionNote(event.target.value)} /></label>
        <button className="public-reservation-submit" type="submit" disabled={submitting || loading}>{submitting ? <LoaderCircle className="spin" size={18} /> : <CalendarDays size={18} />}提交预约</button>
      </form>

      <section className="public-reservation-history">
        <div className="public-reservation-section-title"><strong>我的预约</strong><button type="button" title="刷新" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={17} /></button></div>
        {!loading && !data?.reservations.length && <div className="public-reservation-empty">本设备暂无预约</div>}
        {data?.reservations.map((reservation) => (
          <article key={reservation.id}>
            <div><strong>{formatDateTime(reservation.scheduledAt)}</strong><span className={`public-reservation-status is-${reservation.status}`}>{statusNames[reservation.status]}</span></div>
            <p><UsersRound size={15} />{reservation.partySize}人 <MapPin size={15} />{reservation.tableCode ?? areaNames.get(reservation.areaPreferenceCode ?? '') ?? '区域待定'}</p>
            {reservation.occasionNote && <small>{reservation.occasionNote}</small>}
          </article>
        ))}
      </section>
    </main>
  )
}
