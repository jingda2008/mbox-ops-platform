import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NormalizedApiClient, NormalizedApiError } from '../normalized-api'
import type { StaffBootstrapView } from '../shared/normalized-contracts'
import { staffTodoSources, uniqueStaffTodos, type StaffTodo } from './staff-todo-model'
import { useStaffViewState } from './staff-view-state'

interface SourceResult { id: string; label: string; route: string; items: StaffTodo[]; error: string | null; limited: boolean }
const domainLabels = { service: '服务', member: '会员', refund: '退款', print: '打印' }

export function StaffTodoPanel({ api, bootstrap, onNavigate, onLoginRequired }: {
  api: NormalizedApiClient; bootstrap: StaffBootstrapView; onNavigate?(route: string): void; onLoginRequired?(): void
}) {
  const signature = `${bootstrap.staff.id}:${bootstrap.access.permissions.join(',')}:${bootstrap.navigation.map(item => item.code).join(',')}`
  const latest = useRef(bootstrap)
  latest.current = bootstrap
  const sources = useMemo(() => staffTodoSources(latest.current), [signature])
  const [results, setResults] = useState<SourceResult[]>([])
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [filter, setFilter] = useStaffViewState<'all' | StaffTodo['domain']>('home:todo-domain', 'all')
  const [stateFilter, setStateFilter] = useStaffViewState<StaffTodo['state']>('home:todo-state', 'action')
  const [limit, setLimit] = useState(12)
  const request = useRef<AbortController | null>(null)
  const login = useRef(onLoginRequired)
  login.current = onLoginRequired
  const load = useCallback(async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    const settled = await Promise.allSettled(sources.map(async source => {
      const response = await api.getEndpoint<{ data: unknown }>(source.endpoint, { signal: controller.signal })
      return source.map(response.data)
    }))
    if (controller.signal.aborted) return
    if (settled.some(result => result.status === 'rejected' && result.reason instanceof NormalizedApiError && result.reason.recovery === 'login')) {
      login.current?.(); return
    }
    setResults(previous => sources.map((source, index) => {
      const result = settled[index]
      const failed = result.status === 'rejected'
      const denied = failed && result.reason instanceof NormalizedApiError && result.reason.status === 403
      return { id: source.id, label: source.label, route: source.route,
        items: denied ? [] : failed ? previous.find(item => item.id === source.id)?.items ?? [] : result.value,
        error: denied ? '当前权限已变更，请刷新工作台核对' : failed ? '读取失败，当前结果可能不完整' : null, limited: source.limit !== undefined }
    }))
    setLoading(false)
    setUpdatedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
  }, [api, sources])
  useEffect(() => {
    void load()
    const refresh = () => { if (document.visibilityState === 'visible') void load() }
    const timer = window.setInterval(refresh, 30_000)
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { request.current?.abort(); window.clearInterval(timer); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [load])
  if (sources.length === 0) return null
  const visibleResults = results.filter(result => sources.some(source => source.id === result.id))
  const todos = uniqueStaffTodos(visibleResults.flatMap(result => result.items))
  const matching = todos.filter(todo => (filter === 'all' || todo.domain === filter) && todo.state === stateFilter)
  const errors = visibleResults.filter(result => result.error)
  const staleIds = new Set(errors.flatMap(result => result.items.map(item => item.id)))
  return <section className="normalized-section staff-unified-todos" aria-labelledby="staff-todo-title">
    <div className="normalized-section-heading"><div><h2 id="staff-todo-title">待办事项</h2><small>{updatedAt ? `最近核对 ${updatedAt} · 当前已读取 ${todos.length} 项` : '正在读取各业务待办'}</small></div><button type="button" disabled={loading} onClick={() => void load()}>{loading ? '读取中…' : '刷新待办'}</button></div>
    <div className="staff-todo-filters">
      <div role="group" aria-label="待办处理状态">
        <button type="button" aria-pressed={stateFilter === 'action'} onClick={() => setStateFilter('action')}>现在可处理</button>
        <button type="button" aria-pressed={stateFilter === 'waiting'} onClick={() => setStateFilter('waiting')}>等待处理</button>
      </div>
      <label>业务<select aria-label="待办业务" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">全部</option>{Object.entries(domainLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
    </div>
    {errors.length > 0 && <div role="alert"><strong>部分待办未能更新</strong>{errors.map(result => <p key={result.id}>{result.label}：{result.error}。<button type="button" onClick={() => onNavigate?.(result.route)}>进入原业务核对</button></p>)}</div>}
    {matching.length === 0 ? <p role="status">{loading ? '正在读取待办，请稍候' : errors.length > 0 ? '已读取的范围内没有匹配事项，请先重试未读到的业务。' : '已读取的范围内没有匹配事项。'}</p> : <div className="staff-todo-list">{matching.slice(0, limit).map(todo => <article key={todo.id} data-todo-id={todo.id}>
      <div><small>{domainLabels[todo.domain]} · {todo.owner}</small><strong>{todo.title}</strong><p>{todo.detail}</p>{staleIds.has(todo.id) && <em>上次数据，处理前需重新核对</em>}</div>
      <button type="button" disabled={!onNavigate} onClick={() => onNavigate?.(todo.route)}>{todo.next}</button>
    </article>)}</div>}
    {matching.length > limit && <button type="button" onClick={() => setLimit(value => value + 12)}>显示更多待办（还有 {matching.length - limit} 项）</button>}
    {results.some(result => result.limited) && <details><summary>查询范围与更多记录</summary><p>此处合并当前权限可读取的服务、会员、退款和打印记录，同一业务记录只计一次。退款按前 100 个订单及报名读取，打印按前 100 条失败记录读取；更早事项请进入对应业务继续查询。</p>{results.filter(result => result.limited).map(result => <button key={result.id} type="button" onClick={() => onNavigate?.(result.route)}>全部{result.label}记录</button>)}</details>}
  </section>
}
