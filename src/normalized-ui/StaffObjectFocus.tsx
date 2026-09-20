import { useEffect, useState } from 'react'

/** Deep links point at the original authoritative record, never a copied action form. */
export function StaffObjectFocus({ route }: { route: string }) {
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    setMissing(false)
    const requested = new URLSearchParams(window.location.search).get('todo')
    if (!requested) return
    let found = false
    const focus = () => {
      if (found) return
      const target = document.querySelector<HTMLElement>(`[data-staff-todo-id="${CSS.escape(requested)}"]`)
      if (!target || target.getClientRects().length === 0) return
      found = true
      target.tabIndex = -1
      target.classList.add('staff-todo-target')
      target.focus({ preventScroll: true })
      target.scrollIntoView({ block: 'center', behavior: 'instant' })
      setMissing(false)
      observer.disconnect()
    }
    const observer = new MutationObserver(focus)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] })
    focus()
    const timer = window.setTimeout(() => { if (!found) setMissing(true) }, 8_000)
    return () => { observer.disconnect(); window.clearTimeout(timer) }
  }, [route])
  return missing ? <p className="normalized-route-notice" role="status">这项记录尚未读到，可能已由同事处理或不在当前查询范围。请刷新原业务核对后继续。</p> : null
}
