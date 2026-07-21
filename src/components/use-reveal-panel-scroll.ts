import { useEffect, useRef } from 'react'

export function useRevealPanelScroll<T extends HTMLElement>(signal: unknown) {
  const targetRef = useRef<T>(null)

  useEffect(() => {
    if (!signal) return
    const frame = window.requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      targetRef.current?.scrollIntoView({
        behavior: reducedMotion ? 'auto' : 'smooth',
        block: 'start',
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [signal])

  return targetRef
}
