import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installInteractionFeedback } from './interaction-feedback.ts'

const manifestLink = document.createElement('link')
manifestLink.rel = 'manifest'
manifestLink.href = '/manifest.webmanifest'
document.head.append(manifestLink)
installInteractionFeedback()

// Start the role-specific first workspace in parallel with the shell render.
// Other portals remain lazy so a guest never downloads the operations console
// and an employee never pays for the customer menu bundle.
if (/^\/guest(?:\/|$)/.test(window.location.pathname)) {
  void import('./components/GuestPortal')
} else if (!/^\/(?:member|reserve)(?:\/|$)/.test(window.location.pathname)) {
  void import('./components/OperationsConsole')
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js')
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
