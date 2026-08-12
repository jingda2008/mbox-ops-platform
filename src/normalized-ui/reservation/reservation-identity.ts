import type { ReservationIdentity } from './types'

const ASSERTION_KEY = 'mbox.reservation.anonymous-id.v1'
const DEVICE_KEY = 'mbox.reservation.device-id.v1'

export function getAnonymousReservationIdentity(
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
  createId: () => string = () => crypto.randomUUID(),
): ReservationIdentity {
  return {
    provider: 'anonymous',
    providerAssertion: stablePseudonym(storage, ASSERTION_KEY, 'anon', createId),
    deviceFingerprint: stablePseudonym(storage, DEVICE_KEY, 'web', createId),
  }
}

function stablePseudonym(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  key: string,
  prefix: string,
  createId: () => string,
): string {
  const existing = storage.getItem(key)
  if (existing !== null && new RegExp(`^${prefix}-[0-9a-f-]{36}$`).test(existing)) return existing
  const value = `${prefix}-${createId()}`
  storage.setItem(key, value)
  return value
}
