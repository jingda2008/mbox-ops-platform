import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { serverClockOffset } from './use-second-clock'

function componentBody(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('live time isolation', () => {
  it('keeps the server clock aligned with the server timestamp', () => {
    const clientNow = Date.parse('2026-07-20T10:00:00.000+08:00')
    const serverNow = '2026-07-20T10:00:03.250+08:00'
    const serverEpoch = Date.parse(serverNow)

    expect(serverClockOffset(serverNow, clientNow)).toBe(3_250)
    expect(clientNow - 12 * 60 * 60_000 + serverClockOffset(serverNow, clientNow - 12 * 60 * 60_000)).toBe(serverEpoch)
    expect(clientNow + 12 * 60 * 60_000 + serverClockOffset(serverNow, clientNow + 12 * 60 * 60_000)).toBe(serverEpoch)
    expect(serverClockOffset('invalid', clientNow)).toBe(0)
  })

  it('does not subscribe the complete guest portal or operations console to a one-second interval', () => {
    const guestSource = readFileSync(new URL('./GuestPortal.tsx', import.meta.url), 'utf8')
    const operationsSource = readFileSync(new URL('./OperationsConsole.tsx', import.meta.url), 'utf8')
    const guestPortal = componentBody(guestSource, 'export function GuestPortal()', '\nasync function invokeWechatJsapi')
    const operationsConsole = componentBody(operationsSource, 'export function OperationsConsole(', '\nfunction Metric(')

    expect(guestPortal).not.toContain('setStageClock')
    expect(guestPortal).not.toContain('window.setInterval')
    expect(operationsConsole).not.toContain('setChinaClock')
    expect(operationsConsole).not.toContain('window.setInterval')
    expect(guestSource).toContain('const GuestStageBand = memo(')
    expect(guestSource).toContain('const GuestSongProgress = memo(')
    expect(operationsSource).toContain('<BeijingClock serverNow={data.serverNow} />')
  })
})
