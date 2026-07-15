import {
  Check,
  CheckCheck,
  Clock3,
  CloudUpload,
  LoaderCircle,
  LogIn,
  LogOut,
  MapPin,
  Navigation,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
  WifiOff,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { ApiError, actOnTask, createPilotSession, getBootstrap, getPilotEmployees, replayQueuedTaskAction } from './api'
import './App.css'
import { GuestPortal } from './components/GuestPortal'
import { MemberBenefitsPortal } from './components/MemberBenefitsPortal'
import { OperationsConsole } from './components/OperationsConsole'
import { PublicReservationPortal } from './components/PublicReservationPortal'
import { ServiceIcon } from './components/ServiceIcon'
import {
  discardConflictedTaskAction,
  getOfflineStatus,
  loadOfflineSnapshot,
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

const RESTRICTED_OFFLINE_VIEWS = '.payment-view, .config-view, .benefit-view, .song-view, .master-view, .commerce-view, .reservation-view, .inventory-view'

export default function App() {
  const isGuest = window.location.pathname.startsWith('/guest')
  const isMember = window.location.pathname.startsWith('/member')
  const isPublicReservation = window.location.pathname.startsWith('/reserve')
  const [data, setData] = useState<BootstrapResponse | null>(null)
  const [snapshot, setSnapshot] = useState<OfflineSnapshot | null>(null)
  const [error, setError] = useState('')
  const [guardNotice, setGuardNotice] = useState('')
  const [requiresLogin, setRequiresLogin] = useState(false)
  const [offlineStatus, setOfflineStatus] = useState<OfflineStatus>(() => getOfflineStatus())
  const previousPendingCount = useRef(offlineStatus.pendingCount)

  const refresh = useCallback(async () => {
    try {
      const liveData = await getBootstrap()
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
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) setRequiresLogin(true)
      setError(requestError instanceof Error ? requestError.message : '无法连接运营服务')
    }
  }, [])

  useEffect(() => subscribeOfflineStatus(setOfflineStatus), [])

  useEffect(() => {
    if (isGuest || isMember || isPublicReservation) return
    return startOfflineRuntime(replayQueuedTaskAction)
  }, [isGuest, isMember, isPublicReservation])

  useEffect(() => {
    if (isGuest || isMember || isPublicReservation) return
    void loadOfflineSnapshot().then(setSnapshot).catch(() => undefined)
    void refresh()
    const timer = window.setInterval(() => {
      if (getOfflineStatus().online) void refresh()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [isGuest, isMember, isPublicReservation, refresh])

  useEffect(() => {
    const syncJustCompleted = previousPendingCount.current > 0 && offlineStatus.pendingCount === 0
    previousPendingCount.current = offlineStatus.pendingCount
    if (!isGuest && !isMember && !isPublicReservation && offlineStatus.online && syncJustCompleted) void refresh()
  }, [isGuest, isMember, isPublicReservation, offlineStatus.online, offlineStatus.pendingCount, refresh])

  if (isGuest) return <GuestPortal />
  if (isMember) return <MemberBenefitsPortal />
  if (isPublicReservation) return <PublicReservationPortal />

  if (requiresLogin) {
    return <PilotLogin onAuthenticated={() => {
      setRequiresLogin(false)
      setError('')
      void refresh()
    }} />
  }

  if (snapshot && !offlineStatus.online) {
    return (
      <>
        <ConnectivityBanner status={offlineStatus} onRetry={refresh} />
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
      onClickCapture={blockRestrictedOfflineAction}
    >
      <ConnectivityBanner status={offlineStatus} onRetry={refresh} />
      {window.localStorage.getItem('mbox.auth.token') && (
        <div className="pilot-session-bar">
          <span>当前员工：<strong>{window.localStorage.getItem('mbox.actor.name') ?? '已登录员工'}</strong></span>
          <button onClick={() => {
            window.localStorage.removeItem('mbox.auth.token')
            window.localStorage.removeItem('mbox.actor.id')
            window.localStorage.removeItem('mbox.actor.name')
            setData(null)
            setRequiresLogin(true)
          }}><LogOut size={15} />切换员工</button>
        </div>
      )}
      {guardNotice && (
        <div className="offline-guard-notice" role="alert">
          <ShieldAlert size={17} />{guardNotice}
          <button title="关闭提示" onClick={() => setGuardNotice('')}>关闭</button>
        </div>
      )}
      <OperationsConsole data={data} onRefresh={refresh} />
    </div>
  )
}

function PilotLogin({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [accessCode, setAccessCode] = useState('')
  const [employees, setEmployees] = useState<PilotEmployeeOption[]>([])
  const [actorId, setActorId] = useState('')
  const [employeePin, setEmployeePin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function verifyAccess() {
    setLoading(true)
    setError('')
    try {
      const response = await getPilotEmployees(accessCode)
      const options = response.employees ?? []
      if (options.length === 0) throw new Error('当前没有可登录的在职员工')
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
      const response = await createPilotSession(accessCode, actorId, employeePin)
      if (!response.token || !response.employee) throw new Error('员工会话签发失败')
      window.localStorage.setItem('mbox.auth.token', response.token)
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
        <div className="pilot-login-brand"><span>M</span><div><strong>M-Box</strong><small>门店验证环境</small></div></div>
        <h1>{employees.length === 0 ? '验证访问身份' : '选择当前员工'}</h1>
        {employees.length === 0 ? (
          <label><span>门店验证口令</span><input type="password" autoComplete="current-password" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && accessCode) void verifyAccess() }} /></label>
        ) : (
          <><label><span>当前操作员工</span><select value={actorId} onChange={(event) => { setActorId(event.target.value); setEmployeePin('') }}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName} · {employee.roleName}</option>)}</select></label><label><span>员工PIN</span><input type="password" inputMode="numeric" autoComplete="current-password" minLength={6} maxLength={12} value={employeePin} onChange={(event) => setEmployeePin(event.target.value.replace(/\D/g, '').slice(0, 12))} onKeyDown={(event) => { if (event.key === 'Enter' && employeePin.length >= 6) void login() }} /></label></>
        )}
        {error && <p className="pilot-login-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={loading || (employees.length === 0 ? !accessCode : !actorId || employeePin.length < 6)} onClick={() => void (employees.length === 0 ? verifyAccess() : login())}>
          {loading ? <LoaderCircle className="spin" size={17} /> : <LogIn size={17} />}{employees.length === 0 ? '继续' : '进入运营台'}
        </button>
        {employees.length > 0 && <button className="pilot-login-back" onClick={() => { setEmployees([]); setActorId(''); setEmployeePin(''); setError('') }}>重新输入口令</button>}
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
  const openTasks = snapshot.tasks.filter((task) => !['confirmed', 'cancelled'].includes(task.status))

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
          <span>快照 {new Date(snapshot.capturedAt).toLocaleString('zh-CN', { hour12: false })}</span>
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
                    <span><Clock3 size={14} />{new Date(task.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
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
  if (action === 'complete') return 'completed'
  return 'pending'
}

function taskStatusLabel(status: OfflineSnapshot['tasks'][number]['status']) {
  return ({
    pending: '待接单',
    accepted: '已接单',
    arrived: '已到桌',
    completed: '待客户确认',
    confirmed: '已解决',
    reopened: '仍未解决',
    escalated: '已升级',
    cancelled: '已取消',
  } as const)[status]
}

function taskPriority(priority: OfflineSnapshot['tasks'][number]['priority']) {
  return ({ urgent: 4, high: 3, normal: 2, low: 1 } as const)[priority]
}
