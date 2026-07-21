import { ApiError, getCurrentActorId, OfflineWriteBlockedError } from './api'
import { getOfflineStatus, reportNetworkAvailable, reportNetworkUnavailable } from './offline'
import { shouldTrackMutation, withInteractionAction } from './interaction-feedback'
import type {
  HardwareCommand,
  HardwareCommandRequestInput,
  HardwareConfigUpdateInput,
  HardwareDevice,
  HardwareSimulationInput,
  HardwareWorkspace,
} from './shared/hardware-contracts'

async function hardwareRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET'
  return withInteractionAction(async () => {
    if (method !== 'GET' && !getOfflineStatus().online) throw new OfflineWriteBlockedError()
    const headers = new Headers(init?.headers)
    if (init?.body) headers.set('Content-Type', 'application/json')
    const token = window.localStorage.getItem('mbox.auth.token')
    if (token) headers.set('Authorization', `Bearer ${token}`)
    else {
      headers.set('x-mbox-actor-id', getCurrentActorId() || 'emp-chen')
      headers.set('x-mbox-store-id', 'mbox-lujiazui')
    }
    let response: Response
    try {
      response = await fetch(path, { ...init, headers })
    } catch (error) {
      reportNetworkUnavailable()
      throw error
    }
    reportNetworkAvailable()
    const body = await response.json() as T & { message?: string; code?: string }
    if (!response.ok) throw new ApiError(body.message ?? '设备操作失败', response.status, body.code)
    return body
  }, { enabled: shouldTrackMutation(path, method) })
}

export function getHardwareWorkspace() {
  return hardwareRequest<HardwareWorkspace>('/api/hardware')
}

export function updateHardwareConfig(input: Omit<HardwareConfigUpdateInput, 'idempotencyKey'>) {
  return hardwareRequest('/api/hardware/config', {
    method: 'PUT',
    body: JSON.stringify({ ...input, idempotencyKey: crypto.randomUUID() }),
  })
}

export function requestHardwareCommand(input: Omit<HardwareCommandRequestInput, 'requestedAt' | 'idempotencyKey'>) {
  return hardwareRequest<HardwareCommand>('/api/hardware/commands', {
    method: 'POST',
    body: JSON.stringify({
      ...input,
      requestedAt: new Date().toISOString(),
      idempotencyKey: crypto.randomUUID(),
    }),
  })
}

export function simulateHardwareDevice(deviceId: string, input: Pick<HardwareSimulationInput, 'status' | 'message'>) {
  return hardwareRequest<HardwareDevice>(`/api/hardware/devices/${encodeURIComponent(deviceId)}/simulate`, {
    method: 'POST',
    body: JSON.stringify({
      ...input,
      occurredAt: new Date().toISOString(),
      idempotencyKey: crypto.randomUUID(),
    }),
  })
}
