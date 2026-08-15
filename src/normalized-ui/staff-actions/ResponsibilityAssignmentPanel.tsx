import { useMemo, useState } from 'react'
import { Check, ChevronDown, LoaderCircle, Search, ShieldCheck, UserRoundCheck, X } from 'lucide-react'
import type { StaffActionsApiPort } from './staff-actions-api'
import { StaffActionsApiError } from './staff-actions-api'
import type {
  StaffActionTable,
  StaffTableAssignment,
  StaffTableAssignmentOptions,
  StaffTableAssignmentType,
} from './types'

interface ResponsibilityAssignmentPanelProps {
  api: StaffActionsApiPort
  tables: StaffActionTable[]
}

export function ResponsibilityAssignmentPanel({ api, tables }: ResponsibilityAssignmentPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [options, setOptions] = useState<StaffTableAssignmentOptions | null>(null)
  const [assignments, setAssignments] = useState<StaffTableAssignment[]>([])
  const [employeeId, setEmployeeId] = useState('')
  const [roleId, setRoleId] = useState('')
  const [assignmentType, setAssignmentType] = useState<StaffTableAssignmentType>('primary')
  const [selectedTableIds, setSelectedTableIds] = useState<Set<string>>(new Set())
  const [tableQuery, setTableQuery] = useState('')
  const [openAreaIds, setOpenAreaIds] = useState<Set<string>>(() => {
    const firstAreaId = tables.find((table) => table.status === 'available')?.areaId
    return new Set(firstAreaId === undefined ? [] : [firstAreaId])
  })
  const [startsAt, setStartsAt] = useState(() => localDateTimeValue(new Date()))
  const [endsAt, setEndsAt] = useState('')
  const [reason, setReason] = useState('本班次责任桌安排')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [endingId, setEndingId] = useState<string | null>(null)

  const activeTables = useMemo(() => tables.filter((table) => table.status === 'available'), [tables])
  const areaGroups = useMemo(() => {
    const groups = new Map<string, { id: string; name: string; tables: StaffActionTable[] }>()
    for (const table of activeTables) {
      const existing = groups.get(table.areaId) ?? { id: table.areaId, name: table.areaName, tables: [] }
      existing.tables.push(table)
      groups.set(table.areaId, existing)
    }
    return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  }, [activeTables])
  const visibleAreaGroups = useMemo(() => {
    const query = tableQuery.trim().toLocaleLowerCase('zh-CN')
    if (query === '') return areaGroups
    return areaGroups.flatMap((area) => {
      const areaMatches = `${area.name} ${area.id}`.toLocaleLowerCase('zh-CN').includes(query)
      const matchingTables = areaMatches
        ? area.tables
        : area.tables.filter((table) => `${table.code} ${table.areaName}`.toLocaleLowerCase('zh-CN').includes(query))
      return matchingTables.length === 0 ? [] : [{ ...area, tables: matchingTables }]
    })
  }, [areaGroups, tableQuery])
  const selectedTables = useMemo(
    () => activeTables.filter((table) => selectedTableIds.has(table.id)),
    [activeTables, selectedTableIds],
  )

  const load = async () => {
    setPhase('loading')
    setMessage(null)
    try {
      const [nextOptions, nextAssignments] = await Promise.all([
        api.loadTableAssignmentOptions(),
        api.loadTableAssignments(),
      ])
      setOptions(nextOptions)
      setAssignments(nextAssignments)
      setEmployeeId((current) => current || nextOptions.employees[0]?.id || '')
      setRoleId((current) => current || nextOptions.roles[0]?.id || '')
      setPhase('ready')
    } catch (error) {
      setPhase('error')
      setMessage({ kind: 'error', text: assignmentError(error, '责任桌安排暂时无法读取') })
    }
  }

  const toggleExpanded = () => {
    const next = !expanded
    setExpanded(next)
    if (next && phase === 'idle') void load()
  }

  const toggleTable = (tableId: string) => {
    setSelectedTableIds((current) => {
      const next = new Set(current)
      if (next.has(tableId)) next.delete(tableId)
      else next.add(tableId)
      return next
    })
  }

  const toggleArea = (areaTableIds: string[]) => {
    setSelectedTableIds((current) => {
      const next = new Set(current)
      const allSelected = areaTableIds.every((id) => next.has(id))
      for (const id of areaTableIds) {
        if (allSelected) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  const toggleAreaOpen = (areaId: string) => {
    setOpenAreaIds((current) => {
      const next = new Set(current)
      if (next.has(areaId)) next.delete(areaId)
      else next.add(areaId)
      return next
    })
  }

  const submit = async () => {
    if (employeeId === '' || roleId === '') return setMessage({ kind: 'error', text: '请选择员工和本次责任岗位' })
    if (selectedTableIds.size === 0) return setMessage({ kind: 'error', text: '至少选择一个桌台或一个区域' })
    if (reason.trim().length < 2) return setMessage({ kind: 'error', text: '请填写本次安排原因' })
    const startTimestamp = localInputToIso(startsAt)
    const endTimestamp = endsAt === '' ? null : localInputToIso(endsAt)
    if (startTimestamp === null || (endsAt !== '' && endTimestamp === null)) {
      return setMessage({ kind: 'error', text: '班次起止时间无效' })
    }
    if (endTimestamp !== null && Date.parse(endTimestamp) <= Date.parse(startTimestamp)) {
      return setMessage({ kind: 'error', text: '结束时间必须晚于开始时间' })
    }

    setBusy(true)
    setMessage(null)
    try {
      await api.assignTables({
        tableIds: [...selectedTableIds],
        employeeId,
        roleId,
        assignmentType,
        startsAt: startTimestamp,
        endsAt: endTimestamp,
        reason: reason.trim(),
      })
      const employee = options?.employees.find((item) => item.id === employeeId)?.displayName ?? '员工'
      setMessage({ kind: 'success', text: `${employee} 已安排 ${selectedTableIds.size} 张责任桌；全部桌台已一次生效` })
      setSelectedTableIds(new Set())
      setAssignments(await api.loadTableAssignments())
    } catch (error) {
      setMessage({ kind: 'error', text: assignmentError(error, '责任桌未生效；本批次没有留下部分结果') })
    } finally {
      setBusy(false)
    }
  }

  const endAssignment = async (assignment: StaffTableAssignment) => {
    if (endingId !== assignment.id) {
      setEndingId(assignment.id)
      setMessage(null)
      return
    }
    setBusy(true)
    try {
      await api.endTableAssignment(assignment.id, `结束责任分配：${assignment.employeeName} / ${assignment.tableCode}`)
      setAssignments(await api.loadTableAssignments())
      setEndingId(null)
      setMessage({ kind: 'success', text: `${assignment.employeeName} 对 ${assignment.tableCode} 的责任已结束` })
    } catch (error) {
      setMessage({ kind: 'error', text: assignmentError(error, '责任结束操作未完成') })
    } finally {
      setBusy(false)
    }
  }

  return <section className={`staff-assignment-panel ${expanded ? 'is-expanded' : ''}`} aria-label="责任桌人员安排">
    <button type="button" className="staff-assignment-trigger" aria-expanded={expanded} onClick={toggleExpanded}>
      <span><UserRoundCheck size={19} /><strong>人员与责任桌</strong><small>安排主服务员、候补或临时支援</small></span>
      <span className="staff-assignment-trigger-count">{assignments.length > 0 ? `${assignments.length}项生效中` : '可批量安排'} <ChevronDown size={17} /></span>
    </button>

    {expanded && <div className="staff-assignment-body">
      {phase === 'loading' && <p className="staff-assignment-loading"><LoaderCircle className="is-spinning" size={18} /> 正在读取人员与责任桌</p>}
      {message !== null && <p className={`staff-assignment-message is-${message.kind}`} role="status">{message.kind === 'success' && <Check size={17} />}{message.text}</p>}
      {phase === 'error' && <button type="button" onClick={() => void load()}>重新读取</button>}
      {phase === 'ready' && options !== null && <>
        <div className="staff-assignment-boundary"><ShieldCheck size={18} /><span>仅有“分配责任桌台”权限的岗位可发布。区域批量发布使用同一事务，任一桌冲突时整批回滚。</span></div>
        <div className="staff-assignment-fields">
          <label>员工<select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>{options.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName} · {employee.code}</option>)}</select></label>
          <label>本次岗位<select value={roleId} onChange={(event) => setRoleId(event.target.value)}>{options.roles.map((role) => <option key={role.id} value={role.id}>{role.name} · {role.code}</option>)}</select></label>
          <label>责任类型<select value={assignmentType} onChange={(event) => setAssignmentType(event.target.value as StaffTableAssignmentType)}><option value="primary">主服务员</option><option value="backup">候补服务员</option><option value="temporary">临时支援</option></select></label>
          <label>开始时间<input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label>
          <label>结束时间（可不填）<input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label>
          <label className="staff-assignment-reason">安排原因<input maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：周五晚班室外区主服务安排" /></label>
        </div>

        <div className="staff-assignment-table-picker">
          <header><strong>选择责任区域或桌台</strong><span>已选 {selectedTableIds.size} 张</span></header>
          <label className="staff-assignment-table-search">
            <Search size={17} aria-hidden="true" />
            <input
              aria-label="搜索责任区域或桌台"
              value={tableQuery}
              onChange={(event) => setTableQuery(event.target.value)}
              placeholder="输入桌号或区域，例如 W01、室外"
            />
            {tableQuery !== '' && <button type="button" aria-label="清空责任桌搜索" onClick={() => setTableQuery('')}><X size={16} /></button>}
          </label>
          {selectedTables.length > 0 && <div className="staff-assignment-selected" aria-label="已选责任桌">
            <div><strong>本次已选</strong><button type="button" onClick={() => setSelectedTableIds(new Set())}>清空</button></div>
            <p>{selectedTables.map((table) => <button type="button" key={table.id} aria-label={`移除 ${table.code}`} onClick={() => toggleTable(table.id)}>{table.code}<X size={13} /></button>)}</p>
          </div>}
          {visibleAreaGroups.map((area) => {
            const ids = area.tables.map((table) => table.id)
            const allSelected = ids.length > 0 && ids.every((id) => selectedTableIds.has(id))
            const selectedCount = ids.filter((id) => selectedTableIds.has(id)).length
            const areaOpen = tableQuery.trim() !== '' || openAreaIds.has(area.id)
            return <section className="staff-assignment-area" key={area.id}>
              <header>
                <button type="button" className="staff-assignment-area-toggle" aria-expanded={areaOpen} onClick={() => toggleAreaOpen(area.id)}>
                  <span><strong>{area.name}</strong><small>{area.tables.length}桌{selectedCount > 0 ? ` · 已选${selectedCount}` : ''}</small></span>
                  <ChevronDown size={17} aria-hidden="true" />
                </button>
                <button type="button" className={allSelected ? 'staff-assignment-area-select is-selected' : 'staff-assignment-area-select'} onClick={() => toggleArea(ids)}>{allSelected ? '取消整区' : '选择整区'}</button>
              </header>
              {areaOpen && <div>{area.tables.map((table) => <label key={table.id} className={selectedTableIds.has(table.id) ? 'is-selected' : ''}><input type="checkbox" checked={selectedTableIds.has(table.id)} onChange={() => toggleTable(table.id)} /><span>{table.code}</span><small>{table.capacity}人</small></label>)}</div>}
            </section>
          })}
          {visibleAreaGroups.length === 0 && <p className="staff-assignment-no-results">没有匹配的区域或桌台</p>}
        </div>

        <button type="button" className="staff-assignment-submit" disabled={busy || selectedTableIds.size === 0} onClick={() => void submit()}>{busy ? <LoaderCircle className="is-spinning" size={18} /> : <UserRoundCheck size={18} />}发布 {selectedTableIds.size > 0 ? `${selectedTableIds.size} 张桌台` : '责任安排'}</button>

        <section className="staff-assignment-active" aria-label="当前责任安排">
          <header><strong>当前生效</strong><span>{assignments.length}项</span></header>
          {assignments.length === 0 ? <p>还没有生效中的责任桌安排。</p> : assignments.map((assignment) => <article key={assignment.id}>
            <div><strong>{assignment.tableCode} · {assignment.employeeName}</strong><span>{assignmentTypeLabel(assignment.assignmentType)} · {assignment.roleCode}</span><small>{formatDateTime(assignment.startsAt)} 起{assignment.endsAt === null ? '' : ` · ${formatDateTime(assignment.endsAt)} 止`}</small></div>
            <button type="button" className={endingId === assignment.id ? 'is-confirming' : ''} disabled={busy} onClick={() => void endAssignment(assignment)}>{endingId === assignment.id ? '再次确认结束' : '结束责任'}</button>
          </article>)}
        </section>
      </>}
    </div>}
  </section>
}

function assignmentTypeLabel(value: StaffTableAssignmentType): string {
  return value === 'primary' ? '主服务员' : value === 'backup' ? '候补服务员' : '临时支援'
}

function localDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function localInputToIso(value: string): string | null {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}

function assignmentError(error: unknown, fallback: string): string {
  return error instanceof StaffActionsApiError || error instanceof Error ? error.message : fallback
}
