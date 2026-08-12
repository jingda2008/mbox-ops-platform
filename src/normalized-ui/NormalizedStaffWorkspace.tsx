import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import {
  AlertCircle,
  CalendarDays,
  ChevronRight,
  ClipboardList,
  Clock3,
  Grid2X2,
  LoaderCircle,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
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
import './normalized-staff-workspace.css'

export interface NormalizedStaffWorkspaceProps {
  api?: NormalizedApiClient
  onNavigate?: (route: string) => void
  onLoginRequired?: () => void
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

export function NormalizedStaffWorkspace({
  api: suppliedApi,
  onNavigate,
  onLoginRequired,
}: NormalizedStaffWorkspaceProps) {
  const api = useMemo(() => suppliedApi ?? new NormalizedApiClient(), [suppliedApi])
  const [state, dispatch] = useReducer(workspaceReducer, undefined, initialWorkspaceState)
  const bootstrapEtag = useRef<string | null>(null)
  const bootstrapAbort = useRef<AbortController | null>(null)

  const loadBootstrap = useCallback(async () => {
    bootstrapAbort.current?.abort()
    const controller = new AbortController()
    bootstrapAbort.current = controller
    dispatch({ type: 'bootstrap-loading' })
    try {
      const result = await api.getStaffBootstrap({
        etag: bootstrapEtag.current ?? undefined,
        signal: controller.signal,
      })
      bootstrapEtag.current = result.etag
      if (result.notModified) {
        dispatch({ type: 'bootstrap-not-modified', etag: result.etag })
      } else if (result.data !== null) {
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
  }, [api, onLoginRequired])

  useEffect(() => {
    void loadBootstrap()
  }, [loadBootstrap])

  useEffect(() => () => bootstrapAbort.current?.abort(), [])

  return (
    <NormalizedStaffWorkspaceView
      state={state}
      onRefresh={() => void loadBootstrap()}
      onNavigate={onNavigate}
      onLoginRequired={onLoginRequired}
    />
  )
}

export interface NormalizedStaffWorkspaceViewProps {
  state: NormalizedWorkspaceState
  onRefresh: () => void
  onNavigate?: (route: string) => void
  onLoginRequired?: () => void
}

export function NormalizedStaffWorkspaceView({
  state,
  onRefresh,
  onNavigate,
  onLoginRequired,
}: NormalizedStaffWorkspaceViewProps) {
  if (state.bootstrap === null) {
    return <WorkspaceGate state={state} onRefresh={onRefresh} onLoginRequired={onLoginRequired} />
  }

  const bootstrap = state.bootstrap
  const attentionSummaries = bootstrap.domainSummaries.filter((summary) => (
    summary.activeCount > 0 || summary.attentionCount > 0 || summary.readyCount > 0
  ))
  return (
    <main className="normalized-workspace" data-testid="normalized-workspace">
      <header className="normalized-topbar">
        <div className="normalized-brand" aria-label={`${bootstrap.store.name} 员工工作台`}>
          <span className="normalized-brand-mark">M</span>
          <span>
            <strong>{bootstrap.store.name}</strong>
            <small>SUPERHIGH CULTURE · {businessDayLabel(bootstrap)}</small>
          </span>
        </div>
        <button
          className="normalized-icon-button"
          type="button"
          aria-label="刷新工作台"
          disabled={state.phase === 'loading'}
          onClick={onRefresh}
        >
          <RefreshCw size={19} aria-hidden="true" className={state.phase === 'loading' ? 'is-spinning' : ''} />
        </button>
      </header>

      <section className="normalized-identity" aria-labelledby="workspace-title">
        <div>
          <p className="normalized-eyebrow">当前员工</p>
          <h1 id="workspace-title">{bootstrap.staff.displayName}</h1>
          <p>{bootstrap.staff.roleNames.join(' · ') || '已授权员工'}</p>
        </div>
        <span className="normalized-online"><span /> 系统在线</span>
      </section>

      {state.phase === 'error' && (
        <InlineNotice message={state.message ?? '刷新失败，当前仍显示上次成功数据'} onRetry={onRefresh} />
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

      <section className="normalized-section" aria-labelledby="summary-title">
        <div className="normalized-section-heading">
          <div>
            <p className="normalized-eyebrow">现场摘要</p>
            <h2 id="summary-title">只看需要关注的事</h2>
          </div>
          <Clock3 size={18} aria-hidden="true" />
        </div>
        {attentionSummaries.length > 0 ? <div className="normalized-summary-grid">
          {attentionSummaries.map((summary) => {
            const Icon = domainIcon[summary.key]
            const status = summary.attentionCount > 0
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
                  <small>{summary.attentionCount > 0 ? `${summary.activeCount} 项进行中` : '点击查看详情'}</small>
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
          <span><strong>当前没有待处理事项</strong><small>新任务和异常出现后会自动进入对应岗位工作面</small></span>
        </div>}
      </section>

      <nav className="normalized-mobile-nav" aria-label="岗位导航">
        {bootstrap.navigation.slice(0, 5).map((entry) => (
          <button
            type="button"
            key={entry.code}
            onClick={() => onNavigate?.(entry.route)}
            disabled={onNavigate === undefined}
          >
            <span aria-hidden="true">{entry.icon ?? '•'}</span>
            {entry.label}
          </button>
        ))}
      </nav>
    </main>
  )
}

function WorkspaceGate({
  state,
  onRefresh,
  onLoginRequired,
}: Pick<NormalizedStaffWorkspaceViewProps, 'state' | 'onRefresh' | 'onLoginRequired'>) {
  const loading = state.phase === 'idle' || state.phase === 'loading'
  return (
    <main className="normalized-gate">
      <span className="normalized-brand-mark">M</span>
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
  return `${bootstrap.businessDay.date} · ${status}`
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback
}
