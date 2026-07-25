const INTERACTIVE_SELECTOR = [
  'button:not(:disabled)',
  'a[href]',
  'summary',
  'select:not(:disabled)',
  'input[type="checkbox"]:not(:disabled)',
  'input[type="radio"]:not(:disabled)',
  '[role="button"]:not([aria-disabled="true"])',
].join(',')

const ACTION_CONTEXT_MS = 1_200
const interactionTimers = new WeakMap<Element, number>()
const actionTimers = new WeakMap<Element, number>()
const actionStates = new WeakMap<Element, { pending: number; previousAriaBusy: string | null }>()
let latestActionTarget: { target: Element; capturedAt: number } | null = null

function interactiveTarget(target: EventTarget | null) {
  return target instanceof Element ? target.closest(INTERACTIVE_SELECTOR) : null
}

function release(target: Element | null) {
  if (!target) return
  target.classList.remove('is-interaction-pressed')
}

function captureActionTarget(target: EventTarget | null) {
  const interactive = interactiveTarget(target)
  if (!interactive) return
  latestActionTarget = { target: interactive, capturedAt: Date.now() }
}

function recentActionTarget() {
  const context = latestActionTarget
  if (!context || !context.target.isConnected || Date.now() - context.capturedAt > ACTION_CONTEXT_MS) return null
  return context.target
}

function liveRegion(root: Document) {
  let region = root.getElementById('mbox-action-live-region')
  if (region) return region
  region = root.createElement('div')
  region.id = 'mbox-action-live-region'
  region.className = 'action-live-region'
  region.setAttribute('aria-live', 'polite')
  region.setAttribute('aria-atomic', 'true')
  root.body.append(region)
  return region
}

function announce(message: string) {
  if (typeof document === 'undefined') return
  const region = liveRegion(document)
  region.textContent = ''
  window.setTimeout(() => { region.textContent = message }, 0)
}

function haptic(pattern: number | number[]) {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  try {
    navigator.vibrate(pattern)
  } catch {
    // Some embedded browsers expose vibrate but reject calls at runtime.
  }
}

export function hapticEnabledForContext(insideGuestPortal: boolean, mode?: string | null) {
  return !insideGuestPortal || mode === 'action'
}

function shouldUseHaptic(target: Element) {
  return hapticEnabledForContext(Boolean(target.closest('.guest-shell')), target.getAttribute('data-haptic'))
}

function clearOutcome(target: Element) {
  const timer = actionTimers.get(target)
  if (timer) window.clearTimeout(timer)
  actionTimers.delete(target)
  target.classList.remove('is-action-succeeded', 'is-action-failed')
  if (['succeeded', 'failed'].includes(target.getAttribute('data-action-state') ?? '')) target.removeAttribute('data-action-state')
}

function beginAction(target: Element) {
  clearOutcome(target)
  const state = actionStates.get(target) ?? {
    pending: 0,
    previousAriaBusy: target.getAttribute('aria-busy'),
  }
  state.pending += 1
  actionStates.set(target, state)
  target.classList.add('is-action-pending')
  target.setAttribute('data-action-state', 'pending')
  target.setAttribute('aria-busy', 'true')
}

function finishAction(target: Element, outcome: 'succeeded' | 'failed') {
  const state = actionStates.get(target)
  if (!state) return
  state.pending = Math.max(0, state.pending - 1)
  if (state.pending > 0) return
  actionStates.delete(target)
  target.classList.remove('is-action-pending')
  target.setAttribute('data-action-state', outcome)
  if (state.previousAriaBusy === null) target.removeAttribute('aria-busy')
  else target.setAttribute('aria-busy', state.previousAriaBusy)
  target.classList.add(outcome === 'succeeded' ? 'is-action-succeeded' : 'is-action-failed')
  if (shouldUseHaptic(target)) haptic(outcome === 'succeeded' ? 12 : [18, 35, 18])
  actionTimers.set(target, window.setTimeout(() => {
    target.classList.remove('is-action-succeeded', 'is-action-failed')
    if (target.getAttribute('data-action-state') === outcome) target.removeAttribute('data-action-state')
    actionTimers.delete(target)
  }, outcome === 'succeeded' ? 650 : 1_500))
}

export function shouldTrackMutation(path: string, method = 'GET') {
  const normalizedMethod = method.toUpperCase()
  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD' || normalizedMethod === 'OPTIONS') return false
  return ![
    '/api/auth/presence/heartbeat',
    '/api/guest/events',
    '/api/public/reservation-session',
  ].some((excludedPath) => path.startsWith(excludedPath))
}

export async function withInteractionAction<T>(operation: () => Promise<T>, options: { enabled?: boolean } = {}) {
  if (options.enabled === false || typeof document === 'undefined') return operation()
  const target = recentActionTarget()
  if (!target) return operation()
  beginAction(target)
  try {
    const result = await operation()
    finishAction(target, 'succeeded')
    announce('操作已完成')
    return result
  } catch (error) {
    finishAction(target, 'failed')
    announce('操作未完成，页面已恢复，请重试')
    throw error
  }
}

export function installInteractionFeedback(root: Document = document) {
  const pressedTargets = new Map<number, Element>()
  const releaseAll = () => {
    pressedTargets.forEach((target) => release(target))
    pressedTargets.clear()
  }
  const onPointerDown = (event: PointerEvent) => {
    const target = interactiveTarget(event.target)
    if (!target) return
    captureActionTarget(target)
    pressedTargets.set(event.pointerId, target)
    target.classList.add('is-interaction-pressed')
    if (event.pointerType === 'touch' && event.isPrimary && shouldUseHaptic(target)) haptic(7)
  }
  const onPointerRelease = (event: PointerEvent) => {
    release(pressedTargets.get(event.pointerId) ?? null)
    pressedTargets.delete(event.pointerId)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') captureActionTarget(event.target)
  }
  const onClickCapture = (event: MouseEvent) => {
    const target = interactiveTarget(event.target)
    if (!target) return
    if (target.getAttribute('data-action-state') === 'pending') {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    captureActionTarget(target)
  }
  const onClick = (event: MouseEvent) => {
    const target = interactiveTarget(event.target)
    if (!target) return
    release(target)
    const previousTimer = interactionTimers.get(target)
    if (previousTimer) window.clearTimeout(previousTimer)
    target.classList.remove('is-interaction-confirmed')
    void (target as HTMLElement).offsetWidth
    target.classList.add('is-interaction-confirmed')
    interactionTimers.set(target, window.setTimeout(() => {
      target.classList.remove('is-interaction-confirmed')
      interactionTimers.delete(target)
    }, 190))
  }

  root.addEventListener('pointerdown', onPointerDown)
  root.addEventListener('pointerup', onPointerRelease)
  root.addEventListener('pointercancel', onPointerRelease)
  root.addEventListener('keydown', onKeyDown, true)
  root.addEventListener('click', onClickCapture, true)
  root.addEventListener('click', onClick)
  window.addEventListener('blur', releaseAll)

  return () => {
    releaseAll()
    root.removeEventListener('pointerdown', onPointerDown)
    root.removeEventListener('pointerup', onPointerRelease)
    root.removeEventListener('pointercancel', onPointerRelease)
    root.removeEventListener('keydown', onKeyDown, true)
    root.removeEventListener('click', onClickCapture, true)
    root.removeEventListener('click', onClick)
    window.removeEventListener('blur', releaseAll)
  }
}
