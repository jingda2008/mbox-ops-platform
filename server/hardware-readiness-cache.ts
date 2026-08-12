import type { RuntimeState } from '../src/shared/contracts.js'
import { effectiveHardwareDeviceStatus } from './hardware-domain.js'

export interface HardwareReadinessSnapshot {
  hardwareMode: 'real_ready' | 'real_degraded' | 'simulation_only' | 'unconfigured'
  realHardwareDevices: number
  realHardwareDevicesOnline: number
  simulatedDevicesEnabled: number
}

export function hardwareReadinessSnapshot(state: RuntimeState): HardwareReadinessSnapshot {
  const enabledDevices = state.hardwareState?.devices.filter((device) => device.enabled) ?? []
  const realDevices = enabledDevices.filter((device) => device.adapter !== 'simulator')
  const realHardwareDevicesOnline = state.hardwareState
    ? realDevices.filter((device) => effectiveHardwareDeviceStatus(device, state.hardwareState!.config) === 'online').length
    : 0
  const simulatedDevicesEnabled = enabledDevices.filter((device) => device.adapter === 'simulator').length
  return {
    hardwareMode: realDevices.length > 0
      ? realHardwareDevicesOnline === realDevices.length ? 'real_ready' : 'real_degraded'
      : simulatedDevicesEnabled > 0 ? 'simulation_only' : 'unconfigured',
    realHardwareDevices: realDevices.length,
    realHardwareDevicesOnline,
    simulatedDevicesEnabled,
  }
}

export function createHardwareReadinessResolver(
  readState: () => Promise<RuntimeState>,
  initialState: RuntimeState,
  ttlMs = 60_000,
) {
  let cached = { expiresAt: 0, value: hardwareReadinessSnapshot(initialState) }
  let pending: Promise<HardwareReadinessSnapshot> | null = null
  return async (now = Date.now()) => {
    if (cached.expiresAt > now) return cached.value
    if (!pending) {
      pending = readState()
        .then(hardwareReadinessSnapshot)
        .then((value) => {
          cached = { expiresAt: now + ttlMs, value }
          return value
        })
        .finally(() => { pending = null })
    }
    return pending
  }
}
