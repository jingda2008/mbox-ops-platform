import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, History, LoaderCircle, MessageSquareText, Mic, Pencil, Square, X } from 'lucide-react'
import type {
  ObservationCandidate,
  ObservationDegree,
  ObservationDraft,
  ObservationEvent,
  ObservationEventType,
  ObservationExpressionKind,
  ObservationHistory,
  StaffActionsApiPort,
} from './staff-actions-api'

type Confirmation = Readonly<{
  candidate: ObservationCandidate | null
  expressionKind: ObservationExpressionKind
  eventType: ObservationEventType
  degree: ObservationDegree | null
}>

type ObservationAudioMimeType = 'audio/webm' | 'audio/webm;codecs=opus' | 'audio/ogg' | 'audio/ogg;codecs=opus'

const MAX_OBSERVATION_RECORDING_MS = 20_000

function observationAudioMimeType(): ObservationAudioMimeType | null {
  if (typeof MediaRecorder === 'undefined') return null
  const candidates: ObservationAudioMimeType[] = [
    'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg',
  ]
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? null
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('录音读取失败，可以直接输入文字'))
    reader.onload = () => {
      const content = typeof reader.result === 'string' ? reader.result.split(',')[1] : ''
      if (!content) reject(new Error('没有录到声音，请重试或直接输入文字'))
      else resolve(content)
    }
    reader.readAsDataURL(blob)
  })
}

export function TableObservationSheet({ api, tableCode, tableSessionId, onClose, onSaved }: {
  api: StaffActionsApiPort
  tableCode: string
  tableSessionId: string
  onClose(): void
  onSaved(message: string): void
}) {
  const [rawContent, setRawContent] = useState('')
  const [needsImmediateAction, setNeedsImmediateAction] = useState(false)
  const [draft, setDraft] = useState<ObservationDraft | null>(null)
  const [history, setHistory] = useState<ObservationHistory | null>(null)
  const [busy, setBusy] = useState<'parse' | 'confirm' | 'revise' | null>(null)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [error, setError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [inputKind, setInputKind] = useState<'text' | 'voice_transcript'>('text')
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [voiceMessage, setVoiceMessage] = useState('')
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const recordingTimerRef = useRef<number | null>(null)
  const recorderMimeType = observationAudioMimeType()

  const stopRecordingResources = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    mediaStreamRef.current = null
    mediaRecorderRef.current = null
    if (recordingTimerRef.current !== null) window.clearTimeout(recordingTimerRef.current)
    recordingTimerRef.current = null
  }, [])

  const loadHistory = useCallback(async (signal?: AbortSignal) => {
    setHistoryLoading(true); setHistoryError('')
    try {
      setHistory(await api.loadRecentObservations(tableSessionId, signal))
    } catch (cause) {
      if (signal?.aborted) return
      setHistoryError(cause instanceof Error ? cause.message : '最近记录暂时无法读取')
    } finally {
      if (!signal?.aborted) setHistoryLoading(false)
    }
  }, [api, tableSessionId])

  useEffect(() => {
    const controller = new AbortController()
    void loadHistory(controller.signal)
    return () => controller.abort()
  }, [loadHistory])

  useEffect(() => () => {
    const recorder = mediaRecorderRef.current
    if (recorder?.state === 'recording') recorder.stop()
    stopRecordingResources()
  }, [stopRecordingResources])

  async function transcribeRecording(blob: Blob, mimeType: ObservationAudioMimeType) {
    setVoiceState('transcribing'); setVoiceMessage('正在转成文字，请稍等')
    try {
      const result = await api.transcribeObservationAudio({
        audioBase64: await blobToBase64(blob),
        mimeType,
        phrases: [tableCode, '剩了一半', '基本没动', '客人说', '太甜', '上得太晚', '需要马上处理'],
      })
      const transcript = result.transcript.trim()
      if (!transcript) throw new Error('这次没有听清，请重试或直接输入文字')
      setRawContent(transcript)
      setInputKind('voice_transcript')
      setDraft(null)
      setVoiceMessage('已转成文字，请核对后再保存；系统不保存本次原始录音')
    } catch (cause) {
      setVoiceMessage(cause instanceof Error ? cause.message : '语音暂时不可用，可以直接输入文字')
    } finally {
      setVoiceState('idle')
    }
  }

  async function startRecording() {
    if (voiceState !== 'idle' || recorderMimeType === null
      || typeof navigator.mediaDevices?.getUserMedia !== 'function') return
    setVoiceMessage('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      const chunks: BlobPart[] = []
      const recorder = new MediaRecorder(stream, { mimeType: recorderMimeType })
      mediaStreamRef.current = stream
      mediaRecorderRef.current = recorder
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
      recorder.onerror = () => {
        stopRecordingResources()
        setVoiceState('idle')
        setVoiceMessage('录音启动失败，请检查麦克风权限或直接输入文字')
      }
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorderMimeType })
        stopRecordingResources()
        if (blob.size === 0) {
          setVoiceState('idle')
          setVoiceMessage('没有录到声音，请重试或直接输入文字')
          return
        }
        void transcribeRecording(blob, recorderMimeType)
      }
      recorder.start(250)
      setVoiceState('recording')
      setVoiceMessage('正在录音，说完后再点一次；最长20秒')
      recordingTimerRef.current = window.setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop()
      }, MAX_OBSERVATION_RECORDING_MS)
    } catch (cause) {
      stopRecordingResources()
      setVoiceState('idle')
      const denied = cause instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(cause.name)
      setVoiceMessage(denied ? '麦克风没有授权，请在浏览器中允许，或直接输入文字' : '麦克风暂时不可用，可以直接输入文字')
    }
  }

  function toggleRecording() {
    if (voiceState === 'recording') {
      mediaRecorderRef.current?.stop()
      return
    }
    void startRecording()
  }

  async function parse() {
    if (rawContent.trim().length < 2 || busy !== null) return
    setBusy('parse'); setError('')
    try {
      setDraft(await api.parseObservation({
        tableSessionId,
        rawContent: rawContent.trim(),
        needsImmediateAction,
        inputKind,
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '记录暂时无法解析，请稍后重试')
    } finally {
      setBusy(null)
    }
  }

  async function confirm(input: Confirmation) {
    if (draft === null || busy !== null) return
    setBusy('confirm'); setError('')
    try {
      const result = await api.confirmObservation({
        observationPublicId: draft.publicId,
        candidateId: input.candidate?.id ?? null,
        confidence: input.candidate?.confidence ?? Math.min(draft.parseConfidence, 0.5),
        rawExcerpt: draft.rawContent.slice(0, 1000),
        expressionKind: input.expressionKind,
        eventType: input.eventType,
        degree: input.degree,
      })
      onSaved(result.serviceTaskId === null ? `${tableCode}桌台情况已记录` : `${tableCode}已记录，并生成现场处理任务`)
      setRawContent(''); setInputKind('text'); setNeedsImmediateAction(false); setDraft(null)
      await loadHistory()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '记录尚未确认，请重试')
    } finally {
      setBusy(null)
    }
  }

  async function revise(observationPublicId: string, event: ObservationEvent, reason: string, replacement: Pick<ObservationEvent, 'expressionKind' | 'eventType' | 'degree'>) {
    if (busy !== null || event.rawExcerpt === null) return
    setBusy('revise'); setHistoryError('')
    try {
      await api.reviseObservation({
        observationPublicId,
        eventId: event.id,
        reason,
        replacement: {
          expressionKind: replacement.expressionKind,
          scopeKind: event.scopeKind,
          eventType: replacement.eventType,
          degree: replacement.degree,
          reasonCode: event.reasonCode,
          seatLabel: event.seatLabel,
          customerId: event.customerId,
          candidateId: event.selectedCandidateId,
          productId: event.productId,
          confidence: event.confidence,
          rawExcerpt: event.rawExcerpt,
        },
      })
      onSaved(`${tableCode}观察记录已追加修订，原记录仍保留`)
      await loadHistory()
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : '修订尚未保存，请重试')
    } finally {
      setBusy(null)
    }
  }

  return <div className="staff-observation-overlay" role="dialog" aria-modal="true" aria-label={`${tableCode}记录桌台情况`}>
    <section className="staff-observation-sheet">
      <header><div><MessageSquareText size={20} /><span><small>{tableCode} · 当前桌次</small><strong>记录桌台情况</strong></span></div><button type="button" aria-label="关闭" onClick={onClose}><X size={20} /></button></header>
      <div className="staff-observation-body">
        <section className="staff-observation-entry" aria-label="新增桌台记录">
          <p>直接写看到的事实、客人原话或你的判断。系统只从本桌真实订单寻找商品，不确定时会保留“不确定”。</p>
          <label className="staff-observation-input"><span>一句话记录</span><textarea autoFocus maxLength={500} value={rawContent} onChange={(event) => { setRawContent(event.target.value); setDraft(null) }} placeholder="例如：客人说红色那杯太甜，薯条剩了一大半，我感觉可能上晚了。" /></label>
          <div className="staff-observation-voice">
            <button type="button" className={voiceState === 'recording' ? 'is-recording' : ''}
              disabled={voiceState === 'transcribing' || recorderMimeType === null}
              onClick={toggleRecording}>
              {voiceState === 'transcribing' ? <LoaderCircle className="is-spinning" />
                : voiceState === 'recording' ? <Square /> : <Mic />}
              {voiceState === 'transcribing' ? '正在转文字' : voiceState === 'recording' ? '停止并转文字' : '语音记录'}
            </button>
            <span>{recorderMimeType === null ? '此设备不支持网页录音，请直接输入文字' : voiceMessage || '点击后才会申请麦克风；原始录音不保存'}</span>
          </div>
          <label className="staff-observation-urgent"><input type="checkbox" checked={needsImmediateAction} onChange={(event) => { setNeedsImmediateAction(event.target.checked); setDraft(null) }} /><span><strong>需要马上处理</strong><small>确认后同时生成现场服务任务；退款、赠送、换酒仍需有权限人员审批。</small></span></label>
          {error !== '' && <div className="staff-observation-error" role="alert"><AlertTriangle size={17} />{error}</div>}
          {draft === null ? <button type="button" className="staff-observation-primary" disabled={rawContent.trim().length < 2 || busy !== null} onClick={() => void parse()}>{busy === 'parse' ? <LoaderCircle className="is-spinning" /> : <MessageSquareText />}识别并核对</button> : <ObservationReview draft={draft} busy={busy !== null} onConfirm={(input) => void confirm(input)} onRevise={() => setDraft(null)} />}
        </section>
        <RecentObservations history={history} loading={historyLoading} error={historyError} busy={busy === 'revise'} onReload={() => void loadHistory()} onRevise={(...args) => void revise(...args)} />
      </div>
    </section>
  </div>
}

function ObservationReview({ draft, busy, onConfirm, onRevise }: {
  draft: ObservationDraft
  busy: boolean
  onConfirm(input: Confirmation): void
  onRevise(): void
}) {
  const confidence = Math.round(draft.parseConfidence * 100)
  const [selectedCandidateId, setSelectedCandidateId] = useState(draft.clarificationRequired ? '' : draft.candidates[0]?.id ?? '')
  const [expressionKind, setExpressionKind] = useState<ObservationExpressionKind>('staff_judgement')
  const [eventType, setEventType] = useState<ObservationEventType>('other')
  const [degree, setDegree] = useState<ObservationDegree | null>(null)
  const selectedCandidate = draft.candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null
  return <section className="staff-observation-review" data-action-reveal>
    <header><div><strong>请核对后保存</strong><small>总体把握 {confidence}% · {draft.candidates.length}个本桌真实订单候选</small></div><span className={confidence >= 90 ? 'is-high' : confidence >= 60 ? 'is-medium' : 'is-low'}>{confidence}%</span></header>
    <div className={`staff-observation-action-state ${draft.needsImmediateAction ? 'is-urgent' : ''}`}><strong>{draft.needsImmediateAction ? '需要马上处理' : '只记录，不派现场任务'}</strong><small>{draft.needsImmediateAction ? '保存成功后生成一条服务任务' : '可在返回修改原话后重新选择'}</small></div>
    {draft.clarificationRequired && <p>{draft.clarificationPrompt ?? '暂时无法确定具体商品，将按桌台情况保存原话，避免编造结论。'}</p>}
    {draft.candidates.length === 0 ? <p>没有在本桌真实订单中找到可靠商品，将保存原话和桌台级记录。</p> : <div className="staff-observation-candidates" role="group" aria-label="选择关联商品">{draft.candidates.slice(0, 3).map((candidate) => <button type="button" key={candidate.id} className={selectedCandidateId === candidate.id ? 'is-selected' : ''} aria-pressed={selectedCandidateId === candidate.id} onClick={() => setSelectedCandidateId((current) => current === candidate.id ? '' : candidate.id)}><article><div><strong>{candidate.productName}</strong><small>原文线索“{candidate.rawMention}” · {matchKindLabel(candidate.matchKind)}</small></div><span>{Math.round(candidate.confidence * 100)}%</span></article></button>)}<button type="button" className={selectedCandidateId === '' ? 'is-selected' : ''} aria-pressed={selectedCandidateId === ''} onClick={() => setSelectedCandidateId('')}><article><div><strong>不关联具体商品</strong><small>只保存为本桌情况，避免错误归因</small></div></article></button></div>}
    <div className="staff-observation-classification">
      <label><span>信息来源</span><select value={expressionKind} onChange={(event) => setExpressionKind(event.target.value as ObservationExpressionKind)}>{MANUAL_EXPRESSION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label><span>情况类型</span><select value={eventType} onChange={(event) => setEventType(event.target.value as ObservationEventType)}>{EVENT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label><span>程度</span><select value={degree ?? ''} onChange={(event) => setDegree(event.target.value === '' ? null : event.target.value as ObservationDegree)}><option value="">未说明</option>{DEGREE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    </div>
    <div className="staff-observation-actions"><button type="button" onClick={onRevise}>返回修改原话</button><button type="button" className="staff-observation-primary" disabled={busy} onClick={() => onConfirm({ candidate: selectedCandidate, expressionKind, eventType, degree })}>{busy ? <LoaderCircle className="is-spinning" /> : <Check />}确认保存</button></div>
  </section>
}

function RecentObservations({ history, loading, error, busy, onReload, onRevise }: {
  history: ObservationHistory | null
  loading: boolean
  error: string
  busy: boolean
  onReload(): void
  onRevise(observationPublicId: string, event: ObservationEvent, reason: string, replacement: Pick<ObservationEvent, 'expressionKind' | 'eventType' | 'degree'>): void
}) {
  return <section className="staff-observation-history" aria-label="最近已确认记录">
    <header><div><History size={17} /><span><strong>最近已确认</strong><small>最多显示本桌最近5条</small></span></div><button type="button" onClick={onReload} disabled={loading}>刷新</button></header>
    {error !== '' && <div className="staff-observation-error" role="alert"><AlertTriangle size={17} />{error}</div>}
    {loading && <p className="staff-observation-history-empty"><LoaderCircle className="is-spinning" />正在读取</p>}
    {!loading && history?.items.length === 0 && <p className="staff-observation-history-empty">本桌还没有已确认记录</p>}
    {!loading && history?.items.map(item => <article className="staff-observation-history-card" key={item.publicId}>
      <header><div><strong>{formatTime(item.confirmedAt)} · {item.confirmedBy}</strong><small>{item.rawContent ?? '观察原话仅授权人员可见'}</small></div><span className={item.needsImmediateAction ? 'is-urgent' : ''}>{item.needsImmediateAction ? serviceTaskLabel(item.serviceTaskStatus) : '仅记录'}</span></header>
      {item.events.map(event => <ObservationEventRow key={event.id} observationPublicId={item.publicId} event={event} canRevise={history.permissions.canCorrect && history.permissions.canViewRaw} busy={busy} onRevise={onRevise} />)}
      {item.revisions.length > 0 && <details className="staff-observation-revisions"><summary>查看修订记录（{item.revisions.length}）<ChevronDown size={15} /></summary>{item.revisions.map(revision => <div key={revision.id}><strong>{formatTime(revision.createdAt)} · {revision.correctedBy}</strong><p>原因：{revision.reason}</p><p>修订前：{snapshotSummary(revision.before)}</p><p>修订后：{snapshotSummary(revision.after)}</p></div>)}</details>}
    </article>)}
  </section>
}

function ObservationEventRow({ observationPublicId, event, canRevise, busy, onRevise }: {
  observationPublicId: string
  event: ObservationEvent
  canRevise: boolean
  busy: boolean
  onRevise(observationPublicId: string, event: ObservationEvent, reason: string, replacement: Pick<ObservationEvent, 'expressionKind' | 'eventType' | 'degree'>): void
}) {
  const [editing, setEditing] = useState(false)
  const [reason, setReason] = useState('')
  const [expressionKind, setExpressionKind] = useState<ObservationExpressionKind>(event.expressionKind === 'system_inference' ? 'staff_judgement' : event.expressionKind)
  const [eventType, setEventType] = useState(event.eventType)
  const [degree, setDegree] = useState(event.degree)
  return <section className="staff-observation-event">
    <div><span><strong>{event.productName ?? '桌台情况'}</strong><small>{expressionLabel(event.expressionKind)} · {eventTypeLabel(event.eventType)}{event.degree === null ? '' : ` · ${degreeLabel(event.degree)}`}</small></span>{canRevise && event.rawExcerpt !== null && <button type="button" aria-expanded={editing} onClick={() => setEditing(value => !value)}><Pencil size={15} />修正</button>}</div>
    {editing && <div className="staff-observation-revision-form">
      <p>原值：{eventTypeLabel(event.eventType)} / {expressionLabel(event.expressionKind)}。修订会追加新版本，不覆盖历史。</p>
      <div className="staff-observation-classification">
        <label><span>信息来源</span><select value={expressionKind} onChange={(change) => setExpressionKind(change.target.value as ObservationExpressionKind)}>{MANUAL_EXPRESSION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label><span>情况类型</span><select value={eventType} onChange={(change) => setEventType(change.target.value as ObservationEventType)}>{EVENT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label><span>程度</span><select value={degree ?? ''} onChange={(change) => setDegree(change.target.value === '' ? null : change.target.value as ObservationDegree)}><option value="">未说明</option>{DEGREE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      </div>
      <label><span>修正原因</span><input maxLength={500} value={reason} onChange={(change) => setReason(change.target.value)} placeholder="必填，例如：客人补充说明后更正" /></label>
      <div><button type="button" onClick={() => setEditing(false)}>取消</button><button type="button" className="staff-observation-primary" disabled={busy || reason.trim().length < 2} onClick={() => onRevise(observationPublicId, event, reason.trim(), { expressionKind, eventType, degree })}>{busy ? <LoaderCircle className="is-spinning" /> : <Check />}保存修订</button></div>
    </div>}
  </section>
}

const MANUAL_EXPRESSION_OPTIONS: ReadonlyArray<{ value: ObservationExpressionKind; label: string }> = [
  { value: 'objective_fact', label: '看到的事实' }, { value: 'customer_quote', label: '客人原话' },
  { value: 'staff_judgement', label: '员工判断' },
]
const EVENT_OPTIONS: ReadonlyArray<{ value: ObservationEventType; label: string }> = [
  { value: 'remaining', label: '有剩余' }, { value: 'consumed_little', label: '饮用/食用较少' },
  { value: 'praise', label: '表扬' }, { value: 'complaint', label: '投诉' }, { value: 'too_sweet', label: '太甜' },
  { value: 'too_cold', label: '太冷' }, { value: 'served_late', label: '上桌较晚' },
  { value: 'presentation', label: '呈现问题' }, { value: 'portion', label: '份量问题' }, { value: 'other', label: '其他' },
]
const DEGREE_OPTIONS: ReadonlyArray<{ value: ObservationDegree; label: string }> = [
  { value: 'little', label: '少量' }, { value: 'half', label: '约一半' }, { value: 'most', label: '大部分' },
  { value: 'almost_untouched', label: '几乎未动' }, { value: 'unknown', label: '不确定' },
]

function matchKindLabel(value: ObservationDraft['candidates'][number]['matchKind']): string {
  return ({ exact_name: '商品名匹配', search_text: '别名/搜索词匹配', order_context: '本桌唯一商品', manual: '人工确认' })[value]
}
function expressionLabel(value: ObservationExpressionKind): string {
  return value === 'system_inference' ? '系统推断' : MANUAL_EXPRESSION_OPTIONS.find(option => option.value === value)?.label ?? '来源待确认'
}
function eventTypeLabel(value: ObservationEventType): string { return EVENT_OPTIONS.find(option => option.value === value)?.label ?? '类型待确认' }
function degreeLabel(value: ObservationDegree): string { return DEGREE_OPTIONS.find(option => option.value === value)?.label ?? '程度待确认' }
function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间待确认' : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
function serviceTaskLabel(status: string | null): string {
  return ({ pending: '待处理', assigned: '已派单', in_progress: '处理中', completed: '已完成', cancelled: '已取消' } as Record<string, string>)[status ?? ''] ?? '已派现场任务'
}
function snapshotSummary(snapshot: Record<string, unknown>): string {
  const type = typeof snapshot.eventType === 'string' ? snapshot.eventType : 'other'
  const expression = typeof snapshot.expressionKind === 'string' ? snapshot.expressionKind : 'staff_judgement'
  const degree = typeof snapshot.degree === 'string' ? snapshot.degree : null
  return `${eventTypeLabel(type as ObservationEventType)} / ${expressionLabel(expression as ObservationExpressionKind)}${degree === null ? '' : ` / ${degreeLabel(degree as ObservationDegree)}`}`
}
