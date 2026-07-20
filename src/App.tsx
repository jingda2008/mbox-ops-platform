import {
  Check,
  CheckCheck,
  Clock3,
  CloudUpload,
  LoaderCircle,
  LayoutDashboard,
  LogIn,
  LogOut,
  MapPin,
  Mic,
  Navigation,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
  WifiOff,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  ApiError,
  actOnTask,
  createPilotSession,
  endStaffPresence,
  getBootstrap,
  getCurrentActorId,
  getPilotEmployees,
  heartbeatStaffPresence,
  replayQueuedTaskAction,
} from './api'
import './App.css'
import { ServiceIcon } from './components/ServiceIcon'
import {
  clearOfflineDataForEmployeeChange,
  discardConflictedTaskAction,
  getOfflineStatus,
  loadOfflineSnapshot,
  prepareOfflineDataForEmployee,
  replayTaskActionQueue,
  sanitizeBootstrapSnapshot,
  saveOfflineSnapshot,
  startOfflineRuntime,
  subscribeOfflineStatus,
  type OfflineSnapshot,
  type OfflineStatus,
} from './offline'
import type { BootstrapResponse, TaskActionInput } from './shared/contracts'
import type { PilotEmployeeOption } from './shared/auth-contracts'
import type { OperationsConsoleView } from './components/OperationsConsole'
import { formatChinaDateTime, formatChinaTime } from './shared/china-time'
import { applyStaffViewport } from './staff-viewport'
import { runSingleFlight } from './single-flight'
import './system-ui.css'
import './premium-theme.css'

const RESTRICTED_OFFLINE_VIEWS = '.payment-view, .config-view, .benefit-view, .song-view, .master-view, .commerce-view, .reservation-view, .inventory-view, .hardware-view'
const BOOTSTRAP_POLL_DELAYS_MS = [5_000, 8_000, 13_000, 20_000] as const
const BOOTSTRAP_OFFLINE_RETRY_MS = 15_000
const GuestPortal = lazy(() => import('./components/GuestPortal').then((module) => ({ default: module.GuestPortal })))
const MemberBenefitsPortal = lazy(() => import('./components/MemberBenefitsPortal').then((module) => ({ default: module.MemberBenefitsPortal })))
const OperationsConsole = lazy(() => import('./components/OperationsConsole').then((module) => ({ default: module.OperationsConsole })))
const VoiceCommandMode = lazy(() => import('./components/VoiceCommandMode').then((module) => ({ default: module.VoiceCommandMode })))
const PublicReservationPortal = lazy(() => import('./components/PublicReservationPortal').then((module) => ({ default: module.PublicReservationPortal })))

function WorkspaceLoading() {
  return <main className="system-state"><LoaderCircle className="spin" size={28} /><strong>正在载入工作台</strong></main>
}

function LazyWorkspace({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<WorkspaceLoading />}>{children}</Suspense>
}

interface BootstrapPollingOptions {
  isOnline?: () => boolean
  isVisible?: () => boolean
  schedule?: (callback: () => void, delay: number) => number
  cancel?: (timer: number) => void
  visibilityTarget?: Pick<Document, 'addEventListener' | 'removeEventListener'>
  pageShowTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

// oxlint-disable-next-line react/only-export-components -- exported for deterministic lifecycle tests
export function startBootstrapPolling(
  enabled: boolean,
  refresh: () => boolean | void | Promise<boolean | void>,
  options: BootstrapPollingOptions = {},
) {
  if (!enabled) return () => undefined

  const isOnline = options.isOnline ?? (() => getOfflineStatus().online)
  const isVisible = options.isVisible ?? (() => document.visibilityState === 'visible')
  const schedule = options.schedule ?? ((callback, delay) => window.setTimeout(callback, delay))
  const cancel = options.cancel ?? ((timer) => window.clearTimeout(timer))
  const visibilityTarget = options.visibilityTarget ?? document
  const pageShowTarget = options.pageShowTarget ?? window
  let stopped = false
  let timer: number | undefined
  let running = false
  let refreshAfterCurrent = false
  let unchangedPolls = 0

  const clearTimer = () => {
    if (timer === undefined) return
    cancel(timer)
    timer = undefined
  }
  const scheduleNext = (delay: number) => {
    clearTimer()
    if (stopped || !isVisible()) return
    timer = schedule(() => {
      timer = undefined
      void poll()
    }, delay)
  }
  const poll = async () => {
    if (stopped || running || !isVisible()) return
    if (!isOnline()) {
      scheduleNext(BOOTSTRAP_OFFLINE_RETRY_MS)
      return
    }

    running = true
    let changed = false
    try {
      changed = (await refresh()) === true
    } catch {
      // The refresh path owns user-facing error state; polling only controls cadence.
    } finally {
      running = false
    }
    if (stopped || !isVisible()) return
    if (refreshAfterCurrent) {
      refreshAfterCurrent = false
      void poll()
      return
    }
    unchangedPolls = changed ? 0 : Math.min(unchangedPolls + 1, BOOTSTRAP_POLL_DELAYS_MS.length - 1)
    scheduleNext(BOOTSTRAP_POLL_DELAYS_MS[unchangedPolls])
  }
  const refreshNow = () => {
    clearTimer()
    unchangedPolls = 0
    if (!isVisible()) return
    if (running) {
      refreshAfterCurrent = true
      return
    }
    void poll()
  }
  const handleVisibilityChange = () => {
    if (isVisible()) refreshNow()
    else {
      refreshAfterCurrent = false
      clearTimer()
    }
  }

  visibilityTarget.addEventListener('visibilitychange', handleVisibilityChange)
  pageShowTarget.addEventListener('pageshow', refreshNow)
  refreshNow()
  return () => {
    stopped = true
    refreshAfterCurrent = false
    clearTimer()
    visibilityTarget.removeEventListener('visibilitychange', handleVisibilityChange)
    pageShowTarget.removeEventListener('pageshow', refreshNow)
  }
}

function clearStoredStaffSession() {
  window.localStorage.removeItem('mbox.auth.token')
  window.localStorage.removeItem('mbox.auth.expires-at')
  window.localStorage.removeItem('mbox.actor.id')
  window.localStorage.removeItem('mbox.actor.name')
}

export default function App() {
  const isGuest = window.location.pathname.startsWith('/guest')
  const isMember = window.location.pathname.startsWith('/member')
  const isPublicReservation = window.location.pathname.startsWith('/reserve')
  const [data, setData] = useState<BootstrapResponse | null>(null)
  const [snapshot, setSnapshot] = useState<OfflineSnapshot | null>(null)
  const [error, setError] = useState('')
  const [guardNotice, setGuardNotice] = useState('')
  const [requiresLogin, setRequiresLogin] = useState(false)
  const [switchingEmployee, setSwitchingEmployee] = useState(false)
  const [staffMode, setStaffMode] = useState<'workspace' | 'voice'>('workspace')
  const [navigationRequest, setNavigationRequest] = useState<{ id: number; target: OperationsConsoleView } | null>(null)
  const [offlineStatus, setOfflineStatus] = useState<OfflineStatus>(() => getOfflineStatus())
  const previousPendingCount = useRef(offlineStatus.pendingCount)
  const latestRevision = useRef<number | null>(null)
  const refreshInFlight = useRef<Promise<boolean> | null>(null)
  const nextNavigationRequestId = useRef(0)

  const refresh = useCallback(() => {
    return runSingleFlight(refreshInFlight, async () => {
      try {
        const liveData = latestRevision.current === null
          ? await getBootstrap()
          : await getBootstrap(latestRevision.current)
        if (!liveData) {
          setError('')
          return false
        }
        latestRevision.current = liveData.revision
        const safeSnapshot = sanitizeBootstrapSnapshot(liveData)
        setData(liveData)
        setSnapshot(safeSnapshot)
        setError('')
        setRequiresLogin(false)
        try {
          await saveOfflineSnapshot(safeSnapshot)
        } catch {
          setGuardNotice('现场快照未能写入本机，断网重载时将不可用')
        }
        return true
      } catch (requestError) {
        if (requestError instanceof ApiError && requestError.status === 401) {
          clearStoredStaffSession()
          latestRevision.current = null
          setRequiresLogin(true)
        }
        setError(requestError instanceof Error ? requestError.message : '无法连接运营服务')
        return false
      }
    })
  }, [])
  const refreshWorkspace = useCallback(async () => {
    await refresh()
  }, [refresh])

  useEffect(() => subscribeOfflineStatus(setOfflineStatus), [])

  useEffect(() => {
    if (isGuest || isMember || isPublicReservation) return
    return applyStaffViewport()
  }, [isGuest, isMember, isPublicReservation])

  useEffect(() => {
    if (isGuest || isMember || isPublicReservation) return
    return startOfflineRuntime(replayQueuedTaskAction)
  }, [isGuest, isMember, isPublicReservation])

  useEffect(() => {
    if (isGuest || isMember || isPublicReservation) return
    void loadOfflineSnapshot().then(setSnapshot).catch(() => undefined)
  }, [isGuest, isMember, isPublicReservation])

  useEffect(() => startBootstrapPolling(
    !isGuest && !isMember && !isPublicReservation && !requiresLogin,
    refresh,
  ), [isGuest, isMember, isPublicReservation, refresh, requiresLogin])

  useEffect(() => {
    if (isGuest || isMember || isPublicReservation || requiresLogin || !window.localStorage.getItem('mbox.auth.token')) return
    let stopped = false
    let timer: number | undefined
    let heartbeatInFlight = false
    const schedule = (delay: number) => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => void heartbeat(), Math.max(5_000, delay))
    }
    const heartbeat = async () => {
      if (stopped || heartbeatInFlight) return
      heartbeatInFlight = true
      try {
        const presence = await heartbeatStaffPresence()
        if (!stopped) schedule(presence.heartbeatAfterMs)
      } catch (heartbeatError) {
        if (heartbeatError instanceof ApiError && heartbeatError.status === 401) {
          clearStoredStaffSession()
          latestRevision.current = null
          setRequiresLogin(true)
          setData(null)
          setSnapshot(null)
          return
        }
        if (!stopped) schedule(15_000)
      } finally {
        heartbeatInFlight = false
      }
    }
    const resumeHeartbeat = () => {
      if (document.visibilityState === 'visible') void heartbeat()
    }
    document.addEventListener('visibilitychange', resumeHeartbeat)
    window.addEventListener('pageshow', resumeHeartbeat)
    void heartbeat()
    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', resumeHeartbeat)
      window.removeEventListener('pageshow', resumeHeartbeat)
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [isGuest, isMember, isPublicReservation, requiresLogin])

  useEffect(() => {
    const syncJustCompleted = previousPendingCount.current > 0 && offlineStatus.pendingCount === 0
    previousPendingCount.current = offlineStatus.pendingCount
    if (!isGuest && !isMember && !isPublicReservation && offlineStatus.online && syncJustCompleted) void refresh()
  }, [isGuest, isMember, isPublicReservation, offlineStatus.online, offlineStatus.pendingCount, refresh])

  async function switchEmployee() {
    if (switchingEmployee) return
    if (offlineStatus.pendingCount > 0 && !window.confirm(
      `本机还有${offlineStatus.pendingCount}项未同步服务动作。切换员工会清除这些动作，请确认现场已人工交接。`,
    )) return
    setSwitchingEmployee(true)
    try {
      if (offlineStatus.online && window.localStorage.getItem('mbox.auth.token')) {
        await endStaffPresence().catch(() => undefined)
      }
      await clearOfflineDataForEmployeeChange()
      clearStoredStaffSession()
      setStaffMode('workspace')
      setNavigationRequest(null)
      latestRevision.current = null
      setData(null)
      setSnapshot(null)
      setError('')
      setRequiresLogin(true)
    } catch {
      setGuardNotice('本机离线数据清理失败，已保留当前员工会话并阻止切换')
    } finally {
      setSwitchingEmployee(false)
    }
  }

  if (isGuest) return <LazyWorkspace><GuestPortal /></LazyWorkspace>
  if (isMember) return <LazyWorkspace><MemberBenefitsPortal /></LazyWorkspace>
  if (isPublicReservation) return <LazyWorkspace><PublicReservationPortal /></LazyWorkspace>

  if (requiresLogin) {
    return <PilotLogin onAuthenticated={() => {
      latestRevision.current = null
      setData(null)
      setSnapshot(null)
      setRequiresLogin(false)
      setError('')
      setStaffMode('workspace')
      setNavigationRequest(null)
    }} />
  }

  if (snapshot && !offlineStatus.online) {
    return (
      <>
        <ConnectivityBanner status={offlineStatus} onRetry={refreshWorkspace} />
        <OfflineSnapshotView snapshot={snapshot} onSnapshotChange={setSnapshot} />
      </>
    )
  }

  if (error && !data) {
    return (
      <main className="system-state">
        <TriangleAlert size={28} />
        <h1>运营服务未连接</h1>
        <p>{error}</p>
        <p>本机还没有可用的脱敏现场快照。</p>
        <button className="primary-button" onClick={() => void refresh()}><RefreshCw size={17} />重新连接</button>
      </main>
    )
  }

  if (!data) {
    return <main className="system-state"><LoaderCircle className="spin" size={28} /><strong>正在载入现场状态</strong></main>
  }

  const currentActorId = getCurrentActorId()
  const currentActorName = window.localStorage.getItem('mbox.actor.name')
    ?? data.employees.find((employee) => employee.id === currentActorId)?.displayName
    ?? '已登录员工'
  const hasStaffIdentity = Boolean(window.localStorage.getItem('mbox.auth.token') || (import.meta.env.DEV && currentActorId))

  function blockRestrictedOfflineAction(event: ReactMouseEvent<HTMLDivElement>) {
    if (offlineStatus.online) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const button = target.closest('button')
    if (!button) return
    if (!button.closest(RESTRICTED_OFFLINE_VIEWS) && !button.classList.contains('reset-button')) return
    event.preventDefault()
    event.stopPropagation()
    setGuardNotice('离线期间只允许服务任务接单、到桌和完成；支付、退款、订单、预约、库存、会员、主数据及配置写操作已禁止')
  }

  return (
    <div
      className={offlineStatus.online ? 'app-connectivity-root' : 'app-connectivity-root is-offline'}
      data-voice-scope="staff"
      onClickCapture={blockRestrictedOfflineAction}
    >
      <ConnectivityBanner status={offlineStatus} onRetry={refreshWorkspace} />
      {hasStaffIdentity && (
        <div className="pilot-session-bar">
          <span>当前员工：<strong>{currentActorName}</strong></span>
          <div className="staff-mode-switch" role="group" aria-label="操作模式">
            <button className={staffMode === 'workspace' ? 'is-active' : ''} aria-pressed={staffMode === 'workspace'} onClick={() => setStaffMode('workspace')}>
              <LayoutDashboard size={15} />岗位页面
            </button>
            <button className={staffMode === 'voice' ? 'is-active' : ''} aria-pressed={staffMode === 'voice'} onClick={() => setStaffMode('voice')}>
              <Mic size={15} />AI值班经理
            </button>
          </div>
          <button disabled={switchingEmployee} onClick={() => void switchEmployee()}>
            {switchingEmployee ? <LoaderCircle className="spin" size={15} /> : <LogOut size={15} />}
            {switchingEmployee ? '正在清理' : '切换员工'}
          </button>
        </div>
      )}
      {guardNotice && (
        <div className="offline-guard-notice" role="alert">
          <ShieldAlert size={17} />{guardNotice}
          <button title="关闭提示" onClick={() => setGuardNotice('')}>关闭</button>
        </div>
      )}
      <LazyWorkspace>
        <OperationsConsole data={data} onRefresh={refreshWorkspace} navigationRequest={navigationRequest} />
        {staffMode === 'voice' && (
          <VoiceCommandMode
            data={data}
            employeeId={currentActorId}
            onReturn={() => setStaffMode('workspace')}
            onNavigate={(target) => {
              nextNavigationRequestId.current += 1
              setNavigationRequest({ id: nextNavigationRequestId.current, target })
            }}
          />
        )}
      </LazyWorkspace>
    </div>
  )
}

function PilotLogin({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [accessCode, setAccessCode] = useState('')
  const [storeAccessToken, setStoreAccessToken] = useState('')
  const [employees, setEmployees] = useState<PilotEmployeeOption[]>([])
  const [actorId, setActorId] = useState('')
  const [employeePin, setEmployeePin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function rememberStoreAccess(response: { storeAccessToken?: string; storeAccessExpiresAt?: number }) {
    if (!response.storeAccessToken || !response.storeAccessExpiresAt) return
    window.localStorage.setItem('mbox.store-access.token', response.storeAccessToken)
    window.localStorage.setItem('mbox.store-access.expires-at', String(response.storeAccessExpiresAt))
    setStoreAccessToken(response.storeAccessToken)
  }

  function clearStoreAccess() {
    window.localStorage.removeItem('mbox.store-access.token')
    window.localStorage.removeItem('mbox.store-access.expires-at')
    setStoreAccessToken('')
  }

  useEffect(() => {
    const token = window.localStorage.getItem('mbox.store-access.token') ?? ''
    const expiresAt = Number(window.localStorage.getItem('mbox.store-access.expires-at') ?? 0)
    if (!token || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      clearStoreAccess()
      return
    }
    let active = true
    setLoading(true)
    void getPilotEmployees('', token).then((response) => {
      if (!active) return
      const options = response.employees ?? []
      if (options.length === 0) throw new Error('当前没有可登录的在职员工')
      rememberStoreAccess(response)
      setEmployees(options)
      setActorId(options[0]!.id)
    }).catch((loginError) => {
      if (!active) return
      clearStoreAccess()
      setError(loginError instanceof Error ? loginError.message : '今天需要重新验证门店口令')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [])

  async function verifyAccess() {
    setLoading(true)
    setError('')
    try {
      const response = await getPilotEmployees(accessCode)
      const options = response.employees ?? []
      if (options.length === 0) throw new Error('当前没有可登录的在职员工')
      rememberStoreAccess(response)
      setEmployees(options)
      setActorId(options[0]!.id)
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : '验证失败')
    } finally {
      setLoading(false)
    }
  }

  async function login() {
    setLoading(true)
    setError('')
    try {
      const response = await createPilotSession(storeAccessToken, actorId, employeePin)
      if (!response.token || !response.employee) throw new Error('员工会话签发失败')
      rememberStoreAccess(response)
      await prepareOfflineDataForEmployee(response.employee.id)
      window.localStorage.setItem('mbox.auth.token', response.token)
      if (response.expiresAt) window.localStorage.setItem('mbox.auth.expires-at', String(response.expiresAt))
      window.localStorage.setItem('mbox.actor.id', response.employee.id)
      window.localStorage.setItem('mbox.actor.name', response.employee.displayName)
      onAuthenticated()
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="pilot-login-shell">
      <section className="pilot-login-panel">
        <div className="pilot-login-brand"><span>M</span><div><strong>M-BOX</strong><small>门店验证环境</small></div></div>
        <h1>{employees.length === 0 ? '验证访问身份' : '选择当前员工'}</h1>
        {employees.length === 0 ? (
          <label><span>门店验证口令</span><input type="password" autoComplete="current-password" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && accessCode) void verifyAccess() }} /></label>
        ) : (
          <><label><span>当前操作员工</span><select value={actorId} onChange={(event) => { setActorId(event.target.value); setEmployeePin('') }}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName} · {employee.roleName}</option>)}</select></label><label><span>员工PIN</span><input type="password" inputMode="numeric" autoComplete="current-password" minLength={4} maxLength={4} value={employeePin} onChange={(event) => setEmployeePin(event.target.value.replace(/\D/g, '').slice(0, 4))} onKeyDown={(event) => { if (event.key === 'Enter' && employeePin.length === 4) void login() }} /></label></>
        )}
        {error && <p className="pilot-login-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={loading || (employees.length === 0 ? !accessCode : !actorId || employeePin.length !== 4)} onClick={() => void (employees.length === 0 ? verifyAccess() : login())}>
          {loading ? <LoaderCircle className="spin" size={17} /> : <LogIn size={17} />}{employees.length === 0 ? '继续' : '进入运营台'}
        </button>
        {employees.length > 0 && <button className="pilot-login-back" onClick={() => { clearStoreAccess(); setEmployees([]); setActorId(''); setEmployeePin(''); setError('') }}>重新验证门店口令</button>}
      </section>
    </main>
  )
}

function ConnectivityBanner({ status, onRetry }: { status: OfflineStatus; onRetry: () => Promise<void> }) {
  if (status.conflict) {
    return (
      <div className="connectivity-banner is-conflict" role="alert">
        <TriangleAlert size={19} />
        <div>
          <strong>同步冲突，需要人工处理</strong>
          <span>任务 {status.conflict.taskId} · {status.conflict.message} · 幂等键 {status.conflict.idempotencyKey}</span>
        </div>
        <button
          className="secondary-button"
          onClick={() => {
            if (window.confirm('请确认该任务已由领班人工核对。移除冲突动作后，后续队列将继续同步。')) {
              void discardConflictedTaskAction(status.conflict!.queueId)
            }
          }}
        >人工核对后移除</button>
      </div>
    )
  }

  if (!status.online) {
    return (
      <div className="connectivity-banner is-offline" role="status">
        <WifiOff size={19} />
        <div>
          <strong>设备离线</strong>
          <span>{status.pendingCount > 0 ? `${status.pendingCount}项服务动作待同步` : '现场只读快照可用'} · 高风险写操作已禁止</span>
        </div>
        <button className="secondary-button" onClick={() => void onRetry()}><RefreshCw size={15} />重新连接</button>
      </div>
    )
  }

  if (status.syncing || status.pendingCount > 0) {
    return (
      <div className="connectivity-banner is-pending" role="status">
        <CloudUpload className={status.syncing ? 'pulse' : ''} size={19} />
        <div>
          <strong>{status.syncing ? '正在顺序同步服务动作' : `${status.pendingCount}项服务动作待同步`}</strong>
          <span>每个动作保留原始幂等键</span>
        </div>
        {!status.syncing && <button className="secondary-button" onClick={() => void replayTaskActionQueue()}>立即同步</button>}
      </div>
    )
  }

  return null
}

function OfflineSnapshotView({
  snapshot,
  onSnapshotChange,
}: {
  snapshot: OfflineSnapshot
  onSnapshotChange: (snapshot: OfflineSnapshot) => void
}) {
  const [busyTaskId, setBusyTaskId] = useState('')
  const [notice, setNotice] = useState('')
  const openTasks = snapshot.tasks.filter((task) => !['completed', 'confirmed', 'cancelled'].includes(task.status))

  async function handleAction(task: OfflineSnapshot['tasks'][number], action: TaskActionInput['action']) {
    if (!task.ownerId) {
      setNotice('该任务尚无责任人，需联网后由领班调度')
      return
    }
    setBusyTaskId(task.id)
    try {
      await actOnTask(task.id, {
        action,
        actorId: task.ownerId,
        note: action === 'complete' ? '现场服务完成' : '',
      })
      const now = new Date().toISOString()
      const next: OfflineSnapshot = {
        ...snapshot,
        tasks: snapshot.tasks.map((item) => item.id === task.id
          ? { ...item, status: nextTaskStatus(action), warningAt: item.warningAt }
          : item),
        capturedAt: now,
      }
      onSnapshotChange(next)
      await saveOfflineSnapshot(next)
      setNotice('动作已保存在本机，将按操作顺序自动同步')
    } catch (actionError) {
      setNotice(actionError instanceof Error ? actionError.message : '离线动作保存失败')
    } finally {
      setBusyTaskId('')
    }
  }

  return (
    <main className="offline-snapshot-shell">
      <header className="offline-snapshot-header">
        <div className="brand-lockup"><span>M</span><div><strong>{snapshot.store.name}</strong><small>现场离线快照</small></div></div>
        <div>
          <strong>{snapshot.store.businessDate}</strong>
          <span>快照 {formatChinaDateTime(snapshot.capturedAt)}</span>
        </div>
      </header>

      {notice && <div className="offline-action-notice" role="status">{notice}</div>}

      <section className="offline-summary-grid">
        <div><strong>{snapshot.metrics.occupiedTables}</strong><span>营业桌台</span></div>
        <div><strong>{openTasks.length}</strong><span>快照任务</span></div>
        <div><strong>{snapshot.metrics.atRiskTasks}</strong><span>SLA风险</span></div>
        <div><strong>{snapshot.metrics.complaints}</strong><span>投诉接管</span></div>
      </section>

      <section className="offline-task-section">
        <div className="section-heading">
          <div><span className="eyebrow">脱敏现场数据</span><h1>服务任务</h1></div>
          <span className="count-chip">{openTasks.length}</span>
        </div>
        <div className="offline-task-list">
          {openTasks.length === 0 && <div className="offline-empty"><CheckCheck size={24} /><strong>快照中没有待处理任务</strong></div>}
          {openTasks
            .toSorted((left, right) => taskPriority(right.priority) - taskPriority(left.priority) || left.createdAt.localeCompare(right.createdAt))
            .map((task) => {
              const table = snapshot.tables.find((item) => item.id === task.tableId)
              const serviceType = snapshot.serviceTypes.find((item) => item.id === task.serviceTypeId)
              const action = availableTaskAction(task.status)
              return (
                <article className={`offline-task-card priority-${task.priority}`} key={task.id}>
                  <div className="offline-task-title">
                    <span className="service-symbol">{serviceType && <ServiceIcon icon={serviceType.icon} size={18} />}</span>
                    <div><strong>{serviceType?.name ?? '服务任务'}</strong><span>{taskStatusLabel(task.status)}</span></div>
                  </div>
                  <div className="offline-task-meta">
                    <span><MapPin size={14} />{table?.displayName ?? task.tableId}</span>
                    <span><Clock3 size={14} />{formatChinaTime(task.createdAt)}</span>
                  </div>
                  <ol>{task.actionScript.map((step) => <li key={step}>{step}</li>)}</ol>
                  <div className="offline-task-action">
                    {action && (
                      <button className="primary-button" disabled={busyTaskId === task.id} onClick={() => void handleAction(task, action)}>
                        {action === 'accept' ? <Check size={17} /> : action === 'arrive' ? <Navigation size={17} /> : <CheckCheck size={17} />}
                        {action === 'accept' ? '接单' : action === 'arrive' ? '已到桌' : '完成服务'}
                      </button>
                    )}
                    {!task.ownerId && <span>等待领班分配</span>}
                  </div>
                </article>
              )
            })}
        </div>
      </section>
    </main>
  )
}

function availableTaskAction(status: OfflineSnapshot['tasks'][number]['status']): TaskActionInput['action'] | null {
  if (['pending', 'escalated', 'reopened'].includes(status)) return 'accept'
  if (status === 'accepted') return 'arrive'
  if (status === 'arrived') return 'complete'
  return null
}

function nextTaskStatus(action: TaskActionInput['action']): OfflineSnapshot['tasks'][number]['status'] {
  if (action === 'accept') return 'accepted'
  if (action === 'arrive') return 'arrived'
  if (action === 'complete') return 'confirmed'
  return 'pending'
}

function taskStatusLabel(status: OfflineSnapshot['tasks'][number]['status']) {
  return ({
    pending: '待接单',
    accepted: '已接单',
    arrived: '已到桌',
    completed: '已完成',
    confirmed: '已解决',
    reopened: '仍未解决',
    escalated: '已升级',
    cancelled: '已取消',
  } as const)[status]
}

function taskPriority(priority: OfflineSnapshot['tasks'][number]['priority']) {
  return ({ urgent: 4, high: 3, normal: 2, low: 1 } as const)[priority]
}
