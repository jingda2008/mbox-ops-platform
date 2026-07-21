import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  CircleSlash2,
  Clock3,
  Keyboard,
  Mic,
  MicOff,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Send,
  RefreshCw,
  TriangleAlert,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getDutyManagerBriefing,
  getDutyManagerHandover,
  executeAssistantTool,
  sendAssistantTurn,
  transcribeVoiceAudio,
  updateDutyManagerRisks,
} from '../api'
import type {
  AssistantConversationMessage,
  AssistantTurnResponse,
  DutyManagerBriefing,
  DutyManagerHandover,
  DutyManagerRisk,
} from '../shared/assistant-contracts'
import type { BootstrapResponse } from '../shared/contracts'
import type { OperationsConsoleFocus, OperationsConsoleView } from './OperationsConsole'
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
import { dutyRiskNavigationTarget, resolveVoiceCommand, voiceSuggestionsForNavigation, type VoiceCommandResolution } from './voice-command'
import {
  DeterministicVoiceCommandPlanner,
  createModelVoiceCommandPlan,
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
import { selectVoiceRecognitionMode, shouldFallbackToCloudRecognition } from './voice-recording'
import { assistantPageCapabilities } from './assistant-page-capabilities'
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
type RecordingMode = 'native' | 'cloud' | null

const MAX_CLOUD_RECORDING_MS = 20_000

function cloudRecordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return null
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'] as const
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? null
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('录音读取失败'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const content = result.split(',')[1]
      if (!content) reject(new Error('录音内容为空'))
      else resolve(content)
    }
    reader.readAsDataURL(blob)
  })
}

interface VoiceCommandModeProps {
  data: BootstrapResponse
  employeeId: string
  onReturn: () => void
  onNavigate: (target: OperationsConsoleView, focus?: OperationsConsoleFocus) => void
  onRefresh: () => void | Promise<void>
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
  if (step.status === 'completed') {
    if (step.action === 'execute_server_tool') return '已由服务端确认'
    return step.risk === 'high' ? '已完成 · 已单独确认' : '已完成'
  }
  if (step.status === 'running') return step.action === 'execute_server_tool' ? '服务端正在校验并执行' : '正在处理'
  if (step.status === 'blocked') return step.blockedReason || '未执行'
  if (step.action === 'execute_server_tool') return '等待确认后执行'
  return step.risk === 'high' ? '待执行 · 需要单独确认' : '待执行'
}

export function VoiceCommandMode({ data, employeeId, onReturn, onNavigate, onRefresh }: VoiceCommandModeProps) {
  const model = useMemo(() => buildRoleHomeModel(data, employeeId), [data, employeeId])
  const deterministicPlanner = useMemo(() => new DeterministicVoiceCommandPlanner({
    defaultOpenTableSalesOwner: model.employee?.displayName,
  }), [model.employee?.displayName])
  const navigationSuggestions = voiceSuggestionsForNavigation(model.access.allowedNavigationIds)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const listeningRef = useRef(false)
  const stopRequestedRef = useRef(false)
  const pendingTranscriptRef = useRef('')
  const recordingModeRef = useRef<RecordingMode>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const recordingTimeoutRef = useRef<number | null>(null)
  const recognitionFallbackTimeoutRef = useRef<number | null>(null)
  const startingListeningRef = useRef(false)
  const controlsSignatureRef = useRef('')
  const executionSequence = useRef(0)
  const agentPlanRef = useRef<VoiceCommandPlan | null>(null)
  const pausedAgentStepIdRef = useRef<string | null>(null)
  const [controls, setControls] = useState<VoicePageControl[]>([])
  const [pageHeading, setPageHeading] = useState('岗位工作台')
  const [command, setCommand] = useState('')
  const [resolved, setResolved] = useState<ResolvedCommand | null>(null)
  const [listening, setListening] = useState(false)
  const [startingListening, setStartingListening] = useState(false)
  const [forceCloudRecognition, setForceCloudRecognition] = useState(false)
  const [inputFocused, setInputFocused] = useState(false)
  const [voiceViewportHeight, setVoiceViewportHeight] = useState(() => window.visualViewport?.height ?? window.innerHeight)
  const [voiceViewportTop, setVoiceViewportTop] = useState(() => window.visualViewport?.offsetTop ?? 0)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [voiceMessage, setVoiceMessage] = useState('')
  const [executionMessage, setExecutionMessage] = useState('')
  const [executionTone, setExecutionTone] = useState<ExecutionTone>('success')
  const [speechEnabled, setSpeechEnabled] = useState(true)
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([])
  const [selectedVoiceURI, setSelectedVoiceURI] = useState(() => window.localStorage.getItem('mbox.voice.tts.voice-uri') ?? '')
  const [agentPlan, setAgentPlan] = useState<VoiceCommandPlan | null>(null)
  const [awaitingHighRiskConfirmation, setAwaitingHighRiskConfirmation] = useState(false)
  const [assistantSessionId, setAssistantSessionId] = useState<string | null>(null)
  const [assistantMessages, setAssistantMessages] = useState<AssistantConversationMessage[]>([])
  const [assistantChoices, setAssistantChoices] = useState<string[]>([])
  const [assistantBusy, setAssistantBusy] = useState(false)
  const [dutyBriefing, setDutyBriefing] = useState<DutyManagerBriefing | null>(null)
  const [dutyHandover, setDutyHandover] = useState<DutyManagerHandover | null>(null)
  const [briefingBusy, setBriefingBusy] = useState(false)
  const [dutyActionBusy, setDutyActionBusy] = useState<string | null>(null)
  const [pendingDutyDismissId, setPendingDutyDismissId] = useState<string | null>(null)
  const nativeRecognitionSupported = Boolean(
    (window as VoiceWindow).SpeechRecognition || (window as VoiceWindow).webkitSpeechRecognition,
  )
  const recorderMimeType = cloudRecordingMimeType()
  const cloudRecordingSupported = Boolean(
    recorderMimeType
    && typeof navigator.mediaDevices?.getUserMedia === 'function',
  )
  const recognitionSupported = nativeRecognitionSupported || cloudRecordingSupported
  const recognitionMode = selectVoiceRecognitionMode({
    userAgent: navigator.userAgent,
    nativeSupported: nativeRecognitionSupported,
    cloudSupported: cloudRecordingSupported,
    forceCloud: forceCloudRecognition,
  })
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
    listeningRef.current = false
    recognitionRef.current?.abort()
    const recorder = mediaRecorderRef.current
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.onerror = null
      if (recorder.state === 'recording') recorder.stop()
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    if (recordingTimeoutRef.current !== null) window.clearTimeout(recordingTimeoutRef.current)
    if (recognitionFallbackTimeoutRef.current !== null) window.clearTimeout(recognitionFallbackTimeoutRef.current)
    window.speechSynthesis?.cancel()
  }, [])

  useEffect(() => {
    if (!voiceMessage || listening || startingListening || /^正在/.test(voiceMessage)) return undefined
    const timer = window.setTimeout(() => setVoiceMessage(''), 8_000)
    return () => window.clearTimeout(timer)
  }, [listening, startingListening, voiceMessage])

  useEffect(() => {
    if (!executionMessage || executionTone === 'working') return undefined
    const duration = executionTone === 'success' ? 4_000 : executionTone === 'info' ? 6_000 : 8_000
    const timer = window.setTimeout(() => setExecutionMessage(''), duration)
    return () => window.clearTimeout(timer)
  }, [executionMessage, executionTone])

  useEffect(() => {
    if (agentPlan?.status !== 'completed') return undefined
    const timer = window.setTimeout(() => {
      if (agentPlanRef.current?.status !== 'completed') return
      agentPlanRef.current = null
      setAgentPlan(null)
    }, 5_000)
    return () => window.clearTimeout(timer)
  }, [agentPlan?.status])

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return undefined
    const synchronizeViewport = () => {
      setVoiceViewportHeight(viewport.height)
      setVoiceViewportTop(viewport.offsetTop)
      setKeyboardOpen(inputFocused && window.innerHeight - viewport.height > 120)
    }
    synchronizeViewport()
    viewport.addEventListener('resize', synchronizeViewport)
    viewport.addEventListener('scroll', synchronizeViewport)
    return () => {
      viewport.removeEventListener('resize', synchronizeViewport)
      viewport.removeEventListener('scroll', synchronizeViewport)
    }
  }, [inputFocused])

  useEffect(() => {
    let active = true
    setBriefingBusy(true)
    void Promise.all([getDutyManagerBriefing(), getDutyManagerHandover()])
      .then(([briefing, handover]) => {
        if (!active) return
        setDutyBriefing(briefing)
        setDutyHandover(handover)
      })
      .catch(() => {
        if (!active) return
        setDutyBriefing(null)
        setDutyHandover(null)
      })
      .finally(() => { if (active) setBriefingBusy(false) })
    return () => { active = false }
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

  function addAssistantMessage(role: AssistantConversationMessage['role'], content: string) {
    setAssistantMessages((messages) => [...messages, {
      id: crypto.randomUUID(),
      role,
      content,
      createdAt: new Date().toISOString(),
    }].slice(-10))
  }

  function resetAssistantConversation() {
    setAssistantSessionId(null)
    setAssistantMessages([])
    setAssistantChoices([])
    setCommand('')
    setResolved(null)
    setAwaitingHighRiskConfirmation(false)
    pausedAgentStepIdRef.current = null
    updateAgentPlan(null)
    setExecutionMessage('')
    setVoiceMessage('新对话已经准备好。')
  }

  async function refreshDutyBriefing(announceResult = true) {
    if (briefingBusy) return
    setBriefingBusy(true)
    try {
      const [briefing, handover] = await Promise.all([getDutyManagerBriefing(), getDutyManagerHandover()])
      setDutyBriefing(briefing)
      setDutyHandover(handover)
      if (announceResult) announce(briefing.headline, briefing.health === 'critical' ? 'warning' : 'info')
    } catch (error) {
      if (announceResult) announce(error instanceof Error ? error.message : '巡场简报暂时无法更新。', 'error')
    } finally {
      setBriefingBusy(false)
    }
  }

  async function handleDutyAction(risk: DutyManagerRisk, action: 'acknowledge' | 'defer' | 'dismiss_false_positive') {
    if (dutyActionBusy) return
    setDutyActionBusy(risk.id)
    try {
      const result = await updateDutyManagerRisks({
        idempotencyKey: crypto.randomUUID(),
        action,
        riskIds: risk.sourceRiskIds,
        ...(action === 'defer' ? { deferMinutes: 10 } : {}),
        ...(action === 'dismiss_false_positive' ? { note: '值班管理人员现场复核后判断为误报' } : {}),
      })
      setDutyBriefing(result.briefing)
      setDutyHandover(await getDutyManagerHandover())
      setPendingDutyDismissId(null)
      announce(result.message, 'success')
    } catch (error) {
      announce(error instanceof Error ? error.message : '值班事件更新失败，请刷新后重试。', 'error')
    } finally {
      setDutyActionBusy(null)
    }
  }

  async function openDutyRisk(risk: DutyManagerRisk) {
    if (dutyActionBusy) return
    setDutyActionBusy(risk.id)
    try {
      if (risk.incidentStatus === 'open' && dutyBriefing?.actions.canAcknowledge) {
        await updateDutyManagerRisks({
          idempotencyKey: crypto.randomUUID(),
          action: 'acknowledge',
          riskIds: risk.sourceRiskIds,
        })
      }
      onNavigate(dutyRiskNavigationTarget(risk.category), {
        objectId: risk.targetObjectId,
        query: risk.targetQuery,
        tableCode: risk.tableCode,
      })
      onReturn()
    } catch (error) {
      announce(error instanceof Error ? error.message : '暂时无法接管，请刷新后重试。', 'error')
      setDutyActionBusy(null)
    }
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

  function assistantCapabilities() {
    const pageCapabilities = assistantPageCapabilities(controls)
    const navigationCapabilities = navigationSuggestions.map((suggestion) => ({
      id: `navigation:${suggestion.target}`,
      label: suggestion.command,
      command: suggestion.command,
      description: '打开当前岗位有权访问的工作页面',
      risk: 'normal' as const,
      disabled: false,
    }))
    return [...pageCapabilities, ...navigationCapabilities].slice(0, 120)
  }

  function applyAssistantResponse(message: string, response: AssistantTurnResponse) {
    setAssistantSessionId(response.sessionId)
    addAssistantMessage('assistant', response.reply)
    setAssistantChoices(response.choices)
    setResolved(null)
    setAwaitingHighRiskConfirmation(false)
    pausedAgentStepIdRef.current = null
    if (response.kind === 'plan') {
      const deterministicWorkflow = deterministicPlanner.plan(message)
      const plan = response.steps.some((step) => step.toolCall)
        ? createModelVoiceCommandPlan(message, response.steps)
        : deterministicWorkflow.steps.some((step) => step.action !== 'execute_command')
        ? { ...deterministicWorkflow, modelUsed: true }
        : createModelVoiceCommandPlan(message, response.steps)
      updateAgentPlan(plan)
      announce(`${response.reply} 请核对计划后再执行。`, 'info')
      return
    }
    updateAgentPlan(null)
    if (response.kind === 'clarification') announce(response.reply, 'info')
    else announce(response.reply, 'success')
  }

  async function submitAssistantMessage(nextCommand: string) {
    const message = nextCommand.trim()
    if (!message || assistantBusy) return
    addAssistantMessage('user', message)
    setCommand('')
    setVoiceMessage('')
    setExecutionMessage('')
    setAssistantChoices([])
    setAssistantBusy(true)
    try {
      const response = await sendAssistantTurn({
        requestId: crypto.randomUUID(),
        sessionId: assistantSessionId ?? undefined,
        message,
        page: {
          heading: pageHeading,
          capabilities: assistantCapabilities(),
        },
      })
      applyAssistantResponse(message, response)
    } catch (error) {
      const fallbackMessage = error instanceof Error ? error.message : '智能理解暂时不可用'
      const safeMessage = `${fallbackMessage}。本次没有执行任何操作，请重试或返回岗位页面手动处理。`
      addAssistantMessage('assistant', safeMessage)
      setVoiceMessage('智能理解失败，本次没有执行任何操作。')
      setResolved(null)
      setAwaitingHighRiskConfirmation(false)
      pausedAgentStepIdRef.current = null
      updateAgentPlan(null)
      announce(safeMessage, 'error')
    } finally {
      setAssistantBusy(false)
    }
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

  function setListeningState(next: boolean) {
    listeningRef.current = next
    setListening(next)
  }

  function stopMediaStream() {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    mediaStreamRef.current = null
    mediaRecorderRef.current = null
    if (recordingTimeoutRef.current !== null) {
      window.clearTimeout(recordingTimeoutRef.current)
      recordingTimeoutRef.current = null
    }
  }

  function acceptRecognizedTranscript(transcript: string, confidence?: number) {
    const selection = chooseBestVoiceTranscriptSelection([{ transcript, confidence }], voiceDictionary)
    if (!selection) {
      setVoiceMessage('这次没有听清，请靠近麦克风再说一次。')
      return
    }
    setCommand(selection.canonicalized)
    if (selection.safeToPlan) {
      void submitAssistantMessage(selection.canonicalized)
      setVoiceMessage('识别好了，正在理解您的意思。')
      return
    }
    setVoiceMessage(`我听到“${selection.canonicalized}”，但不太确定。请核对文字后点击“发送”。`)
  }

  async function transcribeCloudRecording(blob: Blob, mimeType: NonNullable<ReturnType<typeof cloudRecordingMimeType>>) {
    setVoiceMessage('正在识别，请稍等。')
    try {
      const result = await transcribeVoiceAudio({
        audioBase64: await blobToBase64(blob),
        mimeType,
        phrases: dictionaryBiasPhrases(voiceDictionary, 180),
      })
      acceptRecognizedTranscript(result.transcript, result.confidence ?? undefined)
    } catch (error) {
      setVoiceMessage(error instanceof Error ? error.message : '语音识别暂时繁忙，可以重试或直接输入命令。')
    }
  }

  async function startCloudListening() {
    if (startingListeningRef.current || listeningRef.current) return
    if (!recorderMimeType) {
      setVoiceMessage('当前浏览器不支持网页录音，可以直接输入命令。')
      return
    }
    startingListeningRef.current = true
    setStartingListening(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      const chunks: BlobPart[] = []
      const recorder = new MediaRecorder(stream, { mimeType: recorderMimeType })
      mediaStreamRef.current = stream
      mediaRecorderRef.current = recorder
      recordingModeRef.current = 'cloud'
      stopRequestedRef.current = false
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      recorder.onerror = () => {
        stopMediaStream()
        recordingModeRef.current = null
        setListeningState(false)
        setVoiceMessage('录音启动失败，请检查麦克风权限。')
      }
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorderMimeType })
        stopMediaStream()
        recordingModeRef.current = null
        setListeningState(false)
        if (blob.size === 0) {
          setVoiceMessage('没有录到声音，请重新点击开始。')
          return
        }
        void transcribeCloudRecording(blob, recorderMimeType)
      }
      recorder.start(250)
      setListeningState(true)
      setVoiceMessage('录音已开始，说完后再点一次停止。')
      recordingTimeoutRef.current = window.setTimeout(() => {
        stopRequestedRef.current = true
        setVoiceMessage('已录满20秒，正在自动停止并识别。')
        if (recorder.state === 'recording') recorder.stop()
      }, MAX_CLOUD_RECORDING_MS)
    } catch (error) {
      stopMediaStream()
      recordingModeRef.current = null
      setListeningState(false)
      const denied = error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)
      setVoiceMessage(denied ? '麦克风没有授权，请在浏览器地址栏中允许麦克风。' : '麦克风暂时无法启动，可以直接输入命令。')
    } finally {
      startingListeningRef.current = false
      setStartingListening(false)
    }
  }

  function startNativeListening() {
    const Recognition = (window as VoiceWindow).SpeechRecognition ?? (window as VoiceWindow).webkitSpeechRecognition
    if (!Recognition) {
      void startCloudListening()
      return
    }
    const recognition = new Recognition()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 5
    stopRequestedRef.current = false
    pendingTranscriptRef.current = ''
    recordingModeRef.current = 'native'
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
      if (!transcript) return
      pendingTranscriptRef.current = transcript
      setCommand(transcript)
    }
    recognition.onerror = (event) => {
      const fallbackToCloud = shouldFallbackToCloudRecognition(
        event.error,
        cloudRecordingSupported,
        stopRequestedRef.current,
      )
      const messages: Record<string, string> = {
        'not-allowed': '麦克风没有授权，请在浏览器地址栏中允许麦克风。',
        'no-speech': '没有听清，请重新点击开始。',
        network: fallbackToCloud
          ? '浏览器识别不可用，正在自动切换云端识别。'
          : '语音识别暂时无法连接，请直接输入命令。',
        'service-not-allowed': fallbackToCloud
          ? '浏览器识别受限，正在自动切换云端识别。'
          : '当前浏览器不允许语音识别，请直接输入命令。',
      }
      setVoiceMessage(messages[event.error] ?? '这次没有听清，请再说一次。')
      recordingModeRef.current = null
      recognitionRef.current = null
      setListeningState(false)
      if (fallbackToCloud) {
        setForceCloudRecognition(true)
        if (recognitionFallbackTimeoutRef.current !== null) window.clearTimeout(recognitionFallbackTimeoutRef.current)
        recognitionFallbackTimeoutRef.current = window.setTimeout(() => {
          recognitionFallbackTimeoutRef.current = null
          void startCloudListening()
        }, 180)
      }
    }
    recognition.onend = () => {
      if (stopRequestedRef.current) {
        const transcript = pendingTranscriptRef.current
        recordingModeRef.current = null
        recognitionRef.current = null
        setListeningState(false)
        if (transcript) acceptRecognizedTranscript(transcript)
        else setVoiceMessage('没有听清，请重新点击开始。')
        return
      }
      if (!listeningRef.current) return
      window.setTimeout(() => {
        if (!listeningRef.current || stopRequestedRef.current) return
        try {
          recognition.start()
        } catch {
          recordingModeRef.current = null
          recognitionRef.current = null
          setListeningState(false)
          setVoiceMessage('语音识别已中断，请重新点击开始。')
        }
      }, 150)
    }
    recognitionRef.current = recognition
    setVoiceMessage('识别已开启，说完后再点一次停止。')
    setListeningState(true)
    try {
      recognition.start()
    } catch {
      recordingModeRef.current = null
      setListeningState(false)
      setVoiceMessage('麦克风暂时无法启动，可以直接输入命令。')
    }
  }

  function toggleListening() {
    if (startingListeningRef.current || startingListening) return
    if (listeningRef.current) {
      stopRequestedRef.current = true
      setVoiceMessage('正在停止并识别。')
      if (recordingModeRef.current === 'cloud') {
        const recorder = mediaRecorderRef.current
        if (recorder?.state === 'recording') recorder.stop()
      } else {
        recognitionRef.current?.stop()
      }
      return
    }
    if (recognitionMode === 'cloud') void startCloudListening()
    else if (recognitionMode === 'native') startNativeListening()
    else setVoiceMessage('当前浏览器无法使用语音，可以直接输入命令。')
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
      if (currentResolved.resolution.protectedActionRequested) {
        announce(`已打开${navigationLabel}，但业务操作尚未执行。请补充页面要求的信息并确认。`, 'info')
        return false
      }
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

      if (pendingStep.action === 'execute_server_tool' && pendingStep.toolCall) {
        try {
          if (!pendingStep.executionId) throw new Error('AI执行编号缺失，请重新生成计划')
          const result = await executeAssistantTool({ executionId: pendingStep.executionId, toolCall: pendingStep.toolCall })
          currentPlan = transitionVoiceCommandStep(currentPlan, pendingStep.id, 'completed')
          updateAgentPlan(currentPlan)
          announce(result.message, 'success')
          try {
            await onRefresh()
          } catch {
            announce(`${result.message} 页面暂未刷新，请点刷新查看最新状态。`, 'success')
          }
          await new Promise((resolve) => window.setTimeout(resolve, 120))
          continue
        } catch (error) {
          const reason = error instanceof Error ? error.message : '服务端没有确认执行结果'
          currentPlan = transitionVoiceCommandStep(currentPlan, pendingStep.id, 'blocked', reason)
          updateAgentPlan(currentPlan)
          announce(`计划停在第${index + 1}步：${reason}`, 'error')
          return
        }
      }

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
      <aside
        className={`voice-command-mode${inputFocused ? ' is-input-focused' : ''}${keyboardOpen ? ' is-keyboard-open' : ''}`}
        style={{ height: `${voiceViewportHeight}px`, top: `${voiceViewportTop}px`, bottom: 'auto' }}
        data-voice-ignore
        role="dialog"
        aria-modal="true"
        aria-label="AI值班经理模式"
      >
        <header className="voice-mode-header">
          <div className="voice-mode-brand"><span>M</span><div><strong>M-BOX AI 值班经理</strong><small>{model.employee?.displayName ?? '当前员工'} · {model.access.roleLabel}</small></div></div>
          <div className="voice-mode-header-actions">
            <button className="icon-button" title={speechEnabled ? '关闭语音播报' : '打开语音播报'} onClick={() => {
              window.speechSynthesis?.cancel()
              setSpeechEnabled((enabled) => !enabled)
            }}>{speechEnabled ? <Volume2 size={17} /> : <VolumeX size={17} />}</button>
            <button className="icon-button" title="开始新对话" onClick={resetAssistantConversation}><Sparkles size={17} /></button>
            <button className="icon-button" title="刷新巡场简报" disabled={briefingBusy} onClick={() => void refreshDutyBriefing()}><RefreshCw className={briefingBusy ? 'is-spinning' : ''} size={17} /></button>
            <button className="secondary-button" onClick={onReturn}><ArrowLeft size={17} />岗位页面</button>
          </div>
        </header>

        <section className="voice-command-stage">
          {dutyBriefing && (
            <section className={`duty-briefing is-${dutyBriefing.health}`} aria-label="AI值班经理巡场简报">
              <header>
                <span><TriangleAlert size={16} /><strong>现在要处理</strong></span>
                <small>{dutyBriefing.counts.critical}紧急 · {dutyBriefing.counts.high}高风险 · {dutyBriefing.counts.medium}关注</small>
              </header>
              <p>{dutyBriefing.headline}</p>
              {dutyBriefing.risks.length > 0 && <div className="duty-risk-list">
                {dutyBriefing.risks.slice(0, 5).map((risk, index) => {
                  const primaryAction = risk.incidentStatus === 'open' && dutyBriefing.actions.canAcknowledge ? '接管并处理' : '继续处理'
                  return <article className={`duty-risk-item is-${risk.incidentStatus}`} key={risk.id}>
                  <div className="duty-risk-main">
                    <i className={`is-${risk.severity}`} />
                    <span>
                      <strong>{risk.title}</strong>
                      <small>{risk.incidentStatus === 'acknowledged' ? `${risk.handledByName ?? '现场伙伴'}已接管 · ` : ''}{risk.detail}</small>
                    </span>
                    <em>{index === 0 ? '优先处理' : risk.incidentStatus === 'acknowledged' ? '跟进中' : '待接管'}</em>
                  </div>
                  <p className="duty-risk-recommendation"><Sparkles size={12} /><span><b>AI建议</b>{risk.recommendation}</span></p>
                  <div className="duty-risk-actions">
                    <button className="duty-risk-primary" aria-label={`${primaryAction}：${risk.title}`} disabled={dutyActionBusy === risk.id} onClick={() => void openDutyRisk(risk)}><Check size={13} />{dutyActionBusy === risk.id ? '正在接管' : primaryAction}<ChevronRight size={13} /></button>
                    {dutyBriefing.actions.canManage && <button disabled={dutyActionBusy === risk.id} onClick={() => void handleDutyAction(risk, 'defer')}><Clock3 size={12} />稍后10分钟</button>}
                    {dutyBriefing.actions.canManage && <button disabled={dutyActionBusy === risk.id} onClick={() => setPendingDutyDismissId(risk.id)}><CircleSlash2 size={12} />误报</button>}
                  </div>
                  {pendingDutyDismissId === risk.id && <div className="duty-risk-dismiss-confirm" role="alert">
                    <span>确认现场已复核，这条是误报？</span>
                    <button disabled={dutyActionBusy === risk.id} onClick={() => void handleDutyAction(risk, 'dismiss_false_positive')}>确认</button>
                    <button onClick={() => setPendingDutyDismissId(null)}>取消</button>
                  </div>}
                </article>})}
              </div>}
              <section className="duty-effectiveness" aria-label="今日经营成效">
                <header>
                  <strong>今日五维经营成效</strong>
                  <span className={`is-${dutyBriefing.effectiveness.trend}`}>{{
                    improving: '较昨日改善',
                    steady: '与昨日持平',
                    declining: '较昨日下降',
                    insufficient_data: '样本积累中',
                  }[dutyBriefing.effectiveness.trend]}</span>
                </header>
                <div className="duty-effectiveness-grid">
                  <span><small>服务 · 按时响应</small><b>{dutyBriefing.effectiveness.service.responseWithinSlaRate === null ? '--' : `${dutyBriefing.effectiveness.service.responseWithinSlaRate}%`}</b></span>
                  <span><small>收入 · 净实收</small><b>¥{(dutyBriefing.effectiveness.business.netRevenueAmount / 100).toFixed(2)}</b></span>
                  <span><small>体验 · 投诉闭环</small><b>{dutyBriefing.effectiveness.experience.serviceRecoveryRate === null ? '--' : `${dutyBriefing.effectiveness.experience.serviceRecoveryRate}%`}</b></span>
                  <span><small>人员 · 负荷率</small><b>{dutyBriefing.effectiveness.workforce.utilizationRate === null ? '--' : `${dutyBriefing.effectiveness.workforce.utilizationRate}%`}</b></span>
                  <span><small>防损 · 异常项</small><b>{dutyBriefing.effectiveness.lossPrevention.exceptionCount}</b></span>
                  <span><small>防损 · 待对账</small><b>¥{(dutyBriefing.effectiveness.lossPrevention.pendingReconciliationAmount / 100).toFixed(2)}</b></span>
                </div>
                <p><Sparkles size={11} />{dutyBriefing.effectiveness.summary}</p>
              </section>
              {dutyHandover && <footer className="duty-handover-strip">
                <span>今日闭环 <b>{dutyHandover.resolved + dutyHandover.dismissed}</b></span>
                <span>待交班 <b>{dutyHandover.active}</b></span>
                <span>平均接管 <b>{dutyHandover.averageAcknowledgeMinutes === null ? '--' : `${dutyHandover.averageAcknowledgeMinutes}分`}</b></span>
              </footer>}
            </section>
          )}

          <div className="voice-command-heading">
            <h1><Bot size={21} />还想处理别的事？</h1>
            <p>直接说或输入，AI会先让您确认，再按当前岗位权限执行。</p>
          </div>

          {assistantMessages.length > 0 && (
            <section className="assistant-conversation" aria-label="AI值班经理对话">
              {assistantMessages.map((message) => (
                <div className={`assistant-message is-${message.role}`} key={message.id}>
                  <small>{message.role === 'user' ? '我' : 'AI值班经理'}</small>
                  <p>{message.content}</p>
                </div>
              ))}
              {assistantBusy && <div className="assistant-thinking"><Sparkles size={14} />正在结合当前岗位和现场状态理解...</div>}
            </section>
          )}

          <div className={listening ? 'voice-record-control is-listening' : 'voice-record-control'}>
            <button
              type="button"
              className={listening ? 'voice-mic-button is-listening' : 'voice-mic-button'}
              aria-pressed={listening}
              aria-label={listening ? '停止语音识别' : '开始语音识别'}
              disabled={!recognitionSupported || startingListening}
              onClick={toggleListening}
            >
              {listening ? <MicOff size={25} /> : <Mic size={25} />}
              <span>{startingListening ? '启动中' : listening ? '停止' : recognitionSupported ? '开始' : '不可用'}</span>
            </button>
            <div className="voice-record-copy">
              <strong>{startingListening ? '正在打开麦克风' : listening ? '正在录音' : '点一下开始，不用按住'}</strong>
              <span className="voice-inline-message" role="status">
                {voiceMessage || (recognitionSupported ? '说完后再点一下停止，我会识别并执行。' : '当前浏览器不支持语音，请使用文字输入。')}
              </span>
            </div>
          </div>

          <form className="voice-command-input" onSubmit={(event) => { event.preventDefault(); void submitAssistantMessage(command); event.currentTarget.querySelector('input')?.blur() }}>
            <Keyboard size={18} />
            <input
              aria-label="输入自然语言命令"
              value={command}
              maxLength={160}
              enterKeyHint="done"
              placeholder="直接描述问题或要完成的工作"
              onFocus={() => setInputFocused(true)}
              onBlur={() => window.setTimeout(() => setInputFocused(false), 180)}
              onChange={(event) => {
                setCommand(event.target.value)
                setResolved(null)
                setAwaitingHighRiskConfirmation(false)
                setExecutionMessage('')
                pausedAgentStepIdRef.current = null
                updateAgentPlan(null)
              }}
            />
            <button className="primary-button" disabled={!command.trim() || assistantBusy}><Send size={16} />发送</button>
          </form>

          {assistantChoices.length > 0 && (
            <div className="assistant-choice-list" role="group" aria-label="请选择一个答案">
              {assistantChoices.map((choice) => (
                <button key={choice} disabled={assistantBusy} onClick={() => void submitAssistantMessage(choice)}>{choice}</button>
              ))}
            </div>
          )}

          {agentPlan && (
            <section className={`voice-agent-plan is-${agentPlan.status}`} aria-label="连续命令执行计划">
              <header>
                <span><Sparkles size={16} />{
                  agentPlan.steps.every((step) => step.action === 'execute_server_tool')
                    ? 'AI业务执行计划'
                    : agentPlan.modelUsed ? 'AI执行计划' : '连续命令计划'
                }</span>
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
                  <p>{agentPlan.steps.every((step) => step.action === 'execute_server_tool')
                    ? '确认后由服务端按顺序执行，每一步都会重新核对岗位权限和门店最新状态。'
                    : '系统将逐步操作；已经完成的步骤不会因后续失败而自动撤回。'}</p>
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
              {pageSuggestions.map((control) => <button key={control.id} onClick={() => prepareCommand(commandForControl(control))}>{control.label}</button>)}
              {pageSuggestions.length === 0 && navigationSuggestions.slice(0, 4).map((item) => <button key={item.command} onClick={() => prepareCommand(item.command)}>{item.command}</button>)}
            </div>
          </div>

          <details className="voice-advanced-settings">
            <summary>语音偏好与识别状态 <ChevronRight size={15} /></summary>
            <div>
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
              {generatedLabelCount > 0 && <p>当前页有 {generatedLabelCount} 个控件暂用页面位置命名，管理员可继续补齐正式名称。</p>}
            </div>
          </details>

          <details className="voice-command-catalog">
            <summary>查看本页全部快捷命令 <ChevronRight size={15} /></summary>
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
