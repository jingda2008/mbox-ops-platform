import { BellRing, Check, Clock3, DoorOpen, LoaderCircle, Plus, UserRoundX, UsersRound, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { actOnWaitlistEntry, createWaitlistEntry, listWaitlist, type WaitlistListResponse } from '../reservation-api'
import type { Area, Employee, Table } from '../shared/contracts'
import { formatChinaTime } from '../shared/china-time'
import { useRevealPanelScroll } from './use-reveal-panel-scroll'

interface Props {
  areas: Area[]
  tables: Table[]
  employees: Employee[]
  canManage: boolean
}

const emptyResponse: WaitlistListResponse = { entries: [], positions: {}, responseMinutes: 10 }

export function WaitlistPanel({ areas, tables, employees, canManage }: Props) {
  const [data, setData] = useState(emptyResponse)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [contact, setContact] = useState('')
  const [partySize, setPartySize] = useState(2)
  const [areaCode, setAreaCode] = useState('')
  const [maximumWaitMinutes, setMaximumWaitMinutes] = useState(90)
  const [salesEmployeeId, setSalesEmployeeId] = useState(employees[0]?.id ?? '')
  const createPanelRef = useRevealPanelScroll<HTMLFormElement>(showCreate ? 'waitlist-create' : '')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await listWaitlist())
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '候补队列加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!salesEmployeeId && employees[0]) setSalesEmployeeId(employees[0].id)
  }, [employees, salesEmployeeId])

  const activeEntries = useMemo(() => data.entries.filter((entry) => ['waiting', 'notified'].includes(entry.status)), [data.entries])
  const recentClosed = useMemo(() => data.entries.filter((entry) => !['waiting', 'notified'].includes(entry.status)).slice(-3).reverse(), [data.entries])

  async function run(key: string, action: () => Promise<unknown>, message: string) {
    setBusy(key)
    setNotice('')
    try {
      await action()
      await load()
      setNotice(message)
      return true
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '候补操作失败')
      return false
    } finally {
      setBusy('')
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim() || !contact.trim() || !salesEmployeeId) return setNotice('请填写客人称呼、CRM/企微客户编号和销售归属')
    if (/^1\d{10}$/.test(contact.trim())) return setNotice('禁止录入明文手机号，请使用CRM或企微客户编号')
    const created = await run('create', () => createWaitlistEntry({
      customerReference: `staff-ref:${contact.trim()}`,
      customerName: name.trim(),
      contactReference: `staff-ref:${contact.trim()}`,
      partySize,
      areaPreferenceCode: areaCode || undefined,
      salesEmployeeId,
      maximumWaitMinutes,
      idempotencyKey: key('join'),
    }), '候补已登记')
    if (created) {
      setName('')
      setContact('')
      setShowCreate(false)
    }
  }

  function recommendedTable(entryId: string) {
    const entry = data.entries.find((item) => item.id === entryId)
    if (!entry) return undefined
    return tables
      .filter((table) => table.status === 'available' && table.capacity >= entry.partySize)
      .filter((table) => !entry.areaPreferenceCode || table.areaId === entry.areaPreferenceCode)
      .toSorted((left, right) => left.capacity - right.capacity || left.code.localeCompare(right.code))
      .find((table) => !data.entries.some((other) =>
        other.status === 'waiting' && other.joinedSequence < entry.joinedSequence && other.partySize <= table.capacity &&
        (!other.areaPreferenceCode || other.areaPreferenceCode === table.areaId),
      ))
  }

  return <section className="waitlist-panel">
    <header className="waitlist-heading">
      <div><UsersRound size={18} /><span><strong>满台候补</strong><small>{activeEntries.length}组等待 · 通知后保留{data.responseMinutes}分钟</small></span></div>
      {canManage && <button className="primary-button" type="button" onClick={() => setShowCreate((current) => !current)}>{showCreate ? <X size={16} /> : <Plus size={16} />}{showCreate ? '关闭' : '登记候补'}</button>}
    </header>
    {notice && <div className="waitlist-notice">{notice}<button title="关闭" onClick={() => setNotice('')}><X size={14} /></button></div>}
    {showCreate && <form className="waitlist-create reveal-panel-target" ref={createPanelRef} onSubmit={submit}>
      <label><span>客人称呼</span><input autoFocus required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label><span>CRM/企微编号</span><input required maxLength={128} value={contact} onChange={(event) => setContact(event.target.value)} /></label>
      <label><span>人数</span><input required type="number" min={1} max={100} value={partySize} onChange={(event) => setPartySize(Number(event.target.value))} /></label>
      <label><span>最长等待</span><input required type="number" min={1} max={480} value={maximumWaitMinutes} onChange={(event) => setMaximumWaitMinutes(Number(event.target.value))} /></label>
      <label><span>销售归属</span><select required value={salesEmployeeId} onChange={(event) => setSalesEmployeeId(event.target.value)}><option value="">请选择销售</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label>
      <div className="waitlist-area-picks"><span>区域偏好</span><button type="button" className={!areaCode ? 'is-active' : ''} onClick={() => setAreaCode('')}>不限</button>{areas.map((area) => <button type="button" key={area.id} className={areaCode === area.id ? 'is-active' : ''} onClick={() => setAreaCode(area.id)}>{area.shortName}</button>)}</div>
      <button className="primary-button" disabled={busy === 'create'}>{busy === 'create' ? <LoaderCircle className="reservation-spin" size={16} /> : <Check size={16} />}确认登记</button>
    </form>}
    <div className="waitlist-list" aria-busy={loading}>
      {loading && <div className="waitlist-empty"><LoaderCircle className="reservation-spin" size={18} />正在加载</div>}
      {!loading && activeEntries.length === 0 && <div className="waitlist-empty"><Check size={18} />当前没有候补客人</div>}
      {activeEntries.map((entry) => {
        const target = entry.status === 'waiting' ? recommendedTable(entry.id) : tables.find((table) => table.id === entry.heldTableId)
        return <article className={`waitlist-row is-${entry.status}`} key={entry.id}>
          <b>{data.positions[entry.id] ?? '-'}号</b>
          <div><strong>{entry.customerName}</strong><span>{entry.partySize}人 · {entry.areaPreferenceCode ? areas.find((area) => area.id === entry.areaPreferenceCode)?.shortName : '区域不限'}</span></div>
          <span><Clock3 size={13} />{entry.status === 'notified' ? `等待回复至 ${time(entry.responseExpiresAt)}` : `最晚等到 ${time(entry.maximumWaitUntil)}`}</span>
          <div className="waitlist-actions">
            {canManage && entry.status === 'waiting' && target && <button className="primary-button" disabled={Boolean(busy)} onClick={() => void run(`notify:${entry.id}`, () => actOnWaitlistEntry(entry.id, { action: 'notify', tableId: target.id, reason: '按队列与容量自动匹配', idempotencyKey: key('notify') }), `已通知${entry.customerName}并锁定${target.code}`)}><BellRing size={14} />通知并锁 {target.code}</button>}
            {canManage && entry.status === 'notified' && <button className="primary-button" disabled={Boolean(busy)} onClick={() => void run(`seat:${entry.id}`, () => actOnWaitlistEntry(entry.id, { action: 'seat', reason: '客人已到入口确认入座', idempotencyKey: key('seat') }), `${entry.customerName}已安排入座`)}><DoorOpen size={14} />入座 {target?.code}</button>}
            {canManage && entry.status === 'notified' && <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void run(`skip:${entry.id}`, () => actOnWaitlistEntry(entry.id, { action: 'skip', reason: '两次联系未响应，按规则顺延', idempotencyKey: key('skip') }), '已释放桌台并顺延候补')}><UserRoundX size={14} />跳过</button>}
            {canManage && <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void run(`cancel:${entry.id}`, () => actOnWaitlistEntry(entry.id, { action: 'cancel', reason: '客人确认离队', idempotencyKey: key('cancel') }), '候补已取消')}><X size={14} />离队</button>}
          </div>
        </article>
      })}
      {recentClosed.map((entry) => <article className="waitlist-row is-closed" key={entry.id}><b>{entry.joinedSequence}号</b><div><strong>{entry.customerName}</strong><span>{entry.partySize}人</span></div><span>{status(entry.status)}{entry.heldTableCode ? ` · ${entry.heldTableCode}` : ''}</span></article>)}
    </div>
  </section>
}

function key(scope: string) { return `waitlist-ui-${scope}-${crypto.randomUUID()}` }
function time(value: string | null) { return value ? formatChinaTime(value) : '--:--' }
function status(value: string) { return value === 'seated' ? '已入座' : value === 'cancelled' ? '已离队' : value === 'skipped' ? '已跳过' : '已过期' }
