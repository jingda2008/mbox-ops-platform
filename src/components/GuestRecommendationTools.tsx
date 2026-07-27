import { Check, ChevronRight, Eye, RefreshCw, Shuffle, Sparkles, Volume2, VolumeX, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { MenuProduct } from '../shared/contracts'
import './GuestRecommendationTools.css'

export interface GuestRecommendationContext {
  intent?: 'relaxed' | 'energetic' | 'ritual' | 'unsure'
  taste?: 'refreshing' | 'layered' | 'strong' | 'any'
  dwell?: 'one_set' | 'stay_longer' | 'no_rush'
}

export type GuestRecommendationInteractionMetadata = Record<string, string | number | boolean | null>

// oxlint-disable-next-line react/only-export-components -- stable guest copy is verified by the pure logic test.
export const GUEST_SHAKE_RECOMMENDATION_COPY = '根据今晚的选择替你挑一款'

// oxlint-disable-next-line react/only-export-components -- device feedback values are verified by the pure logic test.
export const GUEST_SHAKE_FEEDBACK_PATTERNS = {
  start: [28, 45, 28],
  reveal: [45, 30, 70],
} as const

interface GuestRecommendationToolsProps {
  context: GuestRecommendationContext
  onContextChange: (context: GuestRecommendationContext) => void
  shakeProduct?: MenuProduct | null
  shakeCount: number
  shakeLimit: number
  onShake: () => void
  onOpenProduct: (product: MenuProduct) => void
  onChooseProduct: (product: MenuProduct) => void
  onInteraction?: (event: string, metadata?: GuestRecommendationInteractionMetadata) => void
}

type RecommendationStep = keyof GuestRecommendationContext
type RecommendationAnswer = NonNullable<GuestRecommendationContext[RecommendationStep]>

interface RecommendationQuestion {
  field: RecommendationStep
  eyebrow: string
  title: string
  options: ReadonlyArray<{ value: RecommendationAnswer; label: string }>
}

// oxlint-disable-next-line react/only-export-components -- deterministic question definitions are unit tested without a DOM.
export const GUEST_RECOMMENDATION_QUESTIONS: readonly RecommendationQuestion[] = [
  {
    field: 'intent',
    eyebrow: '01 · 今晚的节奏',
    title: '今晚想怎么过？',
    options: [
      { value: 'relaxed', label: '轻松一点' },
      { value: 'energetic', label: '今晚要嗨' },
      { value: 'ritual', label: '来点仪式感' },
      { value: 'unsure', label: '还没想好' },
    ],
  },
  {
    field: 'taste',
    eyebrow: '02 · 喜欢的感觉',
    title: '更喜欢哪种感觉？',
    options: [
      { value: 'refreshing', label: '清爽好入口' },
      { value: 'layered', label: '慢慢喝有层次' },
      { value: 'strong', label: '酒感明显一点' },
      { value: 'any', label: '都可以' },
    ],
  },
  {
    field: 'dwell',
    eyebrow: '03 · 今晚的时间',
    title: '今晚准备待多久？',
    options: [
      { value: 'one_set', label: '听完这一场' },
      { value: 'stay_longer', label: '多待一会' },
      { value: 'no_rush', label: '今晚不赶时间' },
    ],
  },
] as const

// oxlint-disable-next-line react/only-export-components -- deterministic recommendation state is unit tested without a DOM.
export function applyGuestRecommendationAnswer(
  context: GuestRecommendationContext,
  field: RecommendationStep,
  value: RecommendationAnswer,
): GuestRecommendationContext {
  return { ...context, [field]: value }
}

// oxlint-disable-next-line react/only-export-components -- deterministic recommendation state is unit tested without a DOM.
export function isGuestRecommendationComplete(context: GuestRecommendationContext) {
  return Boolean(context.intent && context.taste && context.dwell)
}

// oxlint-disable-next-line react/only-export-components -- the parent owns shake selection while this helper controls presentation state.
export function canRequestAnotherShake(shakeCount: number, shakeLimit: number) {
  return shakeLimit > 0 && shakeCount < shakeLimit
}

// oxlint-disable-next-line react/only-export-components -- reveal gating is unit tested without a DOM.
export function shouldRevealShakeProduct(pendingReveal: boolean, previousProductId: string, nextProductId: string) {
  return pendingReveal && Boolean(nextProductId) && previousProductId !== nextProductId
}

function formatPrice(amount: number) {
  return (amount / 100).toFixed(2).replace(/\.00$/, '')
}

type ShakeFeedbackKind = keyof typeof GUEST_SHAKE_FEEDBACK_PATTERNS
type AudioContextConstructor = new () => AudioContext
type AudioWindow = Window & { webkitAudioContext?: AudioContextConstructor }

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function vibrateShakeFeedback(kind: ShakeFeedbackKind) {
  if (prefersReducedMotion() || typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  try {
    navigator.vibrate([...GUEST_SHAKE_FEEDBACK_PATTERNS[kind]])
  } catch {
    // Feedback is optional and must never block ordering.
  }
}

function scheduleTone(context: AudioContext, startsAt: number, frequency: number, duration: number, peakGain: number) {
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(frequency, startsAt)
  gain.gain.setValueAtTime(.0001, startsAt)
  gain.gain.exponentialRampToValueAtTime(peakGain, startsAt + .012)
  gain.gain.exponentialRampToValueAtTime(.0001, startsAt + duration)
  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start(startsAt)
  oscillator.stop(startsAt + duration + .01)
}

function playShakeAudioFeedback(context: AudioContext, kind: ShakeFeedbackKind) {
  const startsAt = context.currentTime + .01
  if (kind === 'start') {
    scheduleTone(context, startsAt, 520, .055, .018)
    scheduleTone(context, startsAt + .085, 660, .06, .016)
    return
  }
  scheduleTone(context, startsAt, 720, .065, .02)
  scheduleTone(context, startsAt + .07, 910, .085, .022)
}

function playOptionalShakeAudio(
  contextRef: { current: AudioContext | null },
  soundEnabled: boolean,
  kind: ShakeFeedbackKind,
) {
  if (!soundEnabled || typeof window === 'undefined') return
  try {
    const AudioContextClass = window.AudioContext ?? (window as AudioWindow).webkitAudioContext
    if (!AudioContextClass) return
    const audioContext = contextRef.current ?? new AudioContextClass()
    contextRef.current = audioContext
    if (audioContext.state === 'suspended') {
      void audioContext.resume()
        .then(() => playShakeAudioFeedback(audioContext, kind))
        .catch(() => undefined)
      return
    }
    if (audioContext.state === 'running') playShakeAudioFeedback(audioContext, kind)
  } catch {
    // Audio feedback silently degrades on unsupported or restricted devices.
  }
}

export function GuestRecommendationTools({
  context,
  onContextChange,
  shakeProduct = null,
  shakeCount,
  shakeLimit,
  onShake,
  onOpenProduct,
  onChooseProduct,
  onInteraction,
}: GuestRecommendationToolsProps) {
  const [activeSheet, setActiveSheet] = useState<'quick' | 'shake' | null>(null)
  const [questionIndex, setQuestionIndex] = useState(0)
  const [draftContext, setDraftContext] = useState<GuestRecommendationContext>(context)
  const [soundEnabled, setSoundEnabled] = useState(true)
  const audioContextRef = useRef<AudioContext | null>(null)
  const pendingRevealRef = useRef(false)
  const previousShakeProductIdRef = useRef(shakeProduct?.id ?? '')
  const question = GUEST_RECOMMENDATION_QUESTIONS[questionIndex]!
  const shakeAvailable = canRequestAnotherShake(shakeCount, shakeLimit)

  useEffect(() => () => {
    const contextToClose = audioContextRef.current
    audioContextRef.current = null
    if (contextToClose && contextToClose.state !== 'closed') void contextToClose.close().catch(() => undefined)
  }, [])

  useEffect(() => {
    const nextProductId = shakeProduct?.id ?? ''
    if (!shouldRevealShakeProduct(pendingRevealRef.current, previousShakeProductIdRef.current, nextProductId)) return
    pendingRevealRef.current = false
    previousShakeProductIdRef.current = nextProductId
    vibrateShakeFeedback('reveal')
    playOptionalShakeAudio(audioContextRef, soundEnabled, 'reveal')
    onInteraction?.('recommendation_shake_revealed', { productId: nextProductId, attempt: shakeCount })
  }, [onInteraction, shakeCount, shakeProduct?.id, soundEnabled])

  function beginShakeFeedback() {
    pendingRevealRef.current = true
    previousShakeProductIdRef.current = shakeProduct?.id ?? ''
    vibrateShakeFeedback('start')
    playOptionalShakeAudio(audioContextRef, soundEnabled, 'start')
  }

  function closeSheet(reason: 'dismissed' | 'completed' | 'product_action' = 'dismissed') {
    if (activeSheet) onInteraction?.(`recommendation_${activeSheet}_closed`, { reason })
    setActiveSheet(null)
  }

  function openQuickSelection() {
    setDraftContext(context)
    setQuestionIndex(0)
    setActiveSheet('quick')
    onInteraction?.('recommendation_quick_opened')
  }

  function openShake() {
    setActiveSheet('shake')
    onInteraction?.('recommendation_shake_opened', { shakeCount, shakeLimit })
    if (shakeAvailable) {
      beginShakeFeedback()
      onShake()
      onInteraction?.('recommendation_shake_requested', { attempt: shakeCount + 1, shakeLimit })
    }
  }

  function answerQuestion(value: RecommendationAnswer) {
    const nextContext = applyGuestRecommendationAnswer(draftContext, question.field, value)
    setDraftContext(nextContext)
    onInteraction?.('recommendation_quick_answered', {
      field: question.field,
      value,
      step: questionIndex + 1,
    })

    if (questionIndex < GUEST_RECOMMENDATION_QUESTIONS.length - 1) {
      setQuestionIndex((current) => current + 1)
      return
    }

    onContextChange(nextContext)
    onInteraction?.('recommendation_quick_completed', {
      intent: nextContext.intent ?? null,
      taste: nextContext.taste ?? null,
      dwell: nextContext.dwell ?? null,
    })
    closeSheet('completed')
  }

  function requestAnotherShake() {
    if (!shakeAvailable) return
    beginShakeFeedback()
    onShake()
    onInteraction?.('recommendation_shake_requested', { attempt: shakeCount + 1, shakeLimit })
  }

  return (
    <section className="guest-recommendation-tools" aria-label="酒水推荐工具" data-testid="guest-recommendation-tools">
      <div className="guest-recommendation-entries">
        <button type="button" className="guest-recommendation-entry is-quick" data-testid="guest-quick-select" onClick={openQuickSelection}>
          <span className="guest-recommendation-entry-icon"><Sparkles size={19} aria-hidden="true" /></span>
          <span><strong>帮我快速选</strong><small>回答三个小问题</small></span>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
        <button type="button" className="guest-recommendation-entry is-shake" data-testid="guest-shake-pick" onClick={openShake}>
          <span className="guest-recommendation-entry-icon"><Shuffle size={19} aria-hidden="true" /></span>
          <span><strong>摇一摇喝什么</strong><small>给今晚一点灵感</small></span>
        </button>
      </div>

      {activeSheet && (
        <>
          <button
            type="button"
            className="guest-recommendation-backdrop"
            aria-label="关闭推荐"
            onClick={() => closeSheet()}
          />
          <section
            className="guest-recommendation-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`guest-recommendation-${activeSheet}-title`}
          >
            {activeSheet === 'quick' ? (
              <>
                <header className="guest-recommendation-sheet-header">
                  <div>
                    <small>{question.eyebrow}</small>
                    <h2 id="guest-recommendation-quick-title">{question.title}</h2>
                  </div>
                  <button type="button" className="guest-recommendation-icon-button" aria-label="关闭快速选择" onClick={() => closeSheet()}>
                    <X size={19} />
                  </button>
                </header>
                <div className="guest-recommendation-progress" aria-label={`第${questionIndex + 1}题，共${GUEST_RECOMMENDATION_QUESTIONS.length}题`}>
                  {GUEST_RECOMMENDATION_QUESTIONS.map((item, index) => (
                    <i key={item.field} className={index <= questionIndex ? 'is-active' : ''} />
                  ))}
                </div>
                <div className="guest-recommendation-options">
                  {question.options.map((option) => (
                    <button
                      type="button"
                      key={option.value}
                      aria-pressed={draftContext[question.field] === option.value}
                      onClick={() => answerQuestion(option.value)}
                    >
                      <span>{option.label}</span>
                      <ChevronRight size={17} aria-hidden="true" />
                    </button>
                  ))}
                </div>
                <footer className="guest-recommendation-sheet-note">没有标准答案，只是帮我们更懂今晚的您。</footer>
              </>
            ) : (
              <>
                <header className="guest-recommendation-sheet-header">
                  <div>
                    <small>SHAKE A PICK · {Math.min(shakeCount, shakeLimit)}/{Math.max(0, shakeLimit)}</small>
                    <h2 id="guest-recommendation-shake-title">{GUEST_SHAKE_RECOMMENDATION_COPY}</h2>
                  </div>
                  <div className="guest-recommendation-header-actions">
                    <button
                      type="button"
                      className="guest-recommendation-icon-button"
                      aria-label={soundEnabled ? '关闭推荐音效' : '开启推荐音效'}
                      aria-pressed={!soundEnabled}
                      title={soundEnabled ? '关闭推荐音效' : '开启推荐音效'}
                      onClick={() => {
                        setSoundEnabled((enabled) => !enabled)
                        onInteraction?.('recommendation_sound_toggled', { enabled: !soundEnabled })
                      }}
                    >
                      {soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
                    </button>
                    <button type="button" className="guest-recommendation-icon-button" aria-label="关闭摇一摇推荐" onClick={() => closeSheet()}>
                      <X size={19} />
                    </button>
                  </div>
                </header>
                {shakeProduct ? (
                  <article className="guest-recommendation-product">
                    <div className="guest-recommendation-product-image">
                      {shakeProduct.imageUrl
                        ? <img src={shakeProduct.imageUrl} alt={shakeProduct.name} />
                        : <span>{Array.from(shakeProduct.name)[0]}</span>}
                    </div>
                    <div>
                      <small>{shakeProduct.categoryName ?? '今夜灵感'}</small>
                      <h3>{shakeProduct.name}</h3>
                      <p>{shakeProduct.description || shakeProduct.specification || '适合今晚慢慢品尝'}</p>
                      <strong>¥{formatPrice(shakeProduct.listPriceAmount)}</strong>
                    </div>
                  </article>
                ) : (
                  <div className="guest-recommendation-product-empty">
                    <Shuffle size={25} aria-hidden="true" />
                    <strong>{shakeAvailable ? '正在为今晚挑选' : '今晚的灵感已经摇完啦'}</strong>
                    <span>{shakeAvailable ? '很快就好' : '可以从刚才的推荐里选一款'}</span>
                  </div>
                )}
                <footer className="guest-recommendation-actions">
                  <button type="button" className="is-secondary" disabled={!shakeAvailable} onClick={requestAnotherShake}>
                    <RefreshCw size={17} />再摇一次
                  </button>
                  <button
                    type="button"
                    className="is-secondary"
                    disabled={!shakeProduct}
                    onClick={() => {
                      if (!shakeProduct) return
                      closeSheet('product_action')
                      onInteraction?.('recommendation_shake_product_opened', { productId: shakeProduct.id })
                      onOpenProduct(shakeProduct)
                    }}
                  >
                    <Eye size={17} />看看详情
                  </button>
                  <button
                    type="button"
                    className="is-primary"
                    disabled={!shakeProduct}
                    onClick={() => {
                      if (!shakeProduct) return
                      closeSheet('product_action')
                      onInteraction?.('recommendation_shake_product_chosen', { productId: shakeProduct.id })
                      onChooseProduct(shakeProduct)
                    }}
                  >
                    <Check size={17} />就选这个
                  </button>
                </footer>
              </>
            )}
          </section>
        </>
      )}
    </section>
  )
}
