import { useEffect, useState } from 'react'

export function serverClockOffset(serverNow: string, clientNow = Date.now()) {
  const parsed = Date.parse(serverNow)
  return Number.isFinite(parsed) ? parsed - clientNow : 0
}

export function useSecondClock(offsetMs = 0) {
  const [clock, setClock] = useState(() => Date.now() + offsetMs)

  useEffect(() => {
    const updateClock = () => setClock(Date.now() + offsetMs)
    updateClock()
    const timer = window.setInterval(updateClock, 1_000)
    return () => window.clearInterval(timer)
  }, [offsetMs])

  return clock
}
