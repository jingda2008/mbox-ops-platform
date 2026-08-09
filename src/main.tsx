import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { installInteractionFeedback } from './interaction-feedback.ts'

const manifestLink = document.createElement('link')
manifestLink.rel = 'manifest'
manifestLink.href = '/manifest.webmanifest'
document.head.append(manifestLink)
installInteractionFeedback()

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js')
  })
}

const root = createRoot(document.getElementById('root')!)
const render = (content: ReactNode) => root.render(<StrictMode>{content}</StrictMode>)
const path = window.location.pathname

render(<main className="system-state"><strong>正在打开 M-BOX</strong></main>)

async function startApplication() {
  if (/^\/guest(?:\/|$)/.test(path)) {
    const { GuestPortal } = await import('./components/GuestPortal')
    render(<GuestPortal />)
    return
  }
  if (/^\/member(?:\/|$)/.test(path)) {
    const { MemberBenefitsPortal } = await import('./components/MemberBenefitsPortal')
    render(<MemberBenefitsPortal />)
    return
  }
  if (/^\/reserve(?:\/|$)/.test(path)) {
    const { PublicReservationPortal } = await import('./components/PublicReservationPortal')
    render(<PublicReservationPortal />)
    return
  }

  // The role home is rendered by App itself. OperationsConsole stays lazy so
  // the employee first paint does not wait for an operations-only workspace.
  const { default: App } = await import('./App.tsx')
  render(<App />)
}

void startApplication().catch(() => {
  render(<main className="system-state"><strong>页面暂时没有打开，请刷新重试</strong></main>)
})
