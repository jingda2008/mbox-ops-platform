import { ArrowLeft, Check, Keyboard, Mic, MicOff, ShieldCheck, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BootstrapResponse } from '../shared/contracts'
import type { OperationsConsoleView } from './OperationsConsole'
import { buildRoleHomeModel } from './role-access'
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

interface VoiceCommandModeProps {
  data: BootstrapResponse
  employeeId: string
  onReturn: () => void
  onNavigate: (target: OperationsConsoleView) => void
}

export function VoiceCommandMode({ data, employeeId, onReturn, onNavigate }: VoiceCommandModeProps) {
  const model = useMemo(() => buildRoleHomeModel(data, employeeId), [data, employeeId])
  const suggestions = voiceSuggestionsForNavigation(model.access.allowedNavigationIds)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const [command, setCommand] = useState('')
  const [resolution, setResolution] = useState<VoiceCommandResolution | null>(null)
  const [listening, setListening] = useState(false)
  const [voiceMessage, setVoiceMessage] = useState('')
  const recognitionSupported = Boolean(
    (window as VoiceWindow).SpeechRecognition || (window as VoiceWindow).webkitSpeechRecognition,
  )

  useEffect(() => () => recognitionRef.current?.abort(), [])

  function prepareCommand(nextCommand: string) {
    const cleanCommand = nextCommand.trim()
    setCommand(cleanCommand)
    setResolution(resolveVoiceCommand(cleanCommand, model.access.allowedNavigationIds))
    setVoiceMessage('')
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
    setResolution(null)
    setVoiceMessage('正在听，请说出您要做的事。')
    setListening(true)
    try {
      recognition.start()
    } catch {
      setListening(false)
      setVoiceMessage('麦克风暂时无法启动，可以直接输入命令。')
    }
  }

  function confirmCommand() {
    const latestResolution = resolveVoiceCommand(command, model.access.allowedNavigationIds)
    if (latestResolution.kind !== 'ready') {
      setResolution(latestResolution)
      return
    }
    onNavigate(latestResolution.target)
  }

  return (
    <main className="voice-command-mode">
      <header className="voice-mode-header">
        <div className="voice-mode-brand"><span>M</span><div><strong>M-BOX 语音命令</strong><small>{model.employee?.displayName ?? '当前员工'} · {model.access.roleLabel}</small></div></div>
        <button className="secondary-button" onClick={onReturn}><ArrowLeft size={17} />返回岗位页面</button>
      </header>

      <section className="voice-command-stage">
        <div className="voice-safety-label"><ShieldCheck size={16} />使用当前账号权限 · 执行前确认</div>
        <div className="voice-command-heading">
          <span>自然语言工作台</span>
          <h1>直接说出您要做的事</h1>
          <p>例如“K2开台”“查看待制作酒水”“打开今晚演出安排”。</p>
        </div>

        <button
          className={listening ? 'voice-mic-button is-listening' : 'voice-mic-button'}
          aria-pressed={listening}
          onClick={startListening}
        >
          {listening ? <MicOff size={34} /> : <Mic size={34} />}
          <span>{listening ? '点击结束' : recognitionSupported ? '点击说话' : '语音不可用'}</span>
        </button>
        {voiceMessage && <div className="voice-inline-message" role="status">{voiceMessage}</div>}

        <form className="voice-command-input" onSubmit={(event) => { event.preventDefault(); prepareCommand(command) }}>
          <Keyboard size={19} />
          <input
            aria-label="输入自然语言命令"
            value={command}
            maxLength={100}
            placeholder="现场太吵？也可以在这里输入命令"
            onChange={(event) => { setCommand(event.target.value); setResolution(null) }}
          />
          <button className="primary-button" disabled={!command.trim()}><Sparkles size={17} />理解命令</button>
        </form>

        {resolution?.kind === 'ready' && (
          <div className="voice-confirmation" role="status">
            <div><Check size={21} /><span><small>我理解的是</small><strong>{resolution.label}</strong><p>{resolution.summary}</p></span></div>
            <div className="voice-confirm-actions">
              <button className="secondary-button" onClick={() => setResolution(null)}><X size={16} />取消</button>
              <button className="primary-button" onClick={confirmCommand}><Check size={16} />确认并打开</button>
            </div>
          </div>
        )}
        {resolution?.kind === 'denied' && (
          <div className="voice-command-warning" role="alert">
            当前岗位没有“{resolution.label}”权限，命令未执行。需要时请让店长或管理员处理。
          </div>
        )}
        {resolution?.kind === 'unknown' && (
          <div className="voice-command-warning" role="status">
            这句话我还不能安全执行。您可以换一种说法，或返回岗位页面继续操作。
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="voice-suggestions">
            <span>常用命令</span>
            <div>{suggestions.map((item) => <button key={item.command} onClick={() => prepareCommand(item.command)}>{item.command}</button>)}</div>
          </div>
        )}
      </section>
      <footer className="voice-mode-footer">语音只转成文字命令，本系统不保存现场录音；最终权限与岗位页面完全一致。</footer>
    </main>
  )
}
