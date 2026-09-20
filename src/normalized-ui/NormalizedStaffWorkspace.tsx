import { StaffTodoPanel } from './StaffTodoPanel'
import { defaultStaffWorkMode, quickStaffEntries, staffWorkModes, type StaffWorkMode } from './staff-navigation-model'
import { businessOperatingHoursLabel } from '../shared/business-operating-hours'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  CalendarDays,
  ChevronRight,
  ClipboardList,
  Clock3,
  CreditCard,
  Database,
  Gift,
  Grid2X2,
  LayoutDashboard,
  LoaderCircle,
  MapPinned,
  Menu,
  MonitorCog,
  Music2,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldCheck,
  UtensilsCrossed,
  Warehouse,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  NormalizedApiClient,
  NormalizedApiError,
} from '../normalized-api'
import type {
  StaffBootstrapView,
  StaffDomainKey,
} from '../shared/normalized-contracts'
import {
  initialWorkspaceState,
  workspaceReducer,
  type NormalizedWorkspaceState,
} from './workspace-model'
import staffLogo from './assets/mbox-logo-badge.png'
import './normalized-staff-workspace.css'

export interface NormalizedStaffWorkspaceProps {
  api?: NormalizedApiClient
  initialBootstrap?: StaffBootstrapView | null
  onNavigate?: (route: string) => void
  onLoginRequired?: () => void
  onBootstrapReady?: (bootstrap: StaffBootstrapView) => void
  showMobileNavigation?: boolean
  sessionControls?: ReactNode
}

const domainIcon: Record<StaffDomainKey, typeof Grid2X2> = {
  live: Grid2X2,
  service: ClipboardList,
  fulfillment: PackageCheck,
  reservations: CalendarDays,
  payments: ShieldCheck,
  inventory: PackageCheck,
  printing: ClipboardList,
}

const domainRoute: Record<StaffDomainKey, string> = {
  live: '/staff/live',
  service: '/staff/tasks',
  fulfillment: '/staff/fulfillment',
  reservations: '/staff/reservations',
  payments: '/staff/payments',
  inventory: '/staff/inventory',
  printing: '/staff/devices',
}

const navigationIcon: Record<string, LucideIcon> = {
  live: LayoutDashboard,
  service: ClipboardList,
  tasks: ClipboardList,
  reservations: CalendarDays,
  commerce: UtensilsCrossed,
  fulfillment: PackageCheck,
  inventory: Warehouse,
  payments: CreditCard,
  benefits: Gift,
  operations: Grid2X2,
  devices: MonitorCog,
  performance: Music2,
  songs: Music2,
  layout: MapPinned,
  master: Database,
  settings: Settings,
  config: Settings,
}

function StaffNavigationIcon({ code, size = 20 }: { code: string; size?: number }) {
  const Icon = navigationIcon[code] ?? LayoutDashboard
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" />
}

export function NormalizedStaffWorkspace({
  api: suppliedApi,
  initialBootstrap = null,
  onNavigate,
  onLoginRequired,
  onBootstrapReady,
  showMobileNavigation = true,
  sessionControls,
}: NormalizedStaffWorkspaceProps) {
  const api = useMemo(() => suppliedApi ?? new NormalizedApiClient(), [suppliedApi])
  const [state, dispatch] = useReducer(
    workspaceReducer,
    initialBootstrap,
    (bootstrap): NormalizedWorkspaceState => bootstrap === null
      ? initialWorkspaceState()
      : { phase: 'ready', bootstrap, etag: null, message: null },
  )
  const bootstrapEtag = useRef<string | null>(null)
  const bootstrapAbort = useRef<AbortController | null>(null)

  const loadBootstrap = useCallback(async (quiet = false) => {
    bootstrapAbort.current?.abort()
    const controller = new AbortController()
    bootstrapAbort.current = controller
    if (!quiet) dispatch({ type: 'bootstrap-loading' })
    try {
      const result = await api.getStaffBootstrap({
        etag: bootstrapEtag.current ?? undefined,
        signal: controller.signal,
      })
      bootstrapEtag.current = result.etag
      if (result.notModified) {
        dispatch({ type: 'bootstrap-not-modified', etag: result.etag })
      } else if (result.data !== null) {
        onBootstrapReady?.(result.data)
        dispatch({ type: 'bootstrap-ready', bootstrap: result.data, etag: result.etag })
      }
    } catch (error) {
      if (error instanceof NormalizedApiError && error.kind === 'aborted') return
      const loginRequired = error instanceof NormalizedApiError && error.recovery === 'login'
      dispatch({
        type: 'bootstrap-error',
        message: errorMessage(error, '工作台暂时没有接上，请重试'),
        loginRequired,
      })
      if (loginRequired) onLoginRequired?.()
    }
  }, [api, onBootstrapReady, onLoginRequired])

  useEffect(() => {
    if (initialBootstrap !== null) return
    void loadBootstrap()
  }, [initialBootstrap, loadBootstrap])

  useEffect(() => {
    if (state.bootstrap === null) return
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadBootstrap(true)
    }
    const timer = globalThis.setInterval(refresh, 15_000)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('online', refresh)
    return () => {
      globalThis.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('online', refresh)
    }
  }, [loadBootstrap, state.bootstrap])

  useEffect(() => () => bootstrapAbort.current?.abort(), [])

  return (
    <NormalizedStaffWorkspaceView
      state={state}
      api={api}
      onRefresh={() => void loadBootstrap()}
      onNavigate={onNavigate}
      onLoginRequired={onLoginRequired}
      showMobileNavigation={showMobileNavigation}
      sessionControls={sessionControls}
    />
  )
}

export interface NormalizedStaffWorkspaceViewProps {
  state: NormalizedWorkspaceState
  api?: NormalizedApiClient
  onRefresh: () => void
  onNavigate?: (route: string) => void
  onLoginRequired?: () => void
  showMobileNavigation?: boolean
  sessionControls?: ReactNode
}

export function NormalizedStaffWorkspaceView({
  state,
  api,
  onRefresh,
  onNavigate,
  onLoginRequired,
  showMobileNavigation = true,
  sessionControls,
}: NormalizedStaffWorkspaceViewProps) {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  if (state.bootstrap === null) {
    return <WorkspaceGate
      state={state}
      onRefresh={onRefresh}
      onLoginRequired={onLoginRequired}
      sessionControls={sessionControls}
    />
  }

  const bootstrap = state.bootstrap
  const attentionSummaries = bootstrap.domainSummaries.filter((summary) => (
    summary.activeCount > 0 || summary.attentionCount > 0 || summary.readyCount > 0
      || (summary.carryoverCount ?? 0) > 0
  ))

  return (
    <main className="normalized-workspace" data-testid="normalized-workspace">
      <header className="normalized-topbar">
        <div className="normalized-brand" aria-label={`${bootstrap.store.name} 员工工作台`}>
          <span className="normalized-brand-mark"><img src={staffLogo} alt="" aria-hidden="true" /></span>
          <span>
            <strong>{bootstrap.store.name}</strong>
            <small>SUPERHIGH CULTURE · {businessDayLabel(bootstrap)}</small>
          </span>
        </div>
        <div className="normalized-topbar-actions">
          <button
            className="normalized-icon-button"
            type="button"
            aria-label="刷新工作台"
            disabled={state.phase === 'loading'}
            onClick={onRefresh}
          >
            <RefreshCw size={19} aria-hidden="true" className={state.phase === 'loading' ? 'is-spinning' : ''} />
          </button>
          {sessionControls}
        </div>
      </header>

      <div className="normalized-workspace-shell">
        <RoleNavigation entries={bootstrap.navigation} onNavigate={onNavigate} />
        <div className="normalized-workspace-content">
          <section className="normalized-identity" aria-labelledby="workspace-title">
            <div>
              <p className="normalized-eyebrow">当前员工</p>
              <h1 id="workspace-title">{bootstrap.staff.displayName}</h1>
              <p>{bootstrap.staff.roleNames.join(' · ') || '已授权员工'}</p>
            </div>
            <span className={`normalized-freshness${!online || state.phase === 'error' ? ' is-stale' : ''}`}><b><span /> {!online ? '已离线，显示上次数据' : state.phase === 'error' ? '更新失败，显示上次数据' : state.phase === 'loading' ? '正在更新' : '连接正常'}</b><small>上次更新 {formatGeneratedAt(bootstrap.generatedAt)}</small></span>
          </section>

          {state.phase === 'error' && (
            <InlineNotice message={state.message ?? '刷新失败，当前显示上次数据，请核对上方更新时间'} onRetry={onRefresh} />
          )}

          <section className="normalized-section" aria-labelledby="quick-title">
            <div className="normalized-section-heading">
              <div>
                <p className="normalized-eyebrow">高频操作</p>
                <h2 id="quick-title">现在要做什么</h2>
              </div>
            </div>
            {bootstrap.highFrequencyEntries.length > 0 ? (
              <div className="normalized-quick-grid">
                {bootstrap.highFrequencyEntries.map((entry) => (
                  <button
                    className="normalized-quick-action"
                    type="button"
                    key={entry.code}
                    onClick={() => onNavigate?.(entry.route)}
                    disabled={onNavigate === undefined}
                  >
                    <span>{entry.label}</span>
                    <ChevronRight size={18} aria-hidden="true" />
                  </button>
                ))}
              </div>
            ) : (
              <EmptyInline text="当前岗位没有配置高频入口" />
            )}
          </section>

          {api && <StaffTodoPanel api={api} bootstrap={bootstrap} onNavigate={onNavigate} onLoginRequired={onLoginRequired} />}
          <details className="normalized-section staff-operating-summary">
            <summary>营业概况</summary>
          <section aria-labelledby="summary-title">
            <div className="normalized-section-heading">
              <div>
                <p className="normalized-eyebrow">现场摘要</p>
                <h2 id="summary-title">营业状态与待处理</h2>
              </div>
              <Clock3 size={18} aria-hidden="true" />
            </div>
            {attentionSummaries.length > 0 ? <div className="normalized-summary-grid">
              {attentionSummaries.map((summary) => {
                const Icon = domainIcon[summary.key]
                const carryoverCount = summary.carryoverCount ?? 0
                const status = carryoverCount > 0
                  ? { count: carryoverCount, label: '交班遗留', tone: 'is-alert' }
                  : summary.attentionCount > 0
                  ? { count: summary.attentionCount, label: '待关注', tone: 'is-alert' }
                  : summary.readyCount > 0
                    ? { count: summary.readyCount, label: '已就绪', tone: '' }
                    : { count: summary.activeCount, label: '进行中', tone: '' }
                return (
                  <button
                    className="normalized-summary-card"
                    type="button"
                    key={summary.key}
                    onClick={() => onNavigate?.(domainRoute[summary.key])}
                    disabled={onNavigate === undefined}
                  >
                    <span className="normalized-summary-icon"><Icon size={19} aria-hidden="true" /></span>
                    <span className="normalized-summary-copy">
                      <strong>{summary.label}</strong>
                      <small>{carryoverCount > 0
                        ? `${carryoverCount} 项上个营业日遗留 · ${summary.activeCount} 项今日进行中`
                        : summary.attentionCount > 0
                        ? `${summary.attentionCount} 项待处理 · ${summary.activeCount} 项进行中`
                        : summary.readyCount > 0 ? `${summary.readyCount} 项已就绪` : `${summary.activeCount} 项进行中`}</small>
                    </span>
                    <span className={`normalized-count ${status.tone}`.trim()}>
                      {status.count}
                      <small>{status.label}</small>
                    </span>
                  </button>
                )
              })}
            </div> : <div className="normalized-clear-state">
              <ShieldCheck size={20} aria-hidden="true" />
              <span><strong>当前摘要没有异常</strong><small>具体待办以上方已读取的业务记录为准</small></span>
            </div>}
          </section>
          </details>

        </div>
      </div>

      {showMobileNavigation && <StaffBottomNavigation entries={bootstrap.navigation} roleCodes={bootstrap.staff.roleCodes} onNavigate={onNavigate} />}
    </main>
  )
}

export function StaffBottomNavigation({
  entries,
  activeRoute = null,
  roleCodes = [],
  onNavigate,
}: {
  entries: StaffBootstrapView['navigation']
  activeRoute?: string | null
  roleCodes?: readonly string[]
  onNavigate?: (route: string) => void
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [workMode, setWorkMode] = useState<StaffWorkMode>(()=>defaultStaffWorkMode(roleCodes))
  const defaultMode=defaultStaffWorkMode(roleCodes)
  useEffect(()=>setWorkMode(defaultMode),[defaultMode])
  useEffect(()=>{if(!mobileMenuOpen)return;const previous=document.activeElement as HTMLElement|null;const menu=document.querySelector<HTMLElement>('.normalized-mobile-menu');menu?.querySelector<HTMLElement>('button')?.focus();const key=(event:KeyboardEvent)=>{if(event.key==='Escape')setMobileMenuOpen(false);if(event.key==='Tab'&&menu){const items=[...menu.querySelectorAll<HTMLElement>('button,summary')].filter(item=>item.getClientRects().length>0);const first=items[0],last=items[items.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}};document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);previous?.focus()}},[mobileMenuOpen])
  return <>
    <nav className="normalized-mobile-nav" aria-label="岗位快捷功能">
      {quickStaffEntries(entries, workMode).map((entry) => {
        const active = entry.route === activeRoute
        return <button
          type="button"
          key={entry.code}
          className={active ? 'is-active' : undefined}
          aria-current={active ? 'page' : undefined}
          onClick={() => onNavigate?.(entry.route)}
          disabled={onNavigate === undefined}
        >
          <span className="normalized-nav-icon"><StaffNavigationIcon code={entry.code} /></span>
          {entry.label}
        </button>
      })}
      <button type="button" aria-label="全部岗位入口" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen(true)}><Menu size={18} aria-hidden="true" />全部</button>
    </nav>
    {mobileMenuOpen && <>
      <button className="normalized-mobile-menu-backdrop" type="button" aria-label="关闭全部岗位入口" onClick={() => setMobileMenuOpen(false)} />
      <aside className="normalized-mobile-menu" role="dialog" aria-modal="true" aria-labelledby="mobile-menu-title">
        <header><div><small>当前岗位</small><h2 id="mobile-menu-title">全部工作入口</h2></div><button type="button" aria-label="关闭" onClick={() => setMobileMenuOpen(false)}><X size={20} /></button></header>
        <div className="staff-work-mode" aria-label="兼岗快捷入口">{staffWorkModes.map(mode=><button key={mode.id} type="button" aria-pressed={mode.id===workMode} onClick={()=>setWorkMode(mode.id)}>{mode.label}</button>)}</div>
        <p>快捷入口按工作内容排序，实际操作权限由当前账号决定。</p>
        <NavigationGroups entries={entries} onNavigate={route=>{setMobileMenuOpen(false);onNavigate?.(route)}}/>

      </aside>
    </>}
  </>
}

function RoleNavigation({
  entries,
  onNavigate,
}: {
  entries: StaffBootstrapView['navigation']
  onNavigate?: (route: string) => void
}) {
  return <aside className="normalized-role-nav" aria-label="当前岗位全部入口">
    <div className="normalized-role-nav-heading">
      <p className="normalized-eyebrow">岗位入口</p>
      <strong>我的工作面</strong>
      <small>仅显示当前岗位已授权功能</small>
    </div>
    <NavigationGroups entries={entries} onNavigate={onNavigate}/>

  </aside>
}

function NavigationGroups({entries,onNavigate}:{entries:StaffBootstrapView['navigation'];onNavigate?: (route:string)=>void}) {
  const members=entries.filter(entry=>entry.code.startsWith('member-'))
  const item=(entry:StaffBootstrapView['navigation'][number])=><button type="button" key={entry.code} onClick={()=>onNavigate?.(entry.route)} disabled={!onNavigate}><span className="normalized-nav-icon"><StaffNavigationIcon code={entry.code} size={19}/></span><strong>{entry.label}</strong><ChevronRight size={17}/></button>
  return <div className="normalized-role-nav-list">{entries.filter(entry=>!entry.code.startsWith('member-')).map(item)}{members.length>0&&<button type="button" className="staff-member-navigation" onClick={()=>onNavigate?.((members.find(entry=>entry.code==='member-accounts')??members[0]).route)} disabled={!onNavigate}><span className="normalized-nav-icon"><Gift size={19}/></span><strong>会员服务与管理</strong><ChevronRight size={17}/></button>}</div>
}

function WorkspaceGate({
  state,
  onRefresh,
  onLoginRequired,
  sessionControls,
}: Pick<NormalizedStaffWorkspaceViewProps, 'state' | 'onRefresh' | 'onLoginRequired' | 'sessionControls'>) {
  const loading = state.phase === 'idle' || state.phase === 'loading'
  return (
    <main className="normalized-gate">
      {sessionControls !== undefined && <div className="normalized-gate-session">{sessionControls}</div>}
      <span className="normalized-brand-mark"><img src={staffLogo} alt="" aria-hidden="true" /></span>
      {loading ? (
        <>
          <LoaderCircle className="is-spinning" size={28} aria-hidden="true" />
          <h1>正在进入工作台</h1>
          <p>只加载当前岗位需要的信息</p>
        </>
      ) : (
        <>
          <AlertCircle size={28} aria-hidden="true" />
          <h1>{state.phase === 'login_required' ? '登录已过期' : '工作台暂时没有接上'}</h1>
          <p>{state.message}</p>
          <button type="button" onClick={state.phase === 'login_required' ? onLoginRequired : onRefresh}>
            <RotateCcw size={17} aria-hidden="true" />
            {state.phase === 'login_required' ? '重新登录' : '重新加载'}
          </button>
        </>
      )}
    </main>
  )
}

function InlineNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="normalized-notice" role="status">
      <AlertCircle size={18} aria-hidden="true" />
      <span>{message}</span>
      <button type="button" onClick={onRetry}>再试一次</button>
    </div>
  )
}

function EmptyInline({ text }: { text: string }) {
  return <p className="normalized-empty-inline">{text}</p>
}

function businessDayLabel(bootstrap: StaffBootstrapView): string {
  const status = bootstrap.businessDay.status === 'open' ? '营业中' : '未营业'
  return `${bootstrap.businessDay.date} · ${status} · ${businessOperatingHoursLabel(bootstrap.store.businessDayCutoff)}`
}

function formatGeneratedAt(value: string): string {
  const instant = new Date(value)
  if (!Number.isFinite(instant.getTime())) return '时间待确认'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(instant)
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback
}
