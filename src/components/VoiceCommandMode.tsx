import {
  ArrowLeft,
  Check,
  ChevronRight,
  Keyboard,
  Mic,
  MicOff,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BootstrapResponse } from '../shared/contracts'
import type { OperationsConsoleView } from './OperationsConsole'
import { buildRoleHomeModel } from './role-access'
import {
  collectVoicePageControls,
  executeVoicePagePlan,
  planVoicePageCommand,
  readVoicePageState,
  type VoicePageControl,
  type VoicePagePlan,
  type VoicePageStateSnapshot,
} from './voice-page-controls'
import { resolveVoiceCommand, voiceSuggestionsForNavigation, type VoiceCommandResolution } from './voice-command'
import './VoiceCommandMode.css'

interface SpeechRecognitionEventLike {
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>
}

interface SpeechRecognitionErrorEventLike {
  error: string
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike
type VoiceWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}

type ResolvedCommand =
  | { source: 'page'; plan: VoicePagePlan }
  | { source: 'navigation'; resolution: VoiceCommandResolution }

interface VoiceCommandModeProps {
  data: BootstrapResponse
  employeeId: string
  onReturn: () => void
  onNavigate: (target: OperationsConsoleView) => void
}

function getVoiceScope() {
  return document.querySelector<HTMLElement>('[data-voice-scope="staff"]')
}

function controlsSignature(controls: VoicePageControl[]) {
  return controls.map((control) => [
    control.id,
    control.kind,
    control.label,
    control.context,
    control.zone,
    control.risk,
    control.disabled ? 1 : 0,
    control.generatedLabel ? 1 : 0,
    control.value ?? '',
  ].join(':')).join('|')
}

function commandForControl(control: VoicePageControl) {
  if (control.kind === 'input' || control.kind === 'textarea') return `在${control.displayName}输入内容`
  if (control.kind === 'select') return `${control.displayName}选择选项`
  if (control.kind === 'checkbox' || control.kind === 'radio') return `打开${control.displayName}`
  return `点击${control.displayName}`
}

function planReady(resolved: ResolvedCommand | null) {
  if (!resolved) return null
  if (resolved.source === 'page' && resolved.plan.kind === 'ready') return resolved.plan
  return null
}

export function VoiceCommandMode({ data, employeeId, onReturn, onNavigate }: VoiceCommandModeProps) {
  const model = useMemo(() => buildRoleHomeModel(data, employeeId), [data, employeeId])
  const navigationSuggestions = voiceSuggestionsForNavigation(model.access.allowedNavigationIds)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const controlsSignatureRef = useRef('')
  const executionSequence = useRef(0)
  const [controls, setControls] = useState<VoicePageControl[]>([])
  const [pageHeading, setPageHeading] = useState('岗位工作台')
  const [command, setCommand] = useState('')
  const [resolved, setResolved] = useState<ResolvedCommand | null>(null)
  const [listening, setListening] = useState(false)
  const [voiceMessage, setVoiceMessage] = useState('')
  const [executionMessage, setExecutionMessage] = useState('')
  const [executionTone, setExecutionTone] = useState<'success' | 'error' | 'working'>('success')
  const [speechEnabled, setSpeechEnabled] = useState(true)
  const [awaitingHighRiskConfirmation, setAwaitingHighRiskConfirmation] = useState(false)
  const recognitionSupported = Boolean(
    (window as VoiceWindow).SpeechRecognition || (window as VoiceWindow).webkitSpeechRecognition,
  )

  const refreshControls = useCallback(() => {
    const scope = getVoiceScope()
    if (!scope) return
    const nextControls = collectVoicePageControls(scope)
    const signature = controlsSignature(nextControls)
    if (signature !== controlsSignatureRef.current) {
      controlsSignatureRef.current = signature
      setControls(nextControls)
    }
    setPageHeading(readVoicePageState(scope).heading || '当前岗位页面')
  }, [])

  useEffect(() => {
    refreshControls()
    const scope = getVoiceScope()
    if (!scope) return undefined
    let frame = 0
    const scheduleRefresh = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(refreshControls)
    }
    const observer = new MutationObserver(scheduleRefresh)
    observer.observe(scope, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-disabled', 'aria-hidden', 'hidden', 'open', 'class', 'style'],
    })
    scope.addEventListener('input', scheduleRefresh, true)
    scope.addEventListener('change', scheduleRefresh, true)
    scope.addEventListener('click', scheduleRefresh, true)
    const fallbackTimer = window.setInterval(refreshControls, 3000)
    return () => {
      observer.disconnect()
      scope.removeEventListener('input', scheduleRefresh, true)
      scope.removeEventListener('change', scheduleRefresh, true)
      scope.removeEventListener('click', scheduleRefresh, true)
      window.cancelAnimationFrame(frame)
      window.clearInterval(fallbackTimer)
    }
  }, [refreshControls])

  useEffect(() => () => {
    recognitionRef.current?.abort()
    window.speechSynthesis?.cancel()
  }, [])

  function announce(message: string, tone: 'success' | 'error' | 'working' = 'success') {
    setExecutionMessage(message)
    setExecutionTone(tone)
    if (!speechEnabled || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(message)
    utterance.lang = 'zh-CN'
    utterance.rate = 1.05
    window.speechSynthesis.speak(utterance)
  }

  function resolveCommand(nextCommand: string) {
    const scope = getVoiceScope()
    const currentControls = scope ? collectVoicePageControls(scope) : controls
    const pagePlan = planVoicePageCommand(nextCommand, currentControls)
    if (pagePlan.kind !== 'unknown') return { source: 'page', plan: pagePlan } satisfies ResolvedCommand
    return {
      source: 'navigation',
      resolution: resolveVoiceCommand(nextCommand, model.access.allowedNavigationIds),
    } satisfies ResolvedCommand
  }

  function handleInternalCommand(nextCommand: string) {
    const normalized = nextCommand.replace(/\s+/g, '')
    if (/^(取消|取消执行|不要执行|算了)$/.test(normalized)) {
      setResolved(null)
      setAwaitingHighRiskConfirmation(false)
      announce('已取消，刚才的命令没有执行。')
      return true
    }
    if (/^(确认|确认执行|继续执行|执行)$/.test(normalized)) {
      void requestExecution()
      return true
    }
    if (/^(返回岗位页面|退出语音模式|关闭语音模式)$/.test(normalized)) {
      onReturn()
      return true
    }
    if (/^(关闭语音播报|不要播报)$/.test(normalized)) {
      window.speechSynthesis?.cancel()
      setSpeechEnabled(false)
      setExecutionMessage('语音播报已关闭，执行结果仍会显示在面板中。')
      setExecutionTone('success')
      return true
    }
    if (/^(打开语音播报|开启语音播报)$/.test(normalized)) {
      setSpeechEnabled(true)
      setExecutionMessage('语音播报已打开。')
      setExecutionTone('success')
      return true
    }
    if (/^(向下滚动|往下滚|下翻)$/.test(normalized)) {
      window.scrollBy({ top: Math.round(window.innerHeight * 0.7), behavior: 'smooth' })
      announce('已向下滚动。')
      return true
    }
    if (/^(向上滚动|往上滚|上翻)$/.test(normalized)) {
      window.scrollBy({ top: -Math.round(window.innerHeight * 0.7), behavior: 'smooth' })
      announce('已向上滚动。')
      return true
    }
    if (/^(回到顶部|返回顶部)$/.test(normalized)) {
      window.scrollTo({ top: 0, behavior: 'smooth' })
      announce('已回到页面顶部。')
      return true
    }
    return false
  }

  function prepareCommand(nextCommand: string) {
    const cleanCommand = nextCommand.trim()
    if (!cleanCommand) return
    setCommand(cleanCommand)
    setVoiceMessage('')
    if (handleInternalCommand(cleanCommand)) return
    const nextResolved = resolveCommand(cleanCommand)
    setResolved(nextResolved)
    setAwaitingHighRiskConfirmation(false)

    if (nextResolved.source === 'page') {
      if (nextResolved.plan.kind === 'blocked') announce(nextResolved.plan.message, 'error')
      if (nextResolved.plan.kind === 'ambiguous') announce(nextResolved.plan.message, 'error')
      return
    }
    if (nextResolved.resolution.kind === 'denied') announce(`当前岗位没有${nextResolved.resolution.label}权限，命令没有执行。`, 'error')
    if (nextResolved.resolution.kind === 'unknown') announce('这句话还不能安全匹配到当前页面操作，请说出完整按钮或字段名称。', 'error')
  }

  function startListening() {
    if (listening) {
      recognitionRef.current?.stop()
      return
    }
    const Recognition = (window as VoiceWindow).SpeechRecognition ?? (window as VoiceWindow).webkitSpeechRecognition
    if (!Recognition) {
      setVoiceMessage('这台设备暂不支持语音识别，可以直接输入命令。')
      return
    }
    const recognition = new Recognition()
    recognition.lang = 'zh-CN'
    recognition.continuous = false
    recognition.interimResults = true
    recognition.onresult = (event) => {
      let transcript = ''
      for (let index = 0; index < event.results.length; index += 1) transcript += event.results[index]?.[0]?.transcript ?? ''
      setCommand(transcript.trim())
      if (event.results[event.results.length - 1]?.isFinal) prepareCommand(transcript)
    }
    recognition.onerror = (event) => {
      const messages: Record<string, string> = {
        'not-allowed': '麦克风没有授权，可以继续输入命令。',
        'no-speech': '没有听清，再说一次或直接输入命令。',
        network: '语音识别暂时无法连接，请直接输入命令。',
      }
      setVoiceMessage(messages[event.error] ?? '这次没有听清，请再说一次。')
      setListening(false)
    }
    recognition.onend = () => setListening(false)
    recognitionRef.current = recognition
    setVoiceMessage('正在听，请说出按钮、字段或要完成的操作。')
    setListening(true)
    try {
      recognition.start()
    } catch {
      setListening(false)
      setVoiceMessage('麦克风暂时无法启动，可以直接输入命令。')
    }
  }

  async function waitForPageFeedback(
    sequence: number,
    before: VoicePageStateSnapshot,
    fallbackMessage: string,
  ) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 250))
      if (executionSequence.current !== sequence) return
      const scope = getVoiceScope()
      if (!scope) return
      const after = readVoicePageState(scope)
      const newFeedback = after.feedback.find((message) => !before.feedback.includes(message))
      if (newFeedback) {
        if (/正在载入|正在加载|加载中|处理中/.test(newFeedback)) {
          announce(newFeedback, 'working')
          continue
        }
        announce(newFeedback, /失败|错误|拒绝|不能|不可|无效|未保存/.test(newFeedback) ? 'error' : 'success')
        refreshControls()
        return
      }
      if (after.heading && before.heading && after.heading !== before.heading) {
        announce(`已打开${after.heading}。`)
        refreshControls()
        return
      }
    }
    announce(fallbackMessage)
    refreshControls()
  }

  async function executeResolvedCommand() {
    if (!resolved) {
      announce('当前没有等待确认的命令。', 'error')
      return
    }
    setAwaitingHighRiskConfirmation(false)

    if (resolved.source === 'navigation') {
      if (resolved.resolution.kind !== 'ready') {
        announce('当前命令没有通过权限检查。', 'error')
        return
      }
      const navigationLabel = resolved.resolution.label
      onNavigate(resolved.resolution.target)
      setResolved(null)
      announce(`正在打开${navigationLabel}。`, 'working')
      window.setTimeout(() => {
        refreshControls()
        announce(`已打开${navigationLabel}。`)
      }, 350)
      return
    }

    if (resolved.plan.kind !== 'ready') {
      announce('当前命令还不能执行，请重新说完整命令。', 'error')
      return
    }
    const scope = getVoiceScope()
    if (!scope) {
      announce('岗位页面暂时不可用，命令没有执行。', 'error')
      return
    }
    const before = readVoicePageState(scope)
    const sequence = executionSequence.current + 1
    executionSequence.current = sequence
    const result = executeVoicePagePlan(resolved.plan, scope)
    setResolved(null)
    if (!result.ok) {
      announce(result.message, 'error')
      return
    }
    if (resolved.plan.action !== 'activate') {
      announce(result.message)
      refreshControls()
      return
    }
    announce(`${result.message}正在等待页面反馈。`, 'working')
    await waitForPageFeedback(sequence, before, result.message)
  }

  async function requestExecution() {
    if (!resolved) {
      announce('当前没有等待确认的命令。', 'error')
      return
    }
    const pagePlan = planReady(resolved)
    if (pagePlan?.risk === 'high' && !awaitingHighRiskConfirmation) {
      setAwaitingHighRiskConfirmation(true)
      announce('这是高风险操作，请再次说“确认执行”，或者点击红色确认按钮。', 'error')
      return
    }
    await executeResolvedCommand()
  }

  const pageSuggestions = controls
    .filter((control) => !control.disabled && ['button', 'link'].includes(control.kind))
    .filter((control) => control.zone === 'page')
    .filter((control) => !['关闭导航', '打开导航', '顾客端'].includes(control.label))
    .slice(0, 4)
  const generatedLabelCount = controls.filter((control) => control.generatedLabel).length
  const pagePlan = resolved?.source === 'page' ? resolved.plan : null
  const navigationResolution = resolved?.source === 'navigation' ? resolved.resolution : null
  const readySummary = pagePlan?.kind === 'ready'
    ? pagePlan.summary
    : navigationResolution?.kind === 'ready' ? navigationResolution.summary : ''
  const readyRisk = pagePlan?.kind === 'ready' ? pagePlan.risk : 'normal'
  const ready = pagePlan?.kind === 'ready' || navigationResolution?.kind === 'ready'

  return (
    <>
      <button className="voice-mode-backdrop" data-voice-ignore aria-label="返回岗位页面" onClick={onReturn} />
      <aside className="voice-command-mode" data-voice-ignore role="dialog" aria-modal="true" aria-label="语音命令模式">
        <header className="voice-mode-header">
          <div className="voice-mode-brand"><span>M</span><div><strong>M-BOX 语音命令</strong><small>{model.employee?.displayName ?? '当前员工'} · {model.access.roleLabel}</small></div></div>
          <div className="voice-mode-header-actions">
            <button className="icon-button" title={speechEnabled ? '关闭语音播报' : '打开语音播报'} onClick={() => {
              window.speechSynthesis?.cancel()
              setSpeechEnabled((enabled) => !enabled)
            }}>{speechEnabled ? <Volume2 size={17} /> : <VolumeX size={17} />}</button>
            <button className="secondary-button" onClick={onReturn}><ArrowLeft size={17} />岗位页面</button>
          </div>
        </header>

        <section className="voice-command-stage">
          <div className="voice-page-status">
            <span><ShieldCheck size={15} />{pageHeading}</span>
            <strong>{controls.length} 个可语音控件{generatedLabelCount > 0 ? ` · ${generatedLabelCount} 个待命名` : ''}</strong>
          </div>
          {generatedLabelCount > 0 && (
            <div className="voice-command-warning" role="alert">
              当前页有 {generatedLabelCount} 个控件缺少明确名称，暂用页面位置命名；管理员应补齐名称后再作为正式口令使用。
            </div>
          )}
          <div className="voice-command-heading">
            <h1>说出按钮或要完成的操作</h1>
            <p>例如“点击立即开台”“人数输入4”“收费方式选择现金”。</p>
          </div>

          <button
            className={listening ? 'voice-mic-button is-listening' : 'voice-mic-button'}
            aria-pressed={listening}
            onClick={startListening}
          >
            {listening ? <MicOff size={29} /> : <Mic size={29} />}
            <span>{listening ? '点击结束' : recognitionSupported ? '点击说话' : '语音不可用'}</span>
          </button>
          {voiceMessage && <div className="voice-inline-message" role="status">{voiceMessage}</div>}

          <form className="voice-command-input" onSubmit={(event) => { event.preventDefault(); prepareCommand(command) }}>
            <Keyboard size={18} />
            <input
              aria-label="输入自然语言命令"
              value={command}
              maxLength={160}
              placeholder="输入按钮、字段或操作名称"
              onChange={(event) => { setCommand(event.target.value); setResolved(null); setAwaitingHighRiskConfirmation(false) }}
            />
            <button className="primary-button" disabled={!command.trim()}><Sparkles size={16} />理解</button>
          </form>

          {ready && (
            <div className={`voice-confirmation ${readyRisk === 'high' ? 'is-high-risk' : ''}`} role="status">
              <div>{readyRisk === 'high' ? <ShieldAlert size={21} /> : <Check size={21} />}<span><small>{readyRisk === 'high' ? '高风险操作' : '我理解的是'}</small><strong>{readySummary}</strong>{readyRisk === 'high' && <p>需要再次确认，仍由原页面权限、审批和校验决定是否成功。</p>}</span></div>
              <div className="voice-confirm-actions">
                <button className="secondary-button" onClick={() => { setResolved(null); setAwaitingHighRiskConfirmation(false) }}><X size={16} />取消</button>
                <button className={awaitingHighRiskConfirmation ? 'voice-danger-confirm' : 'primary-button'} onClick={() => void requestExecution()}>
                  <Check size={16} />{awaitingHighRiskConfirmation ? '再次确认执行' : '确认执行'}
                </button>
              </div>
            </div>
          )}
          {pagePlan?.kind === 'ambiguous' && (
            <div className="voice-command-warning" role="alert"><strong>{pagePlan.message}</strong><span>{pagePlan.candidates.join('；')}</span></div>
          )}
          {(pagePlan?.kind === 'blocked' || pagePlan?.kind === 'unknown') && <div className="voice-command-warning" role="alert">{pagePlan.message}</div>}
          {navigationResolution?.kind === 'denied' && <div className="voice-command-warning" role="alert">当前岗位没有“{navigationResolution.label}”权限，命令未执行。</div>}
          {navigationResolution?.kind === 'unknown' && <div className="voice-command-warning" role="alert">没有匹配到当前页面控件，请说完整按钮或字段名称。</div>}

          {executionMessage && (
            <div className={`voice-execution-result is-${executionTone}`} role="status" aria-live="polite">
              {executionTone === 'error' ? <ShieldAlert size={18} /> : <Check size={18} />}
              <span><small>{executionTone === 'working' ? '执行中' : executionTone === 'error' ? '未执行/执行失败' : '执行反馈'}</small><strong>{executionMessage}</strong></span>
            </div>
          )}

          <div className="voice-suggestions">
            <span>当前页常用</span>
            <div>
              {pageSuggestions.map((control) => <button key={control.id} onClick={() => prepareCommand(commandForControl(control))}>{commandForControl(control)}</button>)}
              {pageSuggestions.length === 0 && navigationSuggestions.slice(0, 4).map((item) => <button key={item.command} onClick={() => prepareCommand(item.command)}>{item.command}</button>)}
            </div>
          </div>

          <details className="voice-command-catalog">
            <summary>查看本页全部语音命令 <ChevronRight size={15} /></summary>
            <div>{controls.map((control) => (
              <button key={control.id} disabled={control.disabled} onClick={() => prepareCommand(commandForControl(control))}>
                <span>{commandForControl(control)}</span><small>{control.disabled ? '当前不可用' : control.risk === 'high' ? '需要二次确认' : control.kind}</small>
              </button>
            ))}</div>
          </details>
        </section>
        <footer className="voice-mode-footer">所有操作复用原岗位页面；敏感字段必须手工输入。</footer>
      </aside>
    </>
  )
}
