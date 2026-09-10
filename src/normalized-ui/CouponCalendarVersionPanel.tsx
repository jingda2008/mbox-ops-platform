import { useEffect, useRef, useState } from 'react'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import { NumberInputWithUnit } from './NumberInputWithUnit'
import { executeRecoverableCommand } from './recoverable-command'
import { createIdempotencyKey } from './cashier-mutation'
import { useConfirmationDialog } from './ConfirmationDialog'

export interface CalendarVersion {
  id: string; code: string; version: number; status: 'draft' | 'approved' | 'published' | 'stopped'
  createdByEmployeeId: string; decisions: Array<{ action: string; employeeId: string }>
  rule: { timezone: string; dateBasis: string; businessDayStartMinute: number; dateFrom: string; dateThrough: string
    validFrom: string; validUntil: string; weekdays: number[]; weekStartsOn: number
    relativeValidity?: {days:number;basis:'elapsed'|'natural_end'|'business_end'}
    windows: Array<{ startMinute: number; endMinute: number }>; excludedDates: string[] }
  limits: { perCustomerDay: number | null; perCustomerWeek: number | null; perCustomerCampaign: number | null }
}
const statusNames = { draft: '草稿', approved: '待发布', published: '已发布', stopped: '已停发' }
export function CouponCalendarVersionPanel({ api, auth, inputRevision, readRule, onLoad, onWriting }: {
  api: NormalizedApiClient; auth: StaffAuthView; inputRevision: number; readRule: () => unknown
  onLoad: (rule: CalendarVersion['rule']) => void; onWriting: (writing: boolean) => void
}) {
  const [code, setCode] = useState('')
  const [version, setVersion] = useState(0)
  const [limits, setLimits] = useState({ perCustomerDay: '', perCustomerWeek: '', perCustomerCampaign: '' })
  const [reason, setReason] = useState('')
  const [items, setItems] = useState<CalendarVersion[]>([])
  const [selected, setSelected] = useState<CalendarVersion | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const generation = useRef(0)
  const { confirmAction } = useConfirmationDialog()
  useEffect(() => { setSelected(null); setMessage('') }, [inputRevision])
  useEffect(() => () => { generation.current += 1 }, [])
  const path = '/api/staff/loyalty/coupon-calendar-versions'
  async function load() {
    const current = ++generation.current; setBusy(true); setMessage('')
    try { const result = await api.getEndpoint<{ data: CalendarVersion[] }>(path); if (current === generation.current) setItems(result.data) }
    catch (error) { if (current === generation.current) setMessage(error instanceof Error ? error.message : '读取失败，请重试') }
    finally { if (current === generation.current) setBusy(false) }
  }
  function open(item: CalendarVersion) {
    setSelected(item); setCode(item.code); setVersion(item.version); setReason(''); setMessage('')
    setLimits({ perCustomerDay: String(item.limits.perCustomerDay ?? ''), perCustomerWeek: String(item.limits.perCustomerWeek ?? ''), perCustomerCampaign: String(item.limits.perCustomerCampaign ?? '') })
    onLoad(item.rule)
  }
  function remember(item: CalendarVersion) { setSelected(item); setVersion(item.version); setItems(previous => [item, ...previous.filter(old => old.id !== item.id)].slice(0,30)) }
  async function save() {
    const current = ++generation.current; setBusy(true); onWriting(true); setMessage('')
    try {
      const parsedLimits = Object.fromEntries(Object.entries(limits).map(([key, value]) => {
        if (value !== '' && !/^[1-9]\d{0,6}$/.test(value)) throw new Error('次数须填写正整数，留空表示不额外限制')
        return [key, value === '' ? null : Number(value)]
      }))
      const body = { code, rule: readRule(), limits: parsedLimits, expectedVersion: version, reason }
      const result = await executeRecoverableCommand(`${auth.employee.id}:${path}`, body, createIdempotencyKey('coupon-calendar'), key => api.postEndpoint<CalendarVersion>(path, body, { idempotencyKey: key }))
      if (current === generation.current) { remember(result); setMessage(`已保存 ${result.code} 第${result.version}版草稿，未发布、未发券。`) }
    } catch (error) { if (current === generation.current) setMessage(error instanceof Error ? error.message : '保存结果未确认，可重试核对') }
    finally { if (current === generation.current) { setBusy(false); onWriting(false) } }
  }
  async function decide(action: 'approve' | 'publish' | 'stop_issuing') {
    if (!selected) return
    const label = { approve: '审批', publish: '发布', stop_issuing: '停发' }[action]
    const target = selected
    if (!await confirmAction({ title: `确认${label} ${target.code} 第${target.version}版`, description: action === 'stop_issuing' ? '只停止新券绑定本版本；已发券继续按原承诺使用。' : '操作只针对已保存版本。发布不会自动发券；新发券仍需选择该规则，并受独立发放权限与额度控制。', confirmLabel: `确认${label}` })) return
    const current = ++generation.current; setBusy(true); onWriting(true); setMessage('')
    try { const result = await api.postEndpoint<CalendarVersion>(`${path}/${target.id}/decisions`, { action, reason }); if (current === generation.current) { remember(result); setMessage(`${target.code} 第${target.version}版${label}已记录。`) } }
    catch (error) { if (current === generation.current) setMessage(error instanceof Error ? error.message : '操作结果未确认，请重新读取') }
    finally { if (current === generation.current) { setBusy(false); onWriting(false) } }
  }
  return <section aria-label="券时间规则版本管理">
    <p>保存日期规则和独立次数限制。编辑、审批、发布须分人完成；不会自动发券或改变旧券。使用新活动编号会开始新活动计数，不应用于绕过同一活动限额。</p>
    <button type="button" disabled={busy} onClick={() => void load()}>读取最近30个时间规则版本</button>
    {items.length > 0 && <label>选择时间规则版本<select disabled={busy} aria-label="选择时间规则版本" value={selected?.id ?? ''} onChange={event => { const item = items.find(value => value.id === event.target.value); if (item) open(item) }}><option value="">请选择</option>{items.map(item => <option key={item.id} value={item.id}>{item.code} · 第{item.version}版 · {statusNames[item.status]}</option>)}</select></label>}
    <fieldset disabled={busy}><legend>版本及次数</legend><div className="stacking-preview-grid">
      <label>活动规则编号<input value={code} maxLength={40} onChange={event => { setCode(event.target.value); setVersion(0); setSelected(null) }} /></label>
      {([['perCustomerDay','每人每日上限'],['perCustomerWeek','每人每周上限'],['perCustomerCampaign','每人活动期上限']] as const).map(([key,label]) => <label key={key}>{label}<NumberInputWithUnit unit="次" value={limits[key]} inputMode="numeric" onChange={event => { setSelected(null); setLimits(previous => ({ ...previous, [key]: event.target.value })) }} /></label>)}
      <label>本次版本操作原因<input value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></label>
    </div><p>限额留空为不额外限制，单张券仍受其发放总次数限制；同活动多版本、多张券共用每人限额，占用中的次数也计入。</p>
    {auth.permissions.includes('loyalty.configuration.edit') && <button type="button" disabled={reason.trim().length < 2} onClick={() => void save()}>保存时间规则第{version + 1}版</button>}
    {selected && <div><p>已选：{selected.code} 第{selected.version}版 · {statusNames[selected.status]}</p>
      {selected.status === 'draft' && selected.createdByEmployeeId !== auth.employee.id && auth.permissions.includes('loyalty.configuration.approve') && <button type="button" disabled={reason.trim().length < 2} onClick={() => void decide('approve')}>审批时间规则</button>}
      {selected.status === 'approved' && selected.createdByEmployeeId !== auth.employee.id && !selected.decisions.some(item => item.action === 'approve' && item.employeeId === auth.employee.id) && auth.permissions.includes('loyalty.policy.publish') && <button type="button" disabled={reason.trim().length < 2} onClick={() => void decide('publish')}>发布时间规则</button>}
      {selected.status === 'published' && auth.permissions.includes('loyalty.policy.publish') && <button type="button" disabled={reason.trim().length < 2} onClick={() => void decide('stop_issuing')}>停止此版本新发券</button>}
    </div>}</fieldset>
    {message && <p role="status">{message}</p>}
  </section>
}
