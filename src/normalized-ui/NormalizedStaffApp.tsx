import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, KeyRound, LoaderCircle, ShieldCheck, UserRound } from 'lucide-react'
import { NormalizedApiClient, NormalizedApiError, type StaffAuthView } from '../normalized-api'
import { NormalizedStaffWorkspace } from './NormalizedStaffWorkspace'
import { StaffActionsPanel } from './staff-actions'
import type { StaffActionsTab } from './staff-actions/types'
import { clearDeviceLease, getOrCreateDeviceKey, hasUsableDeviceLease, saveDeviceLease } from './staff-device'
import './normalized-staff-login.css'

export function NormalizedStaffApp({ api: suppliedApi }: { api?: NormalizedApiClient }) {
  const api = useMemo(() => suppliedApi ?? new NormalizedApiClient(), [suppliedApi])
  const [auth, setAuth] = useState<StaffAuthView | null>(null)
  const [phase, setPhase] = useState<'checking' | 'credential' | 'login' | 'ready'>('checking')
  const [message, setMessage] = useState<string | null>(null)
  const [staffRoute, setStaffRoute] = useState(() => normalizedStaffRoute(window.location.pathname))
  const authenticatedSessionId = auth?.session.id ?? null

  const checkSession = useCallback(async () => {
    setPhase('checking')
    try {
      const session = await api.getStaffSession()
      setAuth(session)
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

  if (phase === 'checking') return <StaffGateLoading />
  if (phase === 'credential') {
    return <DeviceCredentialForm api={api} onReady={() => { setMessage(null); setPhase('login') }} message={message} />
  }
  if (phase === 'login') {
    return <EmployeeLoginForm api={api} message={message} onCredentialRequired={() => {
      clearDeviceLease(); setMessage('这台设备需要重新验证门店口令'); setPhase('credential')
    }} onReady={(session) => { setMessage(null); setAuth(session); setPhase('ready') }} />
  }
  if (auth === null) return <StaffGateLoading />
  const loginRequired = () => { setAuth(null); setPhase('login') }
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
  if (staffRoute !== null) {
    return <main className="normalized-staff-action-shell">
      <header>
        <button type="button" onClick={() => {
          window.history.pushState({}, '', '/')
          setStaffRoute(null)
        }}><ArrowLeft size={18} /> 工作台</button>
        <strong>{auth.employee.displayName}</strong>
      </header>
      <StaffActionsPanel initialTab={staffRoute} onLoginRequired={loginRequired} />
    </main>
  }
  return <>
    {message !== null && <p className="normalized-route-notice" role="status">{message}</p>}
    <NormalizedStaffWorkspace api={api} onNavigate={navigate} onLoginRequired={loginRequired} />
  </>
}

function normalizedStaffRoute(path: string): StaffActionsTab | null {
  if (path === '/staff/live') return 'tables'
  if (path === '/staff/tasks') return 'service'
  if (path === '/staff/fulfillment') return 'fulfillment'
  return null
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
  return <main className="normalized-login"><section><header><span className="normalized-login-mark">M</span><div><strong>M-BOX</strong><small>陆家嘴现场运营</small></div></header><div className="normalized-login-copy"><p>STAFF ACCESS</p><h1>{title}</h1><span>{subtitle}</span></div>{children}</section></main>
}

function StaffGateLoading() {
  return <main className="normalized-login"><section className="normalized-login-loading"><LoaderCircle className="is-spinning" /><strong>正在连接门店工作台</strong></section></main>
}

function displayError(error: unknown, fallback: string) { return error instanceof Error && error.message.trim() ? error.message : fallback }
