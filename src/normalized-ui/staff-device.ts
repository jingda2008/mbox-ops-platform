const DEVICE_KEY_STORAGE = 'mbox.normalized.device-key.v1'
const DEVICE_LEASE_STORAGE = 'mbox.normalized.device-lease-until.v1'

export function getOrCreateDeviceKey(
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
  createId: () => string = () => crypto.randomUUID(),
): string {
  const existing = storage.getItem(DEVICE_KEY_STORAGE)
  if (existing && existing.length >= 8) return existing
  const value = `web-${createId()}`
  storage.setItem(DEVICE_KEY_STORAGE, value)
  return value
}

export function saveDeviceLease(expiresAt: string, storage: Pick<Storage, 'setItem'> = localStorage) {
  storage.setItem(DEVICE_LEASE_STORAGE, expiresAt)
}

export function clearDeviceLease(storage: Pick<Storage, 'removeItem'> = localStorage) {
  storage.removeItem(DEVICE_LEASE_STORAGE)
}

export function hasUsableDeviceLease(
  storage: Pick<Storage, 'getItem'> = localStorage,
  now = Date.now(),
) {
  const expiresAt = storage.getItem(DEVICE_LEASE_STORAGE)
  return expiresAt !== null && Date.parse(expiresAt) > now + 30_000
}
