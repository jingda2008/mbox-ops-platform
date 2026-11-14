import { useCallback, useEffect, useRef, useState } from 'react'
import { NormalizedApiError, type NormalizedApiClient, type StaffAuthView } from '../normalized-api'
import { printFailureReason } from './print-failure-presentation'
import './print-incident-panel.css'
import { incidentPermissions, incidentCanResolve, type IncidentResolution, type PrintIncident } from './print-incident-policy'

type Action = 'claim' | IncidentResolution
const resolutionLabels: Record<IncidentResolution, string> = {
  paper_confirmed: '现场确认已出纸', not_printed: '现场确认未出纸', device_restored: '设备已恢复',
}
const escalationLabels = { staff: '服务员处理', supervisor: '需领班处理', administrator: '需管理员处理' }

interface ViewProps {
  rows: readonly PrintIncident[]; employeeId: string; permissions: readonly string[]
  busy: boolean; fresh: boolean; error: string; notice: string; pending: {id: string; action: Action} | null
  selected: {id: string; resolution: IncidentResolution} | null
  onSelect(id: string, resolution: IncidentResolution): void
  onAction(id: string, action: Action): void; onRefresh(): void
}
export function PrintIncidentPanelView(props: ViewProps) {
  const permission = incidentPermissions(props.permissions)
  if (!permission.view) return null
  const active = props.rows.filter(row => row.status !== 'resolved')
  return <section className="staff-song-requests print-incident-panel" aria-label="打印故障处理">
    <h2>打印故障处理 · {active.length} 项未解决</h2>
    <p className="staff-module-footnote">Windows 已接收不代表实际出纸。结果不明时禁止自动补打，请先核对实体纸票；这里的确认不会触发打印。</p>
    <p className="staff-module-footnote">本页打开时定时刷新，最多显示100项未解决故障。微信、短信等外发通知尚未接通；关闭页面后不能保证及时收到提醒。</p>
    <button type="button" disabled={props.busy} onClick={props.onRefresh}>刷新故障</button>
    {props.error && <p role="alert">{props.error}</p>}
    {props.notice && <p role="status">{props.notice}</p>}
    {!permission.claim && <p>当前仅可查看，请有打印补救权限的员工认领并完成现场核验。</p>}
    {props.fresh && props.rows.length === 0 && <p>当前列表没有未解决故障。</p>}
    {props.pending && !props.rows.some(row => row.id === props.pending!.id) && <p>原请求仍需确认。<button type="button" disabled={props.busy || !props.fresh || !permission.claim} onClick={() => props.onAction(props.pending!.id, props.pending!.action)}>核对原请求结果</button></p>}
    {props.rows.map(row => <article key={row.id}>
      <div>
        <strong>{row.status === 'resolved' ? '已处理' : escalationLabels[row.escalation]}</strong>
        <span>故障 {row.id.slice(0, 8)} · 桥 {row.bridgeId.slice(0, 8)}{row.jobId ? ` · 任务 ${row.jobId.slice(0, 8)}` : ''}</span>
        <span>首次 {new Date(row.firstSeenAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · 记录 {row.occurrences} 次</span>
        <p>{row.failureCode ? printFailureReason(row.failureCode) : '设备健康异常，请检查打印桥与现场设备。'}</p>
        <span>{row.status === 'open' ? '尚未认领' : row.status === 'resolved' ? resolutionLabels[row.resolution!] || '已记录处理结果' : row.claimedBy === props.employeeId ? '由你处理中' : '已由其他员工认领'}</span>
        {row.resolution === 'not_printed' && <p>未出纸已记录，尚未补打；如仍需纸票，请有权限人员核对原任务后单独补打。</p>}
      </div>
      <div className="staff-inline-actions">
        {row.status === 'open' && permission.claim && <button type="button" disabled={props.busy || !props.fresh || props.pending !== null} onClick={() => props.onAction(row.id, 'claim')}>认领处理</button>}
        {incidentCanResolve(row, props.employeeId, props.permissions) && <>
          <label>现场核验结果<select aria-label={`故障 ${row.id.slice(0, 8)} 的核验结果`} disabled={props.busy || !props.fresh || props.pending !== null} value={props.selected?.id === row.id ? props.selected.resolution : ''} onChange={event => props.onSelect(row.id, event.target.value as IncidentResolution)}>
            <option value="" disabled>请选择核验结果</option>
            {row.jobId ? <><option value="paper_confirmed">现场确认已出纸</option><option value="not_printed">现场确认未出纸（不自动补打）</option></> : <option value="device_restored">设备已恢复（不确认票据出纸）</option>}
          </select></label>
          <button type="button" disabled={props.busy || !props.fresh || props.pending !== null || props.selected?.id !== row.id} onClick={() => { if (props.selected?.id === row.id) props.onAction(row.id, props.selected.resolution) }}>确认保存现场核验</button>
        </>}
        {props.pending?.id === row.id && <button type="button" disabled={props.busy || !props.fresh || !permission.claim} onClick={() => props.onAction(row.id, props.pending!.action)}>核对原请求结果</button>}
      </div>
    </article>)}
  </section>
}

export function PrintIncidentPanel({ api, auth }: {api: NormalizedApiClient; auth: StaffAuthView}) {
  return <PrintIncidentPanelSession key={auth.session.employeeId} api={api} auth={auth} />
}
function PrintIncidentPanelSession({ api, auth }: {api: NormalizedApiClient; auth: StaffAuthView}) {
  const [rows, setRows] = useState<PrintIncident[]>([]), [fresh, setFresh] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<ViewProps['selected']>(null), [pending, setPending] = useState<ViewProps['pending']>(null)
  const inflight = useRef(false), generation = useRef(0)
  const operation = useRef<{id: string; action: Action; key: string; expectedEpisodeAt: string} | null>(null)
  const allowed = incidentPermissions(auth.permissions).view
  const refresh = useCallback(async () => {
    if (!allowed) return
    const current = ++generation.current
    try {
      const response = await api.getEndpoint<{data: PrintIncident[]}>('/api/hardware/print-incidents')
      if (current !== generation.current) return
      setRows(response.data); setFresh(true); setError('')

    } catch {
      if (current === generation.current) { setFresh(false); setError('故障状态暂未读到，列表可能已过期。请刷新后再操作。') }
    }
  }, [api, allowed])
  useEffect(() => {
    void refresh()
    const visibleRefresh = () => { if (document.visibilityState === 'visible') void refresh() }
    const timer = window.setInterval(visibleRefresh, 15_000)
    window.addEventListener('online', visibleRefresh); document.addEventListener('visibilitychange', visibleRefresh)
    const invalidateRead = () => { generation.current++ }
    return () => { invalidateRead(); window.clearInterval(timer); window.removeEventListener('online', visibleRefresh); document.removeEventListener('visibilitychange', visibleRefresh) }
  }, [refresh])
  async function act(id: string, action: Action) {
    const row = rows.find(row => row.id === id)
    if (inflight.current || !fresh || !allowed) return
    if (operation.current && (operation.current.id !== id || operation.current.action !== action)) return
    if (action === 'claim' && !incidentPermissions(auth.permissions).claim) return
    if (action !== 'claim' && !incidentPermissions(auth.permissions).resolve) return
    if (!operation.current) {
      if (!row) return
      if (action !== 'claim' && !incidentCanResolve(row, auth.session.employeeId, auth.permissions)) return
      if (action === 'claim' && row.status !== 'open' && row.claimedBy !== auth.session.employeeId) return
    }
    const request = operation.current ?? {id, action, key: `print-incident-${crypto.randomUUID()}`, expectedEpisodeAt: row!.episodeStartedAt}
    operation.current = request; inflight.current = true; setBusy(true); setPending({id, action}); setNotice('')
    try {
      await api.postEndpoint(`/api/hardware/print-incidents/${id}/${action === 'claim' ? 'claim' : 'resolve'}`, action === 'claim' ? {expectedEpisodeAt: request.expectedEpisodeAt} : {resolution: action, expectedEpisodeAt: request.expectedEpisodeAt}, {idempotencyKey: request.key})
      operation.current = null; setPending(null); setSelected(null)
      setNotice(action === 'claim' ? '已认领，请检查现场设备和实体纸票。' : action === 'not_printed' ? '已记录未出纸，未触发补打。仍需纸票时请单独核对原任务后补打。' : '现场核验已保存，未触发打印。')
      await refresh()
    } catch (failure) {
      if (failure instanceof NormalizedApiError && failure.status !== null && failure.status >= 400 && failure.status < 500 && ![408, 425, 429].includes(failure.status)) {
        operation.current = null; setPending(null); setSelected(null); await refresh(); setError('操作被拒绝，可能权限或认领状态已变化，请核对刷新后的状态。')
      } else setError('操作结果尚未确认，请刷新核对；若仍未完成，使用“核对原请求结果”，不要提交另一种核验结果。')
    }
    finally { inflight.current = false; setBusy(false) }
  }
  return <PrintIncidentPanelView rows={rows} employeeId={auth.session.employeeId} permissions={auth.permissions} busy={busy} fresh={fresh} error={error} notice={notice} selected={selected} pending={pending} onSelect={(id, resolution) => setSelected({id, resolution})} onAction={(id, action) => void act(id, action)} onRefresh={() => void refresh()} />
}
