import { useEffect, useRef, useState } from 'react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import { CouponCalendarVersionPanel, type CalendarVersion } from './CouponCalendarVersionPanel'
import { NumberInputWithUnit } from './NumberInputWithUnit'
import './stacking-price-preview-panel.css'

interface CalendarPreview {
  available: boolean; hasUsableWindow: boolean; nextAvailableAt: string | null; lastAvailableUntil: string | null
  calendar: Array<{ date: string; reasons?:string[]; windows: Array<{ from: string; until: string }> }>
  nextCalendarDate: string | null
}
function minute(value: string, allowMidnightEnd = false): number {
  if (allowMidnightEnd && value === '24:00') return 1440
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('请填写有效时刻')
  const [hours, minutes] = value.split(':').map(Number)
  return hours! * 60 + minutes!
}
function localTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value))
}
export function CouponCalendarPreviewPanel({ api, auth }: { api: NormalizedApiClient; auth: StaffAuthView }) {
  const [form, setForm] = useState({ from: '', through: '', until: '', absoluteFrom: '', basis: 'natural', cutoff: '06:00',
    allDay: false, excluded: '', weekStartsOn: '1', relativeDays:'',relativeBasis:'elapsed',issuedAt:'' })
  const [windows, setWindows] = useState([{ start: '21:00', end: '02:00' }])
  const [weekdays, setWeekdays] = useState([1, 2, 3])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<CalendarPreview | null>(null)
  const [inputRevision, setInputRevision] = useState(0)
  const [writing, setWriting] = useState(false)
  const generation = useRef(0)
  useEffect(() => () => { generation.current += 1 }, [])
  function invalidate() { generation.current += 1; setInputRevision(previous => previous + 1); setBusy(false); setResult(null); setError('') }
  function change<K extends keyof typeof form>(key: K, value: typeof form[K]) { invalidate(); setForm(previous => ({ ...previous, [key]: value })) }
  function readRule() {
      if (!form.from || !form.through || !form.until) throw new Error('请填写日期范围和含时间的绝对截止时间')
      const instant = (value: string) => new Date(`${value.length === 16 ? value + ':00' : value}+08:00`).toISOString()
      return { timezone: 'Asia/Shanghai', dateBasis: form.basis,
        businessDayStartMinute: form.basis === 'natural' ? 0 : minute(form.cutoff),
        dateFrom: form.from, dateThrough: form.through,
        validFrom: instant(form.absoluteFrom || `${form.from}T00:00`), validUntil: instant(form.until),
        weekdays, weekStartsOn: Number(form.weekStartsOn),
        windows: form.allDay ? [{ startMinute: 0, endMinute: 1440 }] : windows.map(window => ({ startMinute: minute(window.start), endMinute: minute(window.end, true) })),
        excludedDates: form.excluded.split(/[\s,，]+/).filter(Boolean),
        ...(form.relativeDays!==''?{relativeValidity:{days:Number(form.relativeDays),basis:form.relativeBasis}}:{}),
      }
  }
  function loadRule(rule: CalendarVersion['rule']) {
    generation.current += 1; setBusy(false); setResult(null); setError('')
    const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
    const localInstant = (value: string) => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0,23)
    setForm({ from: rule.dateFrom, through: rule.dateThrough, until: localInstant(rule.validUntil), absoluteFrom: localInstant(rule.validFrom),
      basis: rule.dateBasis, cutoff: clock(rule.businessDayStartMinute), allDay: false, excluded: rule.excludedDates.join('\n'), weekStartsOn: String(rule.weekStartsOn),relativeDays:rule.relativeValidity?String(rule.relativeValidity.days):'',relativeBasis:rule.relativeValidity?.basis??'elapsed',issuedAt:'' })
    setWindows(rule.windows.map(window => ({ start: clock(window.startMinute), end: clock(window.endMinute) })))
    setWeekdays(rule.weekdays)
  }
  async function preview(previewFrom?: string) {
    const current = ++generation.current
    setBusy(true); setError('')
    try {
      const rule = readRule()
      if(rule.relativeValidity&&!form.issuedAt)throw new Error('请填写模拟发放时间；实际发券使用服务端时间')
      const issuedAt=form.issuedAt?new Date(`${form.issuedAt.length===16?form.issuedAt+':00':form.issuedAt}+08:00`).toISOString():undefined
      const next = await api.postEndpoint<CalendarPreview>('/api/staff/loyalty/coupon-calendar-preview', { rule, previewFrom, days: 31,issuedAt })
      if (generation.current === current) setResult(next)
    } catch (failure) { if (generation.current === current) { setResult(null); setError(failure instanceof Error ? failure.message : '日历暂时无法生成，请重试') } }
    finally { if (generation.current === current) setBusy(false) }
  }
  return <details className="stacking-preview coupon-calendar-preview"><summary>优惠券可用日历预览</summary>
    <p>日历预览不会发布或发券。时间统一为北京时间；可用星期不代表每周自动增加次数。区间含开始、不含截止时刻。</p>
    <fieldset disabled={writing}><legend>使用时间条件</legend>
    <div className="stacking-preview-grid">
      <label>可用日期起<input type="date" value={form.from} onChange={event => change('from', event.target.value)} /></label>
      <label>可用日期止（含当天）<input type="date" value={form.through} onChange={event => change('through', event.target.value)} /></label>
      <label>绝对开始时间（可留空，取起始日零点）<input type="datetime-local" step="0.001" value={form.absoluteFrom} onChange={event => change('absoluteFrom', event.target.value)} /></label>
      <label>绝对截止时间（北京时间）<input type="datetime-local" step="0.001" value={form.until} onChange={event => change('until', event.target.value)} /></label>
      <label>日期归属<select aria-label="日期归属" value={form.basis} onChange={event => change('basis', event.target.value)}><option value="natural">自然日（零点换日）</option><option value="business">营业日（按指定时刻换日）</option></select></label>
      <label>发放后有效天数（留空仅按固定日期）<NumberInputWithUnit unit="天" inputMode="numeric" min={1} max={3660} step={1} value={form.relativeDays} onChange={event=>change('relativeDays',event.target.value)}/></label>
      {form.relativeDays!==''&&<><label>发放后有效期口径<select value={form.relativeBasis} onChange={event=>change('relativeBasis',event.target.value)}><option value="elapsed">每满24小时算一天</option><option value="natural_end">自然日结束（发放当日算第1天）</option><option value="business_end" disabled={form.basis!=='business'}>营业日结束（须先配置营业日）</option></select></label><label>模拟发放时间（北京时间）<input type="datetime-local" value={form.issuedAt} onChange={event=>change('issuedAt',event.target.value)}/></label></>}
      {form.basis === 'business' && <label>营业日换日时刻<input type="time" value={form.cutoff} onChange={event => change('cutoff', event.target.value)} /></label>}
      <label>每周计数起点<select value={form.weekStartsOn} onChange={event => change('weekStartsOn', event.target.value)}>{['一','二','三','四','五','六','日'].map((day, index) => <option key={day} value={index + 1}>星期{day}</option>)}</select></label>
    </div>
    <fieldset><legend>允许使用的星期</legend><div className="stacking-preview-switches">{['一','二','三','四','五','六','日'].map((day, index) => <label key={day}><input type="checkbox" checked={weekdays.includes(index + 1)} onChange={event => { invalidate(); setWeekdays(previous => event.target.checked ? [...previous, index + 1] : previous.filter(value => value !== index + 1)) }} />周{day}</label>)}</div></fieldset>
    <div className="stacking-preview-switches"><label><input type="checkbox" checked={form.allDay} onChange={event => change('allDay', event.target.checked)} />全天可用</label></div>
    {!form.allDay && <fieldset><legend>每日时间段（最多12段，重叠自动合并）</legend>
      {windows.map((window, index) => <div className="stacking-preview-grid" key={index}>
        <label>时段{index + 1}开始<input type="time" value={window.start} onChange={event => { invalidate(); setWindows(previous => previous.map((item, position) => position === index ? { ...item, start: event.target.value } : item)) }} /></label>
        <label>时段{index + 1}结束<input type="text" placeholder="02:00 或 24:00" maxLength={5} value={window.end} onChange={event => { invalidate(); setWindows(previous => previous.map((item, position) => position === index ? { ...item, end: event.target.value } : item)) }} /></label>
        {windows.length > 1 && <button type="button" onClick={() => { invalidate(); setWindows(previous => previous.filter((_, position) => position !== index)) }}>移除时段{index + 1}</button>}
      </div>)}
      <button type="button" disabled={windows.length >= 12} onClick={() => { invalidate(); setWindows(previous => [...previous, { start: '18:00', end: '20:00' }]) }}>添加时间段</button>
    </fieldset>}
    <p>结束早于开始代表跨午夜；营业日归属不会延长绝对截止时间。相对有效期从实际发放计算，与固定时间取交集；若期间没有可用时段则拒绝发券。模拟发放时间仅用于预览，不会被实际发券采用。</p>
    <label>排除日期（完整年月日，逗号或换行分隔）<textarea value={form.excluded} maxLength={40271} onChange={event => change('excluded', event.target.value)} /></label>
    <button type="button" disabled={busy} onClick={() => void preview()}>{busy ? '正在计算…' : '生成可用日历'}</button>
    </fieldset>
    <CouponCalendarVersionPanel api={api} auth={auth} inputRevision={inputRevision} readRule={readRule} onLoad={loadRule} onWriting={setWriting} />
    {error && <p role="alert">{error}</p>}
    {result && <div role="status">
      {!result.hasUsableWindow ? <p>没有任何可用时段，不能发布此规则。{[...new Set(result.calendar.flatMap(day=>day.reasons??[]))].join('；')}</p> : <>
        <p>下一次可用：{result.nextAvailableAt ? localTime(result.nextAvailableAt) : '已无后续可用时段'}；最后截止：{localTime(result.lastAvailableUntil!)}。</p>
        <ul className="coupon-calendar-days">{result.calendar.map(day => <li key={day.date}><strong>{day.date}</strong><span>{day.windows.length ? day.windows.map(window => `${localTime(window.from)} 至 ${localTime(window.until)}`).join('；') : (day.reasons?.join('；')??'无可用时段，原预览未返回具体规则原因')}</span></li>)}</ul>
        {result.nextCalendarDate && <button type="button" disabled={busy} onClick={() => void preview(result.nextCalendarDate!)}>查看后续日期</button>}
      </>}
    </div>}
  </details>
}
