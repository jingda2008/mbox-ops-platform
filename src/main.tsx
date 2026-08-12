import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './normalized-base.css'
import { installGlobalActionReveal } from './global-action-reveal'

const element = document.getElementById('root')
if (element === null) throw new Error('M-BOX application root is missing')
const root = createRoot(element)
const render = (content: ReactNode) => root.render(<StrictMode>{content}</StrictMode>)

installGlobalActionReveal()

render(<main className="normalized-system-state"><strong>正在打开 M-BOX</strong></main>)

void removeLegacyOfflineRuntime()
void startNormalizedApplication().catch(() => {
  render(<main className="normalized-system-state normalized-system-error"><strong>页面暂时没有打开</strong><span>请刷新后再试，仍未恢复请联系值班经理。</span></main>)
})

async function startNormalizedApplication() {
  const path = window.location.pathname
  if (/^\/guest(?:\/|$)/.test(path)) {
    const { GuestApp } = await import('./normalized-ui/guest')
    render(<GuestApp />)
    return
  }
  if (/^\/reserve(?:\/|$)/.test(path)) {
    const { ReservationBooking } = await import('./normalized-ui/reservation')
    const { getAnonymousReservationIdentity } = await import('./normalized-ui/reservation/reservation-identity')
    const currentUrl = new URL(window.location.href)
    const reservationParam = currentUrl.searchParams.get('reservation')?.trim()
    const initialReservationId = reservationParam !== undefined && reservationParam.length <= 128
      ? reservationParam
      : undefined
    render(<ReservationBooking
      identity={getAnonymousReservationIdentity()}
      initialReservationId={initialReservationId}
      onReservationChange={(reservation) => {
        const nextUrl = new URL(window.location.href)
        if (reservation === null) nextUrl.searchParams.delete('reservation')
        else nextUrl.searchParams.set('reservation', reservation.publicId)
        window.history.replaceState(null, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`)
      }}
    />)
    return
  }
  if (/^\/member(?:\/|$)/.test(path)) {
    const { MemberPortal } = await import('./normalized-ui/member/MemberPortal')
    render(<MemberPortal />)
    return
  }
  const { NormalizedStaffApp } = await import('./normalized-ui/NormalizedStaffApp')
  render(<NormalizedStaffApp />)
}

async function removeLegacyOfflineRuntime() {
  if (!('serviceWorker' in navigator)) return
  const registrations = await navigator.serviceWorker.getRegistrations().catch(() => [])
  await Promise.all(registrations.map((registration) => registration.unregister()))
  if ('caches' in window) {
    const keys = await caches.keys().catch(() => [])
    await Promise.all(keys.filter((key) => key.startsWith('mbox-')).map((key) => caches.delete(key)))
  }
}
