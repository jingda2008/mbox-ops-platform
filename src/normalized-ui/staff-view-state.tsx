import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type SetStateAction } from 'react'

class StaffViewStore {
  values = new Map<string, unknown>()
  positions = new Map<string, number>()
  listeners = new Set<() => void>()
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
}
const StaffViewContext = createContext<StaffViewStore | null>(null)

/** Memory only, remounted for each authenticated identity. Never store payment/approval drafts here. */
export function StaffViewStateProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new StaffViewStore())
  return <StaffViewContext.Provider value={store}>{children}</StaffViewContext.Provider>
}

export function useStaffViewState<T>(key: string, initial: T | (() => T)): [T, (value: SetStateAction<T>) => void] {
  const shared = useContext(StaffViewContext)
  const [local] = useState(() => new StaffViewStore())
  const store = shared ?? local
  const initialRef = useRef(initial)
  const read = useCallback((): T => {
    if (!store.values.has(key)) {
      const value = initialRef.current
      store.values.set(key, typeof value === 'function' ? (value as () => T)() : value)
    }
    return store.values.get(key) as T
  }, [key, store])
  const value = useSyncExternalStore(store.subscribe, read, read)
  const write = useCallback((next: SetStateAction<T>) => {
    store.values.set(key, typeof next === 'function' ? (next as (current: T) => T)(read()) : next)
    store.listeners.forEach(listener => listener())
  }, [key, read, store])
  return [value, write]
}

/** Restore after asynchronous list content is ready; a deliberate user movement cancels restoration. */
export function StaffRouteRestoration({ route }: { route: string }) {
  const store = useContext(StaffViewContext)
  useLayoutEffect(() => {
    if (!store) return
    const target = store.positions.get(route) ?? 0
    let restoring = true
    const previousMode = history.scrollRestoration
    history.scrollRestoration = 'manual'
    const save = () => { if (!restoring) store.positions.set(route, window.scrollY) }
    const beforeNavigation = () => { if (!restoring) save() }
    const stop = () => { restoring = false; observer.disconnect(); window.cancelAnimationFrame(frame) }
    const restore = () => {
      if (!restoring) return
      window.scrollTo({ top: target, behavior: 'instant' })
      if (document.documentElement.scrollHeight - window.innerHeight >= target) stop()
    }
    const observer = new ResizeObserver(restore)
    observer.observe(document.body)
    let frame = window.requestAnimationFrame(restore)
    const timer = window.setTimeout(stop, 8_000)
    const userMovement = () => { stop(); save() }
    window.addEventListener('scroll', save, { passive: true })
    window.addEventListener('mbox:before-staff-navigation', beforeNavigation)
    window.addEventListener('wheel', userMovement, { passive: true })
    window.addEventListener('touchstart', userMovement, { passive: true })
    window.addEventListener('keydown', userMovement)
    return () => {
      stop(); window.clearTimeout(timer); frame = 0
      window.removeEventListener('scroll', save)
      window.removeEventListener('mbox:before-staff-navigation', beforeNavigation)
      window.removeEventListener('wheel', userMovement)
      window.removeEventListener('touchstart', userMovement)
      window.removeEventListener('keydown', userMovement)
      history.scrollRestoration = previousMode
    }
  }, [route, store])
  return null
}

export function staffLocationSearch() { return typeof window === 'undefined' ? '' : window.location.search }
