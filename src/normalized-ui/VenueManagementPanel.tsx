import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronDown, LoaderCircle, Map, Pencil, Plus } from 'lucide-react'
import { NormalizedApiClient } from '../normalized-api'

type AreaStatus = 'active' | 'paused' | 'retired'
type AreaType = 'indoor' | 'outdoor' | 'bar' | 'stage' | 'vip' | 'other'
type TableStatus = 'available' | 'paused' | 'retired'

interface ManagedArea {
  id: string; code: string; name: string; areaType: AreaType; sortOrder: number; status: AreaStatus
}

interface ManagedTable {
  id: string; areaId: string; areaName: string; code: string; displayName: string
  capacity: number; minimumSpendMinor: number | null; currency: string; status: TableStatus
}

interface AreaDraft {
  id: string | null; code: string; name: string; areaType: AreaType; sortOrder: string; status: AreaStatus
}

interface TableDraft {
  id: string | null; code: string; displayName: string; areaId: string; capacity: string
  minimumSpendYuan: string; status: TableStatus
}

export function VenueManagementPanel({ api }: { api: NormalizedApiClient }) {
  const [expanded, setExpanded] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [areas, setAreas] = useState<ManagedArea[]>([])
  const [tables, setTables] = useState<ManagedTable[]>([])
  const [areaDraft, setAreaDraft] = useState<AreaDraft | null>(null)
  const [tableDraft, setTableDraft] = useState<TableDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setPhase('loading')
    try {
      const [areaResponse, tableResponse] = await Promise.all([
        api.getEndpoint<{ data: unknown }>('/api/table-management/areas'),
        api.getEndpoint<{ data: unknown }>('/api/table-management/tables'),
      ])
      setAreas(readAreas(areaResponse.data))
      setTables(readTables(tableResponse.data))
      setPhase('ready')
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '区域与桌台读取失败' })
      setPhase('error')
    }
  }, [api])

  useEffect(() => {
    if (expanded && phase === 'idle') void load()
  }, [expanded, load, phase])

  const editArea = (area: ManagedArea) => {
    setAreaDraft({ id: area.id, code: area.code, name: area.name, areaType: area.areaType, sortOrder: String(area.sortOrder), status: area.status })
    setTableDraft(null)
    setNotice(null)
  }

  const editTable = (table: ManagedTable) => {
    setTableDraft({ id: table.id, code: table.code, displayName: table.displayName, areaId: table.areaId,
      capacity: String(table.capacity), minimumSpendYuan: table.minimumSpendMinor === null ? '' : (table.minimumSpendMinor / 100).toFixed(2), status: table.status })
    setAreaDraft(null)
    setNotice(null)
  }

  const saveArea = async (event: React.FormEvent) => {
    event.preventDefault()
    if (areaDraft === null || busy) return
    const sortOrder = integer(areaDraft.sortOrder, -100_000, 100_000)
    if (sortOrder === null) return setNotice({ kind: 'error', text: '区域排序必须是有效整数' })
    const payload = { code: areaDraft.code.trim(), name: areaDraft.name.trim(), areaType: areaDraft.areaType,
      sortOrder, ...(areaDraft.id === null ? { layoutSnapshot: {} } : {}), status: areaDraft.status }
    setBusy(true)
    try {
      if (areaDraft.id === null) await api.postEndpoint('/api/table-management/areas', payload, { idempotencyKey: key('area-create') })
      else await api.patchEndpoint(`/api/table-management/areas/${areaDraft.id}`, payload, { idempotencyKey: key('area-update') })
      await load(true)
      setAreaDraft(null)
      setNotice({ kind: 'success', text: `${payload.name} 已保存并从服务端读回` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '区域配置未保存' })
    } finally { setBusy(false) }
  }

  const saveTable = async (event: React.FormEvent) => {
    event.preventDefault()
    if (tableDraft === null || busy) return
    const capacity = integer(tableDraft.capacity, 1, 200)
    const minimumSpendMinor = money(tableDraft.minimumSpendYuan)
    if (capacity === null || minimumSpendMinor === undefined) return setNotice({ kind: 'error', text: '请核对桌台容量和最低消费' })
    const payload = { code: tableDraft.code.trim(), displayName: tableDraft.displayName.trim(), areaId: tableDraft.areaId,
      capacity, minimumSpendMinor, currency: 'CNY', ...(tableDraft.id === null ? { layoutSnapshot: {} } : {}), status: tableDraft.status }
    setBusy(true)
    try {
      if (tableDraft.id === null) await api.postEndpoint('/api/table-management/tables', payload, { idempotencyKey: key('table-create') })
      else await api.patchEndpoint(`/api/table-management/tables/${tableDraft.id}`, payload, { idempotencyKey: key('table-update') })
      await load(true)
      setTableDraft(null)
      setNotice({ kind: 'success', text: `${payload.displayName} 已保存并从服务端读回` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '桌台配置未保存' })
    } finally { setBusy(false) }
  }

  return <section className={`venue-management ${expanded ? 'is-expanded' : ''}`} aria-label="区域与桌台配置">
    <button type="button" className="venue-management-trigger" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><span><Map size={19} /><strong>区域、桌台与容量</strong><small>新增、停用、排序、容量和最低消费</small></span><span>{tables.length > 0 ? `${areas.length}区 · ${tables.length}桌` : '门店配置'} <ChevronDown size={17} /></span></button>
    {expanded && <div className="venue-management-body">
      {phase === 'loading' && <p className="venue-management-state"><LoaderCircle className="is-spinning" size={18} /> 正在读取桌台配置</p>}
      {notice !== null && <p className={`venue-management-notice is-${notice.kind}`} role="status">{notice.kind === 'success' && <Check size={17} />}{notice.text}</p>}
      {phase === 'error' && <button type="button" onClick={() => void load()}>重新读取</button>}
      {phase === 'ready' && <>
        <div className="venue-management-actions"><button type="button" onClick={() => { setAreaDraft({ id: null, code: '', name: '', areaType: 'indoor', sortOrder: String((areas.length + 1) * 10), status: 'active' }); setTableDraft(null) }}><Plus size={17} /> 新增区域</button><button type="button" disabled={areas.length === 0} onClick={() => { setTableDraft({ id: null, code: '', displayName: '', areaId: areas[0]?.id ?? '', capacity: '4', minimumSpendYuan: '0.00', status: 'available' }); setAreaDraft(null) }}><Plus size={17} /> 新增桌台</button></div>
        {areaDraft !== null && <form className="venue-management-form" onSubmit={(event) => void saveArea(event)}><header><strong>{areaDraft.id === null ? '新增区域' : `编辑 ${areaDraft.name}`}</strong><button type="button" onClick={() => setAreaDraft(null)}>取消</button></header><label>区域编号<input required disabled={areaDraft.id !== null} pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,31}" value={areaDraft.code} onChange={(event) => setAreaDraft({ ...areaDraft, code: event.target.value })} /></label><label>区域名称<input required maxLength={120} value={areaDraft.name} onChange={(event) => setAreaDraft({ ...areaDraft, name: event.target.value })} /></label><label>区域类型<select value={areaDraft.areaType} onChange={(event) => setAreaDraft({ ...areaDraft, areaType: event.target.value as AreaType })}><option value="indoor">室内</option><option value="outdoor">室外</option><option value="bar">吧台</option><option value="stage">舞台</option><option value="vip">VIP</option><option value="other">其他</option></select></label><label>排序<input inputMode="numeric" value={areaDraft.sortOrder} onChange={(event) => setAreaDraft({ ...areaDraft, sortOrder: event.target.value })} /></label><label>状态<select value={areaDraft.status} onChange={(event) => setAreaDraft({ ...areaDraft, status: event.target.value as AreaStatus })}><option value="active">启用</option><option value="paused">暂停</option><option value="retired">停用</option></select></label><button type="submit" disabled={busy}>{busy ? '保存中' : '保存区域'}</button></form>}
        {tableDraft !== null && <form className="venue-management-form" onSubmit={(event) => void saveTable(event)}><header><strong>{tableDraft.id === null ? '新增桌台' : `编辑 ${tableDraft.displayName}`}</strong><button type="button" onClick={() => setTableDraft(null)}>取消</button></header><label>桌台编号<input required pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,31}" value={tableDraft.code} onChange={(event) => setTableDraft({ ...tableDraft, code: event.target.value })} /></label><label>显示名称<input required maxLength={120} value={tableDraft.displayName} onChange={(event) => setTableDraft({ ...tableDraft, displayName: event.target.value })} /></label><label>所属区域<select required value={tableDraft.areaId} onChange={(event) => setTableDraft({ ...tableDraft, areaId: event.target.value })}>{areas.map((area) => <option value={area.id} key={area.id}>{area.name}</option>)}</select></label><label>标准容量<input inputMode="numeric" value={tableDraft.capacity} onChange={(event) => setTableDraft({ ...tableDraft, capacity: event.target.value })} /></label><label>最低消费（元）<input inputMode="decimal" value={tableDraft.minimumSpendYuan} onChange={(event) => setTableDraft({ ...tableDraft, minimumSpendYuan: event.target.value })} /></label><label>状态<select value={tableDraft.status} onChange={(event) => setTableDraft({ ...tableDraft, status: event.target.value as TableStatus })}><option value="available">可用</option><option value="paused">暂停</option><option value="retired">停用</option></select></label><button type="submit" disabled={busy}>{busy ? '保存中' : '保存桌台'}</button></form>}
        <div className="venue-management-list"><section><header><strong>区域</strong><span>{areas.length}项</span></header>{areas.map((area) => <article key={area.id}><div><strong>{area.name}</strong><small>{area.code} · {areaTypeLabel(area.areaType)} · {area.status === 'active' ? '启用' : area.status === 'paused' ? '暂停' : '停用'}</small></div><button type="button" onClick={() => editArea(area)}><Pencil size={16} /> 编辑</button></article>)}</section><section><header><strong>桌台</strong><span>{tables.length}项</span></header>{tables.map((table) => <article key={table.id}><div><strong>{table.code} · {table.displayName}</strong><small>{table.areaName} · {table.capacity}人 · 最低消费¥{((table.minimumSpendMinor ?? 0) / 100).toFixed(2)}</small></div><button type="button" onClick={() => editTable(table)}><Pencil size={16} /> 编辑</button></article>)}</section></div>
      </>}
    </div>}
  </section>
}

function readAreas(value: unknown): ManagedArea[] {
  return Array.isArray(value) ? value.filter((item): item is ManagedArea => isRecord(item) && typeof item.id === 'string' && typeof item.code === 'string' && typeof item.name === 'string' && typeof item.sortOrder === 'number') : []
}
function readTables(value: unknown): ManagedTable[] {
  return Array.isArray(value) ? value.filter((item): item is ManagedTable => isRecord(item) && typeof item.id === 'string' && typeof item.areaId === 'string' && typeof item.code === 'string' && typeof item.displayName === 'string' && typeof item.capacity === 'number') : []
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function integer(value: string, min: number, max: number): number | null { const parsed = Number(value); return /^-?\d+$/.test(value) && Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null }
function money(value: string): number | null | undefined { const normalized = value.trim(); if (normalized === '') return null; return /^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(normalized) ? Math.round(Number(normalized) * 100) : undefined }
function key(prefix: string): string { return `${prefix}-${crypto.randomUUID()}` }
function areaTypeLabel(value: AreaType): string { return value === 'indoor' ? '室内' : value === 'outdoor' ? '室外' : value === 'bar' ? '吧台' : value === 'stage' ? '舞台' : value === 'vip' ? 'VIP' : '其他' }
