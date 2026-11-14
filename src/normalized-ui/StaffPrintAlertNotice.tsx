import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { NormalizedApiClient } from '../normalized-api'
import { printAlertStations, type PrintAlert, type PrintAlertSnapshot } from '../shared/print-alerts'
import { hasNewPrintAlert, validatePrintAlertSnapshot } from './print-alert-notice-model'
import './staff-print-alert-notice.css'

const names = { bar: '吧台', kitchen: '后厨', cashier: '收银', generation: '票据生成', diagnostics: '打印终端故障' }

export function StaffPrintAlertNotice({api, permissions, canOpenDevices, compact = false, onNavigate}: {
  api: NormalizedApiClient; permissions: readonly string[]; canOpenDevices: boolean; compact?: boolean; onNavigate(route: string): void
}) {
  const enabled = printAlertStations(permissions).length > 0 || permissions.includes('kds.prepare')
  const signature = permissions.join(',')
  const [snapshot, setSnapshot] = useState<PrintAlertSnapshot | null>(null)
  const [stale, setStale] = useState(false), [forbidden, setForbidden] = useState(false)
  const [sound, setSound] = useState(false), [soundError, setSoundError] = useState('')
  const [mutedUntil, setMutedUntil] = useState(0)
  const [retry, setRetry] = useState(0)
  const audio = useRef<AudioContext | null>(null)
  const soundOn = useRef(false), hushUntil = useRef(0), lastSound = useRef(0)
  const known = useRef<PrintAlert[]>([]), audience = useRef('')
  const notice = useRef<HTMLElement | null>(null)
  // Dedicated production/pickup screens keep their full normal-state workspace.
  const showing = enabled && !forbidden && (!compact || stale || Boolean(snapshot?.alerts.length))
  useLayoutEffect(() => {
    const element = notice.current
    if (!element) return
    let height = -1
    const publish = (next: number) => {
      if (height === next) return
      height = next
      document.documentElement.style.setProperty('--staff-print-notice-height', `${next}px`)
      window.dispatchEvent(new Event('mbox:print-notice-resize'))
    }
    const observer = new ResizeObserver(() => publish(element.getBoundingClientRect().height))
    observer.observe(element); publish(element.getBoundingClientRect().height)
    return () => { observer.disconnect(); publish(0) }
  }, [showing, compact])

  const tone = async () => {
    const context = audio.current
    if (!context || !soundOn.current) return
    try {
      await context.resume()
      if (context.state !== 'running') throw new Error('audio unavailable')
      for (const offset of [0, 0.28]) {
        const oscillator = context.createOscillator(), gain = context.createGain()
        oscillator.connect(gain); gain.connect(context.destination)
        oscillator.frequency.value = 740
        const start = context.currentTime + offset
        gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.12, start + 0.02)
        gain.gain.linearRampToValueAtTime(0, start + 0.18)
        oscillator.start(start); oscillator.stop(start + 0.2)
      }
      setSoundError('')
    } catch { setSoundError('声音未能播放，请检查浏览器声音权限和电脑音量。') }
  }
  const play = useRef(tone)
  useEffect(() => { play.current = tone })
  useEffect(() => () => { soundOn.current = false; void audio.current?.close().catch(() => undefined) }, [])

  useEffect(() => {
    if (audience.current !== signature) {
      audience.current = signature; known.current = []
      setSnapshot(null); setStale(false); setForbidden(false)
    }
    if (!enabled) return
    let stopped = false, inFlight = false, denied = false
    const abort = new AbortController()
    const read = async () => {
      if (stopped || inFlight || denied || document.visibilityState !== 'visible') return
      inFlight = true
      try {
        const response = await api.getEndpoint<{data: unknown}>('/api/hardware/print-alerts', {signal: abort.signal, timeoutMs: 8000})
        if (stopped) return
        if (!validatePrintAlertSnapshot(response.data)) throw new Error('Invalid print alert response')
        const data = response.data, now = Date.now(), isNew = hasNewPrintAlert(known.current, data.alerts)
        if (isNew) { hushUntil.current = 0; setMutedUntil(0) }
        if (data.alerts.length && now >= hushUntil.current && (isNew || now - lastSound.current >= 60_000)) {
          lastSound.current = now
          void play.current()
        }
        known.current = data.alerts
        setSnapshot(data); setStale(false)
        if (now >= hushUntil.current) setMutedUntil(0)
      } catch (error) {
        if (stopped) return
        const status = (error as {status?: number}).status
        if (status === 401 || status === 403) { denied = true; setForbidden(true); setSnapshot(null) }
        setStale(true)
      } finally { inFlight = false }
    }
    void read()
    const interval = window.setInterval(() => void read(), 10_000)
    document.addEventListener('visibilitychange', read); window.addEventListener('online', read)
    return () => { stopped = true; abort.abort(); window.clearInterval(interval)
      document.removeEventListener('visibilitychange', read); window.removeEventListener('online', read) }
  }, [api, enabled, signature, retry])

  async function toggleSound() {
    if (soundOn.current) { soundOn.current = false; setSound(false); return }
    try {
      audio.current ??= new AudioContext()
      await audio.current.resume()
      if (audio.current.state !== 'running') throw new Error('Audio unavailable')
      soundOn.current = true; setSound(true); hushUntil.current = 0; setMutedUntil(0)
      await play.current()
    } catch { setSoundError('无法开启声音，请检查浏览器声音权限和电脑音量。') }
  }
  if (!showing) return null
  const alerts = snapshot?.alerts ?? [], active = alerts.length > 0
  const urgent = snapshot?.manager && alerts.some(alert => alert.escalated)
  const details = <div className="print-alert-content">
      {alerts.map(alert => <p key={alert.station}><strong>{names[alert.station]}</strong>：{alert.failed > 0 && (alert.station === 'diagnostics' ? `${alert.failed} 项待处理或待核验` : `${alert.failed} 张失败或结果不确定`)}{alert.failed > 0 && alert.stalled > 0 && '；'}{alert.stalled > 0 && `${alert.stalled} 张等待超过 90 秒`}{alert.escalated && ' · 已持续至少 3 分钟'}{stale && '（上次读取）'}</p>)}
      <details><summary>查看处理方法</summary><ol>
        <li>核对电子出品单和已经打印的纸票，先联系对应岗位确认，避免漏做或重复出品。</li>
        <li>检查纸卷、打印机电源、USB／网络连接和收银电脑上的打印桥程序。</li>
        <li>由有权限的人员查看失败原因；结果不确定时，核实原票后再决定是否补打。</li>
      </ol><p>状态变化后提醒会自动更新；已认领的故障仍需完成核验。暂缓声音不代表故障已处理。</p></details>
      <div className="print-alert-actions">
        {canOpenDevices && <button type="button" onClick={() => onNavigate('/staff/devices')}>查看打印设备与故障</button>}
        <button type="button" onClick={() => setRetry(value => value + 1)}>重新检查打印状态</button>
        {active && sound && <button type="button" onClick={() => { hushUntil.current = Date.now() + 300_000; setMutedUntil(hushUntil.current) }}>暂缓声音 5 分钟</button>}
      </div>
      {mutedUntil > 0 && <small>声音已暂缓，新故障仍会提醒。</small>}
    </div>
  return <aside ref={notice} className={`staff-print-alert-notice${active || stale ? ' needs-attention' : ''}${compact ? ' is-compact' : ''}`} aria-label="打印故障主动提醒">
    <div className="print-alert-heading">
      <span role={active || stale ? 'alert' : 'status'}>
        <strong>{stale ? '打印监测连接中断' : urgent ? '管理员请处理：打印异常持续未恢复' : active ? '打印异常，请核对出纸' : snapshot ? '打印监测中' : '正在连接打印监测'}</strong>
        {stale && !compact && <small>当前状态无法确认；请现场核对打印机和电子出品单。</small>}
      </span>
      <button type="button" aria-label={sound ? '关闭打印提醒声音' : '开启打印提醒声音'} aria-pressed={sound} onClick={() => void toggleSound()}>{compact ? sound ? '声音已开' : '开启声音' : sound ? '关闭打印提醒声音' : '开启打印提醒声音'}</button>
      {compact && (active || stale) && <details className="print-alert-compact"><summary aria-label="查看异常与处理方法">查看异常</summary>{details}</details>}
    </div>
    {(active || stale) && !compact && details}
    {soundError && <p role="status">{soundError}</p>}
    {sound && !compact && <small>新异常会响铃，同一未恢复异常每分钟提醒。本页须保持可见；切换应用或锁屏可能暂停，请确认电脑未静音。</small>}
  </aside>
}
