const REVEAL_SELECTOR = [
  '[data-action-reveal]:not([data-action-reveal="off"])',
  '[role="alert"]',
  '[role="dialog"]',
  '[role="status"]',
  '[aria-live]:not([aria-live="off"])',
].join(',')

const ACTION_SELECTOR = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], a[href]'
const REVEAL_WINDOW_MS = 12_000

export interface ActionRevealController {
  dispose(): void
}

export function installGlobalActionReveal(
  documentRef: Document = document,
  windowRef: Window = window,
): ActionRevealController {
  let operation = 0
  let activeObserver: MutationObserver | null = null
  let activeTimer: number | null = null

  const stopWatching = () => {
    activeObserver?.disconnect()
    activeObserver = null
    if (activeTimer !== null) windowRef.clearTimeout(activeTimer)
    activeTimer = null
  }

  const handleClick = (event: MouseEvent) => {
    const action = event.target instanceof Element ? event.target.closest(ACTION_SELECTOR) : null
    if (!(action instanceof HTMLElement) || action.matches(':disabled, [aria-disabled="true"]')) return

    operation += 1
    const actionOperation = operation
    stopWatching()
    const visibleBefore = new Set([...documentRef.querySelectorAll(REVEAL_SELECTOR)].filter(isRendered))
    const changed = new Set<Element>()
    const controlledIds = (action.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean)

    const reveal = () => {
      if (operation !== actionOperation) return
      const controlled = controlledIds.map((id) => documentRef.getElementById(id)).filter((item): item is HTMLElement => item !== null)
      const newCandidates = [...documentRef.querySelectorAll(REVEAL_SELECTOR)]
        .filter((candidate) => isRendered(candidate) && !visibleBefore.has(candidate))
      const changedCandidates = [...changed]
        .flatMap((candidate) => revealCandidates(candidate))
        .filter((candidate) => isRendered(candidate) && shouldRevealChangedCandidate(candidate, visibleBefore))
      const target = [...controlled, ...newCandidates, ...changedCandidates]
        .find((candidate): candidate is HTMLElement => (
          candidate instanceof HTMLElement
          && isRendered(candidate)
          && !isFixedOverlay(candidate, windowRef)
          && !isComfortablyVisible(candidate, windowRef)
        ))
      if (target === undefined) return
      target.scrollIntoView({
        behavior: prefersReducedMotion(windowRef) ? 'auto' : 'smooth',
        block: target.getAttribute('role') === 'dialog' ? 'center' : 'start',
      })
    }

    activeObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target instanceof Element) changed.add(record.target)
        else if (record.target.parentElement !== null) changed.add(record.target.parentElement)
        for (const node of record.addedNodes) if (node instanceof Element) changed.add(node)
      }
      windowRef.requestAnimationFrame(reveal)
    })
    activeObserver.observe(documentRef.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden', 'aria-expanded', 'data-state'],
    })
    windowRef.requestAnimationFrame(() => windowRef.requestAnimationFrame(reveal))
    activeTimer = windowRef.setTimeout(stopWatching, REVEAL_WINDOW_MS)
  }

  documentRef.addEventListener('click', handleClick, true)
  return {
    dispose() {
      operation += 1
      stopWatching()
      documentRef.removeEventListener('click', handleClick, true)
    },
  }
}

export function isComfortablyVisible(element: Element, windowRef: Pick<Window, 'innerHeight' | 'innerWidth'>): boolean {
  const rect = element.getBoundingClientRect()
  const verticalMargin = Math.min(24, windowRef.innerHeight * 0.04)
  const horizontalMargin = Math.min(16, windowRef.innerWidth * 0.03)
  return rect.top >= verticalMargin
    && rect.left >= horizontalMargin
    && rect.bottom <= windowRef.innerHeight - verticalMargin
    && rect.right <= windowRef.innerWidth - horizontalMargin
}

export function shouldRevealChangedCandidate(candidate: Element, visibleBefore: ReadonlySet<Element>): boolean {
  return !visibleBefore.has(candidate)
    || candidate.getAttribute('role') === 'alert'
    || candidate.getAttribute('role') === 'status'
    || (candidate.hasAttribute('aria-live') && candidate.getAttribute('aria-live') !== 'off')
}

function revealCandidates(element: Element): Element[] {
  const ownCandidate = element.closest(REVEAL_SELECTOR)
  return [
    ...(ownCandidate === null ? [] : [ownCandidate]),
    ...element.querySelectorAll(REVEAL_SELECTOR),
  ]
}

function isRendered(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false
  return element.getClientRects().length > 0
}

function isFixedOverlay(element: HTMLElement, windowRef: Window): boolean {
  const position = windowRef.getComputedStyle(element).position
  return position === 'fixed' || position === 'sticky'
}

function prefersReducedMotion(windowRef: Window): boolean {
  return windowRef.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}
