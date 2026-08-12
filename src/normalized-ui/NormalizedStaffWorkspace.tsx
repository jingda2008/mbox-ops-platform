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
  X,
} from 'lucide-react'
import {
  NormalizedApiClient,
  NormalizedApiError,
} from '../normalized-api'
import type {
  StaffBootstrapView,
  StaffDomainKey,
  StaffOnDemandResource,
} from '../shared/normalized-contracts'
import {
  initialWorkspaceState,
  resourceItems,
  RESOURCE_DEFINITIONS,
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

export function NormalizedStaffWorkspace({
  api: suppliedApi,
  onNavigate,
  onLoginRequired,
}: NormalizedStaffWorkspaceProps) {
  const api = useMemo(() => suppliedApi ?? new NormalizedApiClient(), [suppliedApi])
  const [state, dispatch] = useReducer(workspaceReducer, undefined, initialWorkspaceState)
  const requestSequence = useRef(0)
  const bootstrapEtag = useRef<string | null>(null)
  const bootstrapAbort = useRef<AbortController | null>(null)
  const resourceAbort = useRef<AbortController | null>(null)

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

  useEffect(() => () => {
    bootstrapAbort.current?.abort()
    resourceAbort.current?.abort()
  }, [])

  const loadResource = useCallback(async (resource: StaffOnDemandResource) => {
    resourceAbort.current?.abort()
    const controller = new AbortController()
    resourceAbort.current = controller
    const requestId = ++requestSequence.current
    dispatch({ type: 'resource-loading', resource, requestId })
    try {
      const data = await api.getOnDemand(resource, { signal: controller.signal })
      dispatch({ type: 'resource-ready', resource, requestId, data })
    } catch (error) {
      if (error instanceof NormalizedApiError && error.kind === 'aborted') return
      dispatch({
        type: 'resource-error',
        resource,
        requestId,
        message: errorMessage(error, '数据暂时没有接上，请重试'),
      })
    }
  }, [api])

  return (
    <NormalizedStaffWorkspaceView
      state={state}
      onRefresh={() => void loadBootstrap()}
      onNavigate={onNavigate}
      onOpenResource={(resource) => void loadResource(resource)}
      onCloseResource={() => dispatch({ type: 'resource-close' })}
      onLoginRequired={onLoginRequired}
    />
  )
}

export interface NormalizedStaffWorkspaceViewProps {
  state: NormalizedWorkspaceState
  onRefresh: () => void
  onNavigate?: (route: string) => void
  onOpenResource: (resource: StaffOnDemandResource) => void
  onCloseResource: () => void
  onLoginRequired?: () => void
}

export function NormalizedStaffWorkspaceView({
  state,
  onRefresh,
  onNavigate,
  onOpenResource,
  onCloseResource,
  onLoginRequired,
}: NormalizedStaffWorkspaceViewProps) {
  if (state.bootstrap === null) {
    return <WorkspaceGate state={state} onRefresh={onRefresh} onLoginRequired={onLoginRequired} />
  }

  const bootstrap = state.bootstrap
  const selectedDefinition = RESOURCE_DEFINITIONS.find((item) => item.resource === state.selectedResource)
  const selectedState = state.selectedResource === null ? null : state.resources[state.selectedResource]

  return (
    <main className="normalized-workspace" data-testid="normalized-workspace">
      <header className="normalized-topbar">
        <div className="normalized-brand" aria-label={`${bootstrap.store.name} 员工工作台`}>
          <span className="normalized-brand-mark">M</span>
          <span>
            <strong>{bootstrap.store.name}</strong>
            <small>{businessDayLabel(bootstrap)}</small>
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
        <div className="normalized-summary-grid">
          {bootstrap.domainSummaries.map((summary) => {
            const Icon = domainIcon[summary.key]
            const resource = RESOURCE_DEFINITIONS.find((item) => item.domain === summary.key)?.resource
            return (
              <button
                className="normalized-summary-card"
                type="button"
                key={summary.key}
                onClick={() => resource !== undefined && onOpenResource(resource)}
                disabled={resource === undefined}
              >
                <span className="normalized-summary-icon"><Icon size={19} aria-hidden="true" /></span>
                <span className="normalized-summary-copy">
                  <strong>{summary.label}</strong>
                  <small>{summary.activeCount} 项进行中</small>
                </span>
                <span className={summary.attentionCount > 0 ? 'normalized-count is-alert' : 'normalized-count'}>
                  {summary.attentionCount > 0 ? summary.attentionCount : summary.readyCount}
                  <small>{summary.attentionCount > 0 ? '待关注' : '已就绪'}</small>
                </span>
              </button>
            )
          })}
        </div>
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

      {selectedDefinition !== undefined && selectedState !== null && (
        <ResourceSheet
          label={selectedDefinition.label}
          description={selectedDefinition.description}
          resource={selectedDefinition.resource}
          state={selectedState}
          onRetry={() => onOpenResource(selectedDefinition.resource)}
          onClose={onCloseResource}
        />
      )}

      <p className="normalized-status-announcer" aria-live="polite" aria-atomic="true">
        {selectedState?.phase === 'loading' ? `正在加载${selectedDefinition?.label ?? '数据'}` : ''}
      </p>
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

function ResourceSheet({
  label,
  description,
  resource,
  state,
  onRetry,
  onClose,
}: {
  label: string
  description: string
  resource: StaffOnDemandResource
  state: NormalizedWorkspaceState['resources'][StaffOnDemandResource]
  onRetry: () => void
  onClose: () => void
}) {
  const items = state.phase === 'ready' ? resourceItems(resource, state.data) : []
  return (
    <div className="normalized-sheet-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <section className="normalized-sheet" role="dialog" aria-modal="true" aria-labelledby="resource-title">
        <header>
          <div>
            <p className="normalized-eyebrow">按需加载</p>
            <h2 id="resource-title">{label}</h2>
            <p>{description}</p>
          </div>
          <button className="normalized-icon-button" type="button" aria-label={`关闭${label}`} onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        {state.phase === 'loading' && <LoadingRows />}
        {state.phase === 'error' && (
          <div className="normalized-sheet-state">
            <AlertCircle size={24} aria-hidden="true" />
            <strong>没有加载成功</strong>
            <p>{state.message}</p>
            <button type="button" onClick={onRetry}><RotateCcw size={16} aria-hidden="true" />重试</button>
          </div>
        )}
        {state.phase === 'ready' && items.length === 0 && (
          <div className="normalized-sheet-state">
            <ShieldCheck size={24} aria-hidden="true" />
            <strong>目前没有待处理内容</strong>
            <p>这里只展示当前岗位有权查看的数据。</p>
          </div>
        )}
        {state.phase === 'ready' && items.length > 0 && (
          <ul className="normalized-resource-list">
            {items.map((item) => (
              <li key={item.id}>
                <span>
                  <strong>{item.title}</strong>
                  {item.detail !== null && <small>{item.detail}</small>}
                </span>
                {item.status !== null && <em>{item.status}</em>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function LoadingRows() {
  return (
    <div className="normalized-loading-rows" aria-label="正在加载">
      <span /><span /><span />
    </div>
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
