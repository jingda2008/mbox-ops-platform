const INTERACTIVE_SELECTOR = [
  'button:not(:disabled)',
  'a[href]',
  'summary',
  'select:not(:disabled)',
  'input[type="checkbox"]:not(:disabled)',
  'input[type="radio"]:not(:disabled)',
  '[role="button"]:not([aria-disabled="true"])',
].join(',')

const releaseTimers = new WeakMap<Element, number>()

function interactiveTarget(target: EventTarget | null) {
  return target instanceof Element ? target.closest(INTERACTIVE_SELECTOR) : null
}

function release(target: Element | null) {
  if (!target) return
  target.classList.remove('is-interaction-pressed')
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
    pressedTargets.set(event.pointerId, target)
    target.classList.add('is-interaction-pressed')
  }
  const onPointerRelease = (event: PointerEvent) => {
    release(pressedTargets.get(event.pointerId) ?? null)
    pressedTargets.delete(event.pointerId)
  }
  const onClick = (event: MouseEvent) => {
    const target = interactiveTarget(event.target)
    if (!target) return
    release(target)
    const previousTimer = releaseTimers.get(target)
    if (previousTimer) window.clearTimeout(previousTimer)
    target.classList.remove('is-interaction-confirmed')
    void (target as HTMLElement).offsetWidth
    target.classList.add('is-interaction-confirmed')
    releaseTimers.set(target, window.setTimeout(() => {
      target.classList.remove('is-interaction-confirmed')
      releaseTimers.delete(target)
    }, 190))
  }

  root.addEventListener('pointerdown', onPointerDown)
  root.addEventListener('pointerup', onPointerRelease)
  root.addEventListener('pointercancel', onPointerRelease)
  root.addEventListener('click', onClick)
  window.addEventListener('blur', releaseAll)

  return () => {
    releaseAll()
    root.removeEventListener('pointerdown', onPointerDown)
    root.removeEventListener('pointerup', onPointerRelease)
    root.removeEventListener('pointercancel', onPointerRelease)
    root.removeEventListener('click', onClick)
    window.removeEventListener('blur', releaseAll)
  }
}
