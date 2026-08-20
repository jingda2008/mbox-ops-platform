import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, KeyRound, LoaderCircle, LogOut, Repeat2, ShieldCheck, UserRound, X } from 'lucide-react'
import { NormalizedApiClient, NormalizedApiError, type StaffAuthView } from '../normalized-api'
import type { StaffBootstrapView } from '../shared/normalized-contracts'
import { NormalizedStaffWorkspace, StaffBottomNavigation } from './NormalizedStaffWorkspace'
import { StaffModulePanel } from './StaffModulePanel'
import { StaffActionsPanel } from './staff-actions'
import type { StaffActionsTab } from './staff-actions/types'
import { normalizedStaffRoute, type NormalizedStaffRoute } from './normalized-staff-routes'
import { clearDeviceLease, getOrCreateDeviceKey, hasUsableDeviceLease, saveDeviceLease } from './staff-device'
import './normalized-staff-login.css'

export function NormalizedStaffApp({ api: suppliedApi }: { api?: NormalizedApiClient }) {
  const api = useMemo(() => suppliedApi ?? new NormalizedApiClient(), [suppliedApi])
  const [auth, setAuth] = useState<StaffAuthView | null>(null)
  const [phase, setPhase] = useState<'checking' | 'credential' | 'login' | 'ready'>('checking')
  const [message, setMessage] = useState<string | null>(null)
  const [initialBootstrap, setInitialBootstrap] = useState<StaffBootstrapView | null>(null)
  const [staffRoute, setStaffRoute] = useState(() => normalizedStaffRoute(window.location.pathname))
  const [staffNavigation, setStaffNavigation] = useState<StaffBootstrapView['navigation'] | null>(null)
  const authenticatedSessionId = auth?.session.id ?? null
  const rememberStaffNavigation = useCallback((bootstrap: StaffBootstrapView) => {
    setStaffNavigation(bootstrap.navigation)
  }, [])

  const checkSession = useCallback(async () => {
    setPhase('checking')
    try {
      const [session, bootstrapResult] = await Promise.all([
        api.getStaffSession(),
        api.getStaffBootstrap().catch(() => null),
      ])
      setAuth(session)
      setInitialBootstrap(bootstrapResult?.data ?? null)
      if (bootstrapResult?.data !== null && bootstrapResult?.data !== undefined) {
        setStaffNavigation(bootstrapResult.data.navigation)
      }
      setPhase('ready')
    } catch (error) {
      setAuth(null)
      setPhase(hasUsableDeviceLease() ? 'login' : 'credential')
      if (!(error instanceof NormalizedApiError && error.recovery === 'login')) {
        setMessage(displayError(error, '暂时没有连上门店系统，请重试'))
      }
    }
  }, [api])

  useEffect(() => { void checkSession() }, [checkSession])
  useEffect(() => {
    if (phase !== 'ready' || authenticatedSessionId === null) return
    let stopped = false
    let inFlight = false
    const heartbeat = async () => {
      if (stopped || inFlight) return
      inFlight = true
      try {
        const next = await api.heartbeatStaff()
        if (!stopped) setAuth(next)
      } catch (error) {
        if (!stopped && error instanceof NormalizedApiError && error.recovery === 'login') {
          setAuth(null)
          setStaffNavigation(null)
          setMessage('登录状态已结束，请重新登录')
          setPhase('login')
        }
      } finally {
        inFlight = false
      }
    }
    const resume = () => {
      if (document.visibilityState === 'visible') void heartbeat()
    }
    const timer = globalThis.setInterval(() => void heartbeat(), 45_000)
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('online', resume)
    void heartbeat()
    return () => {
      stopped = true
      globalThis.clearInterval(timer)
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('online', resume)
    }
  }, [api, authenticatedSessionId, phase])
  useEffect(() => {
    const syncRoute = () => setStaffRoute(normalizedStaffRoute(window.location.pathname))
    window.addEventListener('popstate', syncRoute)
    return () => window.removeEventListener('popstate', syncRoute)
  }, [])
  useEffect(() => { setStaffNavigation(null) }, [authenticatedSessionId])
  useEffect(() => {
    if (phase !== 'ready' || auth === null || staffRoute === null || staffNavigation !== null) return
    const controller = new AbortController()
    void api.getStaffBootstrap({ signal: controller.signal }).then((result) => {
      if (result.data !== null) setStaffNavigation(result.data.navigation)
    }).catch((error) => {
      if (error instanceof NormalizedApiError && error.recovery === 'login') {
        setAuth(null)
        setPhase('login')
      }
    })
    return () => controller.abort()
  }, [api, auth, phase, staffNavigation, staffRoute])

  if (phase === 'checking') return <StaffGateLoading />
  if (phase === 'credential') {
    return <DeviceCredentialForm api={api} onReady={() => { setMessage(null); setPhase('login') }} message={message} />
  }
  if (phase === 'login') {
    return <EmployeeLoginForm api={api} message={message} onCredentialRequired={() => {
      clearDeviceLease(); setMessage('这台设备需要重新验证门店口令'); setPhase('credential')
    }} onReady={(session) => { setMessage(null); setStaffNavigation(null); setAuth(session); setPhase('ready') }} />
  }
  if (auth === null) return <StaffGateLoading />
  const loginRequired = () => { setAuth(null); setStaffNavigation(null); setPhase('login') }
  const switchReady = (session: StaffAuthView) => {
    window.history.replaceState({}, '', '/')
    setStaffRoute(null)
    setMessage(null)
    setStaffNavigation(null)
    setInitialBootstrap(null)
    setAuth(session)
  }
  const logoutReady = () => {
    window.history.replaceState({}, '', '/')
    setStaffRoute(null)
    setMessage(null)
    loginRequired()
  }
  const navigate = (route: string) => {
    const next = normalizedStaffRoute(route)
    if (next === null) {
      setMessage('这个岗位入口仍在规范化改造中，当前版本不会打开旧系统页面。')
      return
    }
    window.history.pushState({}, '', route)
    setMessage(null)
    setStaffRoute(next)
  }
  const sessionControls = <StaffSessionMenu
    api={api}
    auth={auth}
    onSwitched={switchReady}
    onLoggedOut={logoutReady}
  />
  const content = staffRoute !== null ? (
    <main className="normalized-staff-action-shell">
      <header>
        <button type="button" onClick={() => {
          window.history.pushState({}, '', '/')
          setStaffRoute(null)
        }}><ArrowLeft size={18} /> 工作台</button>
        {sessionControls}
      </header>
      {isStaffActionsTab(staffRoute)
        ? <StaffActionsPanel initialTab={staffRoute} onLoginRequired={loginRequired} />
        : <StaffModulePanel api={api} auth={auth} module={staffRoute} onLoginRequired={loginRequired} />}
    </main>
  ) : (<>
      {message !== null && <p className="normalized-route-notice" role="status">{message}</p>}
      <NormalizedStaffWorkspace
        key={authenticatedSessionId}
        api={api}
        initialBootstrap={initialBootstrap}
        onNavigate={navigate}
        onLoginRequired={loginRequired}
        onBootstrapReady={rememberStaffNavigation}
        showMobileNavigation={false}
        sessionControls={sessionControls}
      />
    </>)
  return <>
    {content}
    {staffNavigation !== null && <StaffBottomNavigation
      entries={staffNavigation}
      activeRoute={staffRoute === null ? null : window.location.pathname}
      onNavigate={navigate}
    />}
  </>
}

function StaffSessionMenu({ api, auth, onSwitched, onLoggedOut }: {
  api: NormalizedApiClient
  auth: StaffAuthView
  onSwitched: (session: StaffAuthView) => void
  onLoggedOut: () => void
}) {
  const [open, setOpen] = useState(false)
  const [employeeCode, setEmployeeCode] = useState('')
  const [pin, setPin] = useState('')
  const [pending, setPending] = useState(false)
  const [logoutArmed, setLogoutArmed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    if (pending) return
    setOpen(false)
    setPin('')
    setError(null)
    setLogoutArmed(false)
  }
  const submitSwitch = async (event: FormEvent) => {
    event.preventDefault()
    if (pending || employeeCode.trim() === '' || pin.length !== 4) return
    setPending(true)
    setError(null)
    setLogoutArmed(false)
    try {
      const session = await api.switchStaff({ employeeCode: employeeCode.trim(), pin })
      setEmployeeCode('')
      setPin('')
      setOpen(false)
      onSwitched(session)
    } catch (reason) {
      if (reason instanceof NormalizedApiError && reason.status === 401) {
        setError('账号、PIN或当前登录状态无效，请核对后重试')
      } else {
        setError(displayError(reason, '员工切换暂时没有完成，请重试'))
      }
    } finally {
      setPending(false)
    }
  }
  const logout = async () => {
    if (pending) return
    if (!logoutArmed) {
      setLogoutArmed(true)
      setError(null)
      return
    }
    setPending(true)
    setError(null)
    try {
      await api.logoutStaff()
      setOpen(false)
      onLoggedOut()
    } catch (reason) {
      setLogoutArmed(false)
      setError(displayError(reason, '退出结果无法确认，请重试'))
    } finally {
      setPending(false)
    }
  }

  return <StaffSessionMenuView
    currentEmployee={auth.employee.displayName}
    currentEmployeeCode={auth.employee.code}
    open={open}
    employeeCode={employeeCode}
    pin={pin}
    pending={pending}
    logoutArmed={logoutArmed}
    error={error}
    onOpen={() => { setOpen(true); setError(null); setLogoutArmed(false) }}
    onClose={close}
    onEmployeeCodeChange={setEmployeeCode}
    onPinChange={(value) => setPin(value.replace(/\D/g, '').slice(0, 4))}
    onSwitch={(event) => void submitSwitch(event)}
    onLogout={() => void logout()}
  />
}

export function StaffSessionMenuView({
  currentEmployee,
  currentEmployeeCode,
  open,
  employeeCode,
  pin,
  pending,
  logoutArmed,
  error,
  onOpen,
  onClose,
  onEmployeeCodeChange,
  onPinChange,
  onSwitch,
  onLogout,
}: {
  currentEmployee: string
  currentEmployeeCode: string
  open: boolean
  employeeCode: string
  pin: string
  pending: boolean
  logoutArmed: boolean
  error: string | null
  onOpen: () => void
  onClose: () => void
  onEmployeeCodeChange: (value: string) => void
  onPinChange: (value: string) => void
  onSwitch: (event: FormEvent) => void
  onLogout: () => void
}) {
  return <>
    <button type="button" className="normalized-session-trigger" aria-label={`${currentEmployee}，切换账号`} aria-expanded={open} onClick={onOpen}>
      <UserRound size={17} aria-hidden="true" />
      <span><strong>{currentEmployee}</strong><small>切换员工</small></span>
    </button>
    {open && <>
      <button type="button" className="normalized-session-backdrop" aria-label="关闭员工切换" onClick={onClose} />
      <section className="normalized-session-dialog" role="dialog" aria-modal="true" aria-labelledby="staff-switch-title">
        <header>
          <div><small>当前员工 · {currentEmployeeCode}</small><h2 id="staff-switch-title">切换员工</h2></div>
          <button type="button" aria-label="关闭员工切换" onClick={onClose} disabled={pending}><X size={20} /></button>
        </header>
        <p className="normalized-session-boundary">门店设备保持验证，只结束当前员工工作状态；下一位员工必须输入自己的账号和四位 PIN。</p>
        <form className="normalized-session-form" onSubmit={onSwitch}>
          <label><span>下一位员工账号</span><input autoFocus autoComplete="username" value={employeeCode} onChange={(event) => onEmployeeCodeChange(event.target.value)} /></label>
          <label><span>四位 PIN</span><input inputMode="numeric" type="password" autoComplete="current-password" maxLength={4} pattern="[0-9]{4}" value={pin} onChange={(event) => onPinChange(event.target.value)} /></label>
          {error !== null && <p role="alert">{error}</p>}
          <button type="submit" disabled={pending || employeeCode.trim() === '' || pin.length !== 4}>{pending ? <LoaderCircle className="is-spinning" /> : <Repeat2 />} 验证并切换</button>
        </form>
        <div className="normalized-session-logout">
          <span><strong>结束当前员工状态</strong><small>退出后返回员工登录页，不会清除门店设备验证。</small></span>
          <button type="button" className={logoutArmed ? 'is-confirming' : undefined} disabled={pending} onClick={onLogout}><LogOut size={17} />{logoutArmed ? '再次确认退出' : '退出当前员工'}</button>
        </div>
      </section>
    </>}
  </>
}

function isStaffActionsTab(route: NormalizedStaffRoute): route is StaffActionsTab {
  return route === 'tables' || route === 'tasks' || route === 'fulfillment' || route === 'reservations'
}

function DeviceCredentialForm({ api, onReady, message }: {
  api: NormalizedApiClient
  onReady: () => void
  message: string | null
}) {
  const [credential, setCredential] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(message)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    setPending(true); setError(null)
    try {
      const result = await api.grantDeviceAccess({ credential, deviceKey: getOrCreateDeviceKey() })
      saveDeviceLease(result.expiresAt)
      setCredential('')
      onReady()
    } catch (reason) {
      setError(displayError(reason, '门店口令没有通过，请核对后重试'))
    } finally { setPending(false) }
  }
  return <StaffLoginShell title="验证门店设备" subtitle="每天首次使用时验证一次，之后切换员工无需重复输入。">
    <form className="normalized-login-form" onSubmit={(event) => void submit(event)}>
      <label><span>门店口令</span><div className="normalized-login-field"><KeyRound size={18} /><input autoFocus type="password" autoComplete="off" value={credential} onChange={(event) => setCredential(event.target.value)} /></div></label>
      {error && <p className="normalized-login-error" role="alert">{error}</p>}
      <button type="submit" disabled={pending || credential.length < 6}>{pending ? <LoaderCircle className="is-spinning" /> : <ShieldCheck />} 验证设备</button>
    </form>
  </StaffLoginShell>
}

function EmployeeLoginForm({ api, onReady, onCredentialRequired, message }: {
  api: NormalizedApiClient
  onReady: (session: StaffAuthView) => void
  onCredentialRequired: () => void
  message: string | null
}) {
  const [employeeCode, setEmployeeCode] = useState('')
  const [pin, setPin] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(message)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    setPending(true); setError(null)
    try {
      onReady(await api.loginStaff({ employeeCode: employeeCode.trim(), pin }))
    } catch (reason) {
      if (reason instanceof NormalizedApiError && reason.code === 'DEVICE_ACCESS_REQUIRED') {
        onCredentialRequired()
      } else if (reason instanceof NormalizedApiError && reason.status === 401) {
        setError('账号、PIN或设备验证无效，请核对后重试')
      }
      else setError(displayError(reason, '登录暂时没有完成，请重试'))
    } finally { setPending(false) }
  }
  return <StaffLoginShell title="员工登录" subtitle="登录后6小时内保持工作状态。">
    <form className="normalized-login-form" onSubmit={(event) => void submit(event)}>
      <label><span>员工账号</span><div className="normalized-login-field"><UserRound size={18} /><input autoFocus autoComplete="username" value={employeeCode} onChange={(event) => setEmployeeCode(event.target.value)} /></div></label>
      <label><span>四位 PIN</span><div className="normalized-login-field"><KeyRound size={18} /><input inputMode="numeric" type="password" autoComplete="current-password" maxLength={4} pattern="[0-9]{4}" value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))} /></div></label>
      {error && <p className="normalized-login-error" role="alert">{error}</p>}
      <button type="submit" disabled={pending || employeeCode.trim() === '' || pin.length !== 4}>{pending ? <LoaderCircle className="is-spinning" /> : <ArrowRight />} 进入工作台</button>
    </form>
  </StaffLoginShell>
}

function StaffLoginShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return <main className="normalized-login"><section><header><span className="normalized-login-mark">M</span><div><strong>M-BOX</strong><small>SUPERHIGH CULTURE · 陆家嘴现场运营</small></div></header><div className="normalized-login-copy"><p>STAFF ACCESS</p><h1>{title}</h1><span>{subtitle}</span></div>{children}</section></main>
}

function StaffGateLoading() {
  return <main className="normalized-login"><section className="normalized-login-loading"><LoaderCircle className="is-spinning" /><strong>正在连接门店工作台</strong></section></main>
}

function displayError(error: unknown, fallback: string) { return error instanceof Error && error.message.trim() ? error.message : fallback }
