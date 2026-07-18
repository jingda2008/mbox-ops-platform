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
  canConfirmVoicePageStateChange,
  collectVoicePageControls,
  executeVoicePagePlan,
  planVoicePageCommand,
  readVoicePageState,
  type VoicePageControl,
  type VoicePagePlan,
  type VoicePageStateSnapshot,
} from './voice-page-controls'
import { resolveVoiceCommand, voiceSuggestionsForNavigation, type VoiceCommandResolution } from './voice-command'
import {
  DeterministicVoiceCommandPlanner,
  transitionVoiceCommandStep,
  type VoiceCommandPlan,
} from './voice-command-agent'
import {
  buildVoiceCommandDictionary,
  canonicalizeVoiceCommand,
  chooseBestVoiceTranscriptSelection,
  dictionaryBiasPhrases,
} from './voice-command-dictionary'
import { naturalizeSpokenFeedback, rankChineseVoices, selectPreferredChineseVoice } from './voice-speech'
import './VoiceCommandMode.css'

interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string; confidence?: number }> & { isFinal: boolean }>
}

interface SpeechRecognitionErrorEventLike {
  error: string
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives?: number
  phrases?: unknown
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
  SpeechRecognitionPhrase?: new (phrase: string, boost: number) => unknown
}

type ResolvedCommand =
  | { source: 'page'; plan: VoicePagePlan }
  | { source: 'navigation'; resolution: VoiceCommandResolution }

type ExecutionTone = 'success' | 'error' | 'working' | 'info' | 'warning'

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

function resolvedCommandReady(resolved: ResolvedCommand | null) {
  if (!resolved) return false
  if (resolved.source === 'page') return resolved.plan.kind === 'ready'
  return resolved.resolution.kind === 'ready'
}

function agentStepStatusLabel(step: VoiceCommandPlan['steps'][number]) {
  if (step.status === 'completed') return step.risk === 'high' ? '已完成 · 已单独确认' : '已完成'
  if (step.status === 'running') return '正在处理'
  if (step.status === 'blocked') return step.blockedReason || '未执行'
  return step.risk === 'high' ? '待执行 · 需要单独确认' : '待执行'
}

export function VoiceCommandMode({ data, employeeId, onReturn, onNavigate }: VoiceCommandModeProps) {
  const model = useMemo(() => buildRoleHomeModel(data, employeeId), [data, employeeId])
  const deterministicPlanner = useMemo(() => new DeterministicVoiceCommandPlanner(), [])
  const navigationSuggestions = voiceSuggestionsForNavigation(model.access.allowedNavigationIds)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const controlsSignatureRef = useRef('')
  const executionSequence = useRef(0)
  const agentPlanRef = useRef<VoiceCommandPlan | null>(null)
  const pausedAgentStepIdRef = useRef<string | null>(null)
  const [controls, setControls] = useState<VoicePageControl[]>([])
  const [pageHeading, setPageHeading] = useState('岗位工作台')
  const [command, setCommand] = useState('')
  const [resolved, setResolved] = useState<ResolvedCommand | null>(null)
  const [listening, setListening] = useState(false)
  const [voiceMessage, setVoiceMessage] = useState('')
  const [executionMessage, setExecutionMessage] = useState('')
  const [executionTone, setExecutionTone] = useState<ExecutionTone>('success')
  const [speechEnabled, setSpeechEnabled] = useState(true)
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([])
  const [selectedVoiceURI, setSelectedVoiceURI] = useState(() => window.localStorage.getItem('mbox.voice.tts.voice-uri') ?? '')
  const [agentPlan, setAgentPlan] = useState<VoiceCommandPlan | null>(null)
  const [awaitingHighRiskConfirmation, setAwaitingHighRiskConfirmation] = useState(false)
  const recognitionSupported = Boolean(
    (window as VoiceWindow).SpeechRecognition || (window as VoiceWindow).webkitSpeechRecognition,
  )
  const voiceDictionary = useMemo(() => buildVoiceCommandDictionary(data, controls), [controls, data])

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

  useEffect(() => {
    if (!('speechSynthesis' in window)) return undefined
    const refreshVoices = () => setAvailableVoices(window.speechSynthesis.getVoices())
    refreshVoices()
    window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices)
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', refreshVoices)
  }, [])

  function updateAgentPlan(nextPlan: VoiceCommandPlan | null) {
    agentPlanRef.current = nextPlan
    setAgentPlan(nextPlan)
  }

  function announce(message: string, tone: ExecutionTone = 'success') {
    setExecutionMessage(message)
    setExecutionTone(tone)
    if (!speechEnabled || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return
    const spokenMessage = naturalizeSpokenFeedback(message)
    if (!spokenMessage) return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(spokenMessage)
    utterance.lang = 'zh-CN'
    utterance.voice = selectPreferredChineseVoice(
      availableVoices,
      window.localStorage.getItem('mbox.voice.tts.voice-uri') ?? selectedVoiceURI,
    )
    utterance.rate = 0.96
    utterance.pitch = 1.02
    utterance.volume = 0.96
    window.speechSynthesis.speak(utterance)
  }

  function cancelCurrentCommand() {
    setResolved(null)
    setAwaitingHighRiskConfirmation(false)
    pausedAgentStepIdRef.current = null
    updateAgentPlan(null)
    announce('已取消，刚才的命令没有执行。')
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
    const ordinalMatch = normalized.match(/^(?:选择|选|点)?第?([一二三四五六123456])(?:个|项)?$/)
    const ambiguousPlan = resolved?.source === 'page' && resolved.plan.kind === 'ambiguous' ? resolved.plan : null
    if (ordinalMatch && ambiguousPlan) {
      const ordinalMap: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, '1': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5 }
      const candidate = ambiguousPlan.candidates[ordinalMap[ordinalMatch[1]!] ?? -1]
      if (!candidate || candidate.disabled) {
        announce('这个选项现在不能执行，请换一个。', 'error')
        return true
      }
      selectAmbiguousCandidate(candidate.command)
      return true
    }
    if (/^(取消|取消执行|不要执行|算了)$/.test(normalized)) {
      cancelCurrentCommand()
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
    const rawCommand = nextCommand.trim()
    const cleanCommand = canonicalizeVoiceCommand(rawCommand, voiceDictionary).trim()
    if (!cleanCommand) return
    setExecutionMessage('')
    setCommand(cleanCommand)
    setVoiceMessage('')
    if (handleInternalCommand(cleanCommand)) return
    const rawAgentPlan = deterministicPlanner.plan(rawCommand)
    const nextAgentPlan = rawAgentPlan.steps.length > 1 ? rawAgentPlan : deterministicPlanner.plan(cleanCommand)
    if (nextAgentPlan.steps.length > 1) {
      setResolved(null)
      setAwaitingHighRiskConfirmation(false)
      pausedAgentStepIdRef.current = null
      updateAgentPlan(nextAgentPlan)
      announce(`我把这句话整理成${nextAgentPlan.steps.length}步，请先核对计划再执行。`, 'info')
      return
    }
    updateAgentPlan(null)
    const nextResolved = resolveCommand(cleanCommand)
    setResolved(nextResolved)
    setAwaitingHighRiskConfirmation(false)

    if (nextResolved.source === 'page') {
      if (nextResolved.plan.kind === 'blocked') announce(nextResolved.plan.message, 'error')
      if (nextResolved.plan.kind === 'ambiguous') announce(nextResolved.plan.message, 'info')
      return
    }
    if (nextResolved.resolution.kind === 'denied') announce(`当前岗位没有${nextResolved.resolution.label}权限，命令没有执行。`, 'error')
    if (nextResolved.resolution.kind === 'unknown') announce('这句话还不能安全匹配到当前页面操作，请说出完整按钮或字段名称。', 'error')
  }

  function selectAmbiguousCandidate(candidateCommand: string) {
    setCommand(candidateCommand)
    const nextResolved = resolveCommand(candidateCommand)
    setResolved(nextResolved)
    setAwaitingHighRiskConfirmation(false)
    if (!resolvedCommandReady(nextResolved)) {
      announce('这个选项的页面状态已经变化，请重新说一次。', 'error')
      return
    }
    if (pausedAgentStepIdRef.current) {
      const current = agentPlanRef.current
      if (current) {
        const steps = current.steps.map((step) => step.id === pausedAgentStepIdRef.current
          ? { ...step, command: candidateCommand, label: candidateCommand }
          : step)
        updateAgentPlan({ ...current, steps })
      }
    }
    announce('好的，已经选中这一项，请核对后确认执行。', 'info')
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
    recognition.maxAlternatives = 5
    const Phrase = (window as VoiceWindow).SpeechRecognitionPhrase
    if (Phrase) {
      try {
        recognition.phrases = dictionaryBiasPhrases(voiceDictionary, 180).map((phrase) => new Phrase(phrase, 5))
      } catch {
        // Contextual phrase bias is experimental; local dictionary matching remains active.
      }
    }
    recognition.onresult = (event) => {
      const latest = event.results[event.results.length - 1]
      const alternatives = latest ? Array.from(latest).map((candidate) => ({
        transcript: candidate.transcript,
        confidence: candidate.confidence,
      })) : []
      const selection = latest?.isFinal
        ? chooseBestVoiceTranscriptSelection(alternatives, voiceDictionary)
        : null
      const transcript = selection?.canonicalized ?? latest?.[0]?.transcript?.trim() ?? ''
      setCommand(transcript)
      if (latest?.isFinal && selection?.safeToPlan) prepareCommand(transcript)
      if (latest?.isFinal && selection && !selection.safeToPlan) {
        setVoiceMessage(`我听到“${selection.canonicalized}”，但不太确定。请核对文字后点击“理解”。`)
      }
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
    requiresExplicitFeedback: boolean,
  ): Promise<boolean> {
    let sawUiChange = false
    let latest = before
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 250))
      if (executionSequence.current !== sequence) return false
      const scope = getVoiceScope()
      if (!scope) return false
      const after = readVoicePageState(scope)
      latest = after
      const newFeedback = after.feedback.find((message) => !before.feedback.includes(message))
      if (newFeedback) {
        if (/正在载入|正在加载|加载中|处理中/.test(newFeedback)) {
          announce(newFeedback, 'working')
          continue
        }
        const failed = /失败|错误|拒绝|不能|不可|无效|未保存|未完成/.test(newFeedback)
        announce(newFeedback, failed ? 'error' : 'success')
        refreshControls()
        return !failed
      }
      if (after.heading && before.heading && after.heading !== before.heading) {
        announce(`已打开${after.heading}。`)
        refreshControls()
        return true
      }
      if (after.stateSignature !== before.stateSignature) {
        sawUiChange = true
        if (canConfirmVoicePageStateChange(before, after, requiresExplicitFeedback)) {
          announce(fallbackMessage)
          refreshControls()
          return true
        }
      }
    }
    if (sawUiChange && canConfirmVoicePageStateChange(before, latest, requiresExplicitFeedback)) {
      announce(fallbackMessage)
      refreshControls()
      return true
    }
    announce(
      requiresExplicitFeedback
        ? '页面没有返回明确的完成结果，计划已暂停，请回岗位页面核对。'
        : '页面没有出现预期变化，命令未继续执行，请重新核对目标。',
      'error',
    )
    refreshControls()
    return false
  }

  async function performResolvedCommand(currentResolved: ResolvedCommand): Promise<boolean> {
    if (currentResolved.source === 'navigation') {
      if (currentResolved.resolution.kind !== 'ready') {
        announce('当前命令没有通过权限检查。', 'error')
        return false
      }
      const navigationLabel = currentResolved.resolution.label
      onNavigate(currentResolved.resolution.target)
      announce(`正在打开${navigationLabel}。`, 'working')
      await new Promise((resolve) => window.setTimeout(resolve, 450))
      refreshControls()
      announce(`已打开${navigationLabel}。`)
      return true
    }

    if (currentResolved.plan.kind !== 'ready') {
      announce('当前命令还不能执行，请重新说完整命令。', 'error')
      return false
    }
    const scope = getVoiceScope()
    if (!scope) {
      announce('岗位页面暂时不可用，命令没有执行。', 'error')
      return false
    }
    const before = readVoicePageState(scope)
    const sequence = executionSequence.current + 1
    executionSequence.current = sequence
    const result = executeVoicePagePlan(currentResolved.plan, scope)
    if (!result.ok) {
      announce(result.message, 'error')
      return false
    }
    if (currentResolved.plan.action !== 'activate') {
      announce(result.message)
      refreshControls()
      await new Promise((resolve) => window.setTimeout(resolve, 120))
      return true
    }
    announce(`${result.message}正在等待页面反馈。`, 'working')
    return waitForPageFeedback(sequence, before, result.message, currentResolved.plan.requiresExplicitFeedback)
  }

  async function executeResolvedCommand() {
    if (!resolved) {
      announce('当前没有等待确认的命令。', 'error')
      return false
    }
    setAwaitingHighRiskConfirmation(false)
    const currentResolved = resolved
    setResolved(null)
    return performResolvedCommand(currentResolved)
  }

  async function runAgentPlan(startPlan: VoiceCommandPlan, startIndex = 0) {
    let currentPlan = startPlan
    for (let index = startIndex; index < currentPlan.steps.length; index += 1) {
      const pendingStep = currentPlan.steps[index]!
      if (pendingStep.status === 'completed') continue
      currentPlan = transitionVoiceCommandStep(currentPlan, pendingStep.id, 'running')
      updateAgentPlan(currentPlan)
      announce(`正在执行第${index + 1}步：${pendingStep.label}。`, 'working')
      await new Promise((resolve) => window.setTimeout(resolve, 80))

      const stepCommand = canonicalizeVoiceCommand(pendingStep.command, voiceDictionary)
      const stepResolution = resolveCommand(stepCommand)
      const pagePlan = stepResolution.source === 'page' ? stepResolution.plan : null
      const navigationResolution = stepResolution.source === 'navigation' ? stepResolution.resolution : null

      if (pagePlan?.kind === 'ambiguous') {
        pausedAgentStepIdRef.current = pendingStep.id
        setResolved(stepResolution)
        announce(`第${index + 1}步需要您选一下目标。`, 'info')
        return
      }
      if (pagePlan?.kind === 'blocked' || navigationResolution?.kind === 'denied' || navigationResolution?.kind === 'unknown') {
        const reason = pagePlan && 'message' in pagePlan
          ? pagePlan.message
          : navigationResolution?.kind === 'denied' ? `当前岗位没有${navigationResolution.label}权限。` : '没有匹配到可执行操作。'
        currentPlan = transitionVoiceCommandStep(currentPlan, pendingStep.id, 'blocked', reason)
        updateAgentPlan(currentPlan)
        setResolved(stepResolution)
        announce(`计划停在第${index + 1}步：${reason}`, 'error')
        return
      }

      if (planReady(stepResolution)?.risk === 'high') {
        pausedAgentStepIdRef.current = pendingStep.id
        setResolved(stepResolution)
        setAwaitingHighRiskConfirmation(false)
        announce(`第${index + 1}步属于高风险操作，需要单独确认。`, 'warning')
        return
      }

      const succeeded = await performResolvedCommand(stepResolution)
      currentPlan = transitionVoiceCommandStep(
        currentPlan,
        pendingStep.id,
        succeeded ? 'completed' : 'blocked',
        succeeded ? undefined : '页面返回失败或状态已经变化',
      )
      updateAgentPlan(currentPlan)
      if (!succeeded) return
    }
    pausedAgentStepIdRef.current = null
    setResolved(null)
    announce(`计划中的${currentPlan.steps.length}步已经全部完成。`)
  }

  async function executePausedAgentStep() {
    const pausedStepId = pausedAgentStepIdRef.current
    const currentPlan = agentPlanRef.current
    if (!pausedStepId || !currentPlan || !resolved) return false
    const stepIndex = currentPlan.steps.findIndex((step) => step.id === pausedStepId)
    if (stepIndex < 0) return false
    const succeeded = await executeResolvedCommand()
    let nextPlan = transitionVoiceCommandStep(
      currentPlan,
      pausedStepId,
      succeeded ? 'completed' : 'blocked',
      succeeded ? undefined : '候选操作未完成或页面状态已经变化',
    )
    updateAgentPlan(nextPlan)
    pausedAgentStepIdRef.current = null
    if (!succeeded) return false
    await new Promise((resolve) => window.setTimeout(resolve, 160))
    nextPlan = agentPlanRef.current ?? nextPlan
    await runAgentPlan(nextPlan, stepIndex + 1)
    return true
  }

  async function requestExecution() {
    if (!resolved) {
      announce('当前没有等待确认的命令。', 'error')
      return
    }
    if (!resolvedCommandReady(resolved)) {
      announce('请先从相似选项中选定一个操作。', 'info')
      return
    }
    const pagePlan = planReady(resolved)
    if (pagePlan?.risk === 'high' && !awaitingHighRiskConfirmation) {
      setAwaitingHighRiskConfirmation(true)
      announce('这是高风险操作，请再次说“确认执行”，或者点击红色确认按钮。', 'warning')
      return
    }
    if (pausedAgentStepIdRef.current) {
      await executePausedAgentStep()
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
  const voiceOptions = rankChineseVoices(availableVoices, selectedVoiceURI)
    .filter((voice) => /^(?:zh|cmn|yue)(?:-|_)/i.test(voice.lang) || /中文|普通话|普通話|chinese|mandarin/i.test(voice.name))
    .slice(0, 10)

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
            <strong>{controls.length} 个控件 · {voiceDictionary.length} 个热词{generatedLabelCount > 0 ? ` · ${generatedLabelCount} 个待命名` : ''}</strong>
          </div>
          {voiceOptions.length > 0 && (
            <label className="voice-tts-control">
              <Volume2 size={14} />
              <span>播报声线</span>
              <select
                aria-label="选择语音播报声线"
                value={selectedVoiceURI || selectPreferredChineseVoice(voiceOptions)?.voiceURI || ''}
                onChange={(event) => {
                  const voiceURI = event.target.value
                  setSelectedVoiceURI(voiceURI)
                  window.localStorage.setItem('mbox.voice.tts.voice-uri', voiceURI)
                  window.setTimeout(() => announce('好的，接下来由这个声音为您播报。'), 0)
                }}
              >
                {voiceOptions.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name}</option>)}
              </select>
            </label>
          )}
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
              onChange={(event) => {
                setCommand(event.target.value)
                setResolved(null)
                setAwaitingHighRiskConfirmation(false)
                setExecutionMessage('')
                pausedAgentStepIdRef.current = null
                updateAgentPlan(null)
              }}
            />
            <button className="primary-button" disabled={!command.trim()}><Sparkles size={16} />理解</button>
          </form>

          {agentPlan && (
            <section className={`voice-agent-plan is-${agentPlan.status}`} aria-label="连续命令执行计划">
              <header>
                <span><Sparkles size={16} />连续命令计划</span>
                <strong>{agentPlan.steps.filter((step) => step.status === 'completed').length}/{agentPlan.steps.length}</strong>
              </header>
              <div className="voice-agent-steps">
                {agentPlan.steps.map((step) => (
                  <div className={`is-${step.status}`} key={step.id}>
                    <b>{step.status === 'completed' ? <Check size={13} /> : step.position}</b>
                    <span><strong>{step.label}</strong><small>{agentStepStatusLabel(step)}</small></span>
                  </div>
                ))}
              </div>
              {agentPlan.status === 'pending' && (
                <div className="voice-agent-actions">
                  <p>系统将逐步操作；已经完成的步骤不会因后续失败而自动撤回。</p>
                  <button className="secondary-button" onClick={cancelCurrentCommand}><X size={15} />取消</button>
                  <button className="primary-button" onClick={() => void runAgentPlan(agentPlan)}><Check size={15} />确认并执行计划</button>
                </div>
              )}
              {agentPlan.status === 'running' && pausedAgentStepIdRef.current && (
                <div className="voice-agent-actions is-paused">
                  <p>计划已暂停，您可以选定目标继续，也可以取消整个计划。</p>
                  <button className="secondary-button" onClick={cancelCurrentCommand}><X size={15} />取消整个计划</button>
                </div>
              )}
              {agentPlan.status === 'blocked' && (
                <div className="voice-agent-actions is-paused">
                  <p>后续步骤没有执行，请回岗位页面核对已经完成的步骤。</p>
                  <button className="secondary-button" onClick={cancelCurrentCommand}><X size={15} />结束计划</button>
                </div>
              )}
            </section>
          )}

          {ready && (
            <div className={`voice-confirmation ${readyRisk === 'high' ? 'is-high-risk' : ''}`} role="status">
              <div>{readyRisk === 'high' ? <ShieldAlert size={21} /> : <Check size={21} />}<span><small>{readyRisk === 'high' ? '高风险操作' : '我理解的是'}</small><strong>{readySummary}</strong>{readyRisk === 'high' && <p>需要再次确认，仍由原页面权限、审批和校验决定是否成功。</p>}</span></div>
              <div className="voice-confirm-actions">
                <button className="secondary-button" onClick={cancelCurrentCommand}><X size={16} />取消</button>
                <button className={awaitingHighRiskConfirmation ? 'voice-danger-confirm' : 'primary-button'} onClick={() => void requestExecution()}>
                  <Check size={16} />{awaitingHighRiskConfirmation ? '再次确认执行' : '确认执行'}
                </button>
              </div>
            </div>
          )}
          {pagePlan?.kind === 'ambiguous' && (
            <div className="voice-candidate-panel" role="group" aria-label="相似操作候选">
              <div><strong>{pagePlan.message}</strong><span>点选后还会显示确认卡，也可以说“第一个”。</span></div>
              <div className="voice-candidate-list">
                {pagePlan.candidates.map((candidate, index) => (
                  <button
                    key={candidate.id}
                    disabled={candidate.disabled}
                    onClick={() => selectAmbiguousCandidate(candidate.command)}
                  >
                    <b>{index + 1}</b>
                    <span><strong>{candidate.label}</strong><small>{candidate.description}{candidate.risk === 'high' ? ' · 需要二次确认' : ''}</small></span>
                    <ChevronRight size={16} />
                  </button>
                ))}
              </div>
            </div>
          )}
          {(pagePlan?.kind === 'blocked' || pagePlan?.kind === 'unknown') && <div className="voice-command-warning" role="alert">{pagePlan.message}</div>}
          {navigationResolution?.kind === 'denied' && <div className="voice-command-warning" role="alert">当前岗位没有“{navigationResolution.label}”权限，命令未执行。</div>}
          {navigationResolution?.kind === 'unknown' && <div className="voice-command-warning" role="alert">没有匹配到当前页面控件，请说完整按钮或字段名称。</div>}

          {executionMessage && (
            <div className={`voice-execution-result is-${executionTone}`} role="status" aria-live="polite">
              {executionTone === 'error' || executionTone === 'warning' ? <ShieldAlert size={18} /> : <Check size={18} />}
              <span><small>{executionTone === 'working' ? '执行中' : executionTone === 'info' ? '待确认' : executionTone === 'warning' ? '请注意' : executionTone === 'error' ? '未执行/执行失败' : '执行反馈'}</small><strong>{executionMessage}</strong></span>
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
