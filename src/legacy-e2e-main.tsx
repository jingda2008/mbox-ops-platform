import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { installInteractionFeedback } from './interaction-feedback.ts'

const manifestLink = document.createElement('link')
manifestLink.rel = 'manifest'
manifestLink.href = '/manifest.webmanifest'
document.head.append(manifestLink)
installInteractionFeedback()

const element = document.getElementById('root')
if (element === null) throw new Error('M-BOX legacy E2E root is missing')
const root = createRoot(element)
const render = (content: ReactNode) => root.render(<StrictMode>{content}</StrictMode>)
const path = window.location.pathname

render(<main className="system-state"><strong>正在打开 M-BOX</strong></main>)

async function startLegacyApplication() {
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

  const { default: App } = await import('./App.tsx')
  render(<App />)
}

void startLegacyApplication().catch(() => {
  render(<main className="system-state"><strong>页面暂时没有打开，请刷新重试</strong></main>)
})
