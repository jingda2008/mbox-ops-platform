import { describe, expect, it } from 'vitest'
import type { HardwareConfigUpdateInput } from '../src/shared/hardware-contracts.js'
import {
  buildHardwareWorkspace,
  createHardwareState,
  effectiveHardwareDeviceStatus,
  requestHardwareCommand,
  simulateHardwareStatus,
  updateHardwareConfig,
} from './hardware-domain.js'
import { createSeedState } from './seed.js'

function configInput(state: ReturnType<typeof createSeedState>, patch: Partial<HardwareConfigUpdateInput> = {}): HardwareConfigUpdateInput {
  const hardware = state.hardwareState!
  return {
    heartbeatWarningSeconds: hardware.config.heartbeatWarningSeconds,
    offlineAfterSeconds: hardware.config.offlineAfterSeconds,
    evidenceRetentionHours: hardware.config.evidenceRetentionHours,
    captureBeforeSeconds: hardware.config.captureBeforeSeconds,
    captureAfterSeconds: hardware.config.captureAfterSeconds,
    fallbackChannels: hardware.config.fallbackChannels,
    devices: hardware.devices.map((device) => ({
      id: device.id,
      name: device.name,
      kind: device.kind,
      adapter: device.adapter,
      enabled: device.enabled,
      connectionReference: device.connectionReference,
      areaIds: device.areaIds,
      tableIds: device.tableIds,
      workstationIds: device.workstationIds,
      capabilities: device.capabilities,
    })),
    reason: '设备域自动化测试更新',
    idempotencyKey: crypto.randomUUID(),
    ...patch,
  }
}

describe('hardware domain', () => {
  it('creates disabled hardware defaults unless simulation is explicitly enabled', () => {
    const disabled = createHardwareState(new Date('2026-07-20T12:00:00.000Z'))
    const enabled = createHardwareState(new Date('2026-07-20T12:00:00.000Z'), true)

    expect(disabled.devices.every((device) => !device.enabled && device.status === 'disabled')).toBe(true)
    expect(buildHardwareWorkspace({ ...createSeedState(), hardwareState: enabled }, true, true, Date.parse('2026-07-20T12:00:00.000Z')).summary).toMatchObject({
      enabled: 5, online: 5, simulated: 5,
    })
  })

  it('records simulated camera evidence without marking it as verified real evidence', () => {
    const now = new Date('2026-07-20T12:00:00.000Z')
    const state = createSeedState(now)
    const input = {
      kind: 'camera_capture' as const,
      deviceId: 'sim-camera-lounge',
      source: 'manual' as const,
      tableId: 'table-l01',
      content: '检查L01关键时点前后30秒',
      captureBeforeSeconds: 30,
      captureAfterSeconds: 30,
      requestedAt: now.toISOString(),
      idempotencyKey: crypto.randomUUID(),
    }

    const first = requestHardwareCommand(state, 'emp-admin', input, now)
    const replay = requestHardwareCommand(state, 'emp-admin', input, now)

    expect(first).toMatchObject({ status: 'completed', simulation: true, verified: false })
    expect(first.evidenceReference).toMatch(/^simulated-evidence:\/\//)
    expect(first.resultMessage).toContain('不能作为真实视觉验证')
    expect(replay.id).toBe(first.id)
    expect(state.hardwareState!.commands).toHaveLength(1)
    expect(state.auditEntries).toContainEqual(expect.objectContaining({ action: 'hardware.command.requested.v1' }))
  })

  it('preserves the core request and returns an explicit fallback when no device is ready', () => {
    const now = new Date('2026-07-20T12:00:00.000Z')
    const state = createSeedState(now)
    state.hardwareState!.devices.forEach((device) => { device.enabled = false })

    const command = requestHardwareCommand(state, 'emp-chen', {
      kind: 'headset_test', source: 'manual', content: '提醒服务员关注L01',
      requestedAt: now.toISOString(), idempotencyKey: crypto.randomUUID(),
    }, now)

    expect(command).toMatchObject({ status: 'unconfigured', deviceId: null, simulation: false })
    expect(command.resultMessage).toContain('降级到系统内通知')
  })

  it('changes simulated status and derives degraded/offline state from heartbeat age', () => {
    const now = new Date()
    const state = createSeedState(now)
    const device = simulateHardwareStatus(state, 'sim-camera-lounge', 'emp-admin', {
      status: 'degraded', message: '模拟高延迟', occurredAt: now.toISOString(), idempotencyKey: crypto.randomUUID(),
    })
    expect(device.status).toBe('degraded')
    expect(effectiveHardwareDeviceStatus(device, state.hardwareState!.config, now.getTime())).toBe('degraded')
    expect(effectiveHardwareDeviceStatus(device, state.hardwareState!.config, now.getTime() + 181_000)).toBe('degraded')
    device.adapter = 'rtsp'
    device.connectionReference = 'secret:camera-test'
    device.status = 'online'
    expect(effectiveHardwareDeviceStatus(device, state.hardwareState!.config, now.getTime() + 181_000)).toBe('offline')
  })

  it('rejects credentials in runtime config and requires the in-app fallback', () => {
    const state = createSeedState(new Date('2026-07-20T12:00:00.000Z'))
    const unsafe = configInput(state)
    unsafe.devices[0] = { ...unsafe.devices[0]!, adapter: 'rtsp', connectionReference: 'rtsp://admin:secret@10.0.0.8/live' }
    expect(() => updateHardwareConfig(state, 'emp-admin', unsafe)).toThrow(/Secret Manager/)

    const withoutFallback = configInput(state, { fallbackChannels: ['wecom'] })
    expect(() => updateHardwareConfig(state, 'emp-admin', withoutFallback)).toThrow(/系统内降级通知/)
  })
})
