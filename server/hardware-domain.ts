import { createHash, randomUUID } from 'node:crypto'
import type { RuntimeState } from '../src/shared/contracts.js'
import type {
  HardwareCommand,
  HardwareCommandKind,
  HardwareCommandRequestInput,
  HardwareConfigUpdateInput,
  HardwareDevice,
  HardwareDeviceKind,
  HardwareHeartbeatInput,
  HardwareSimulationInput,
  HardwareState,
  HardwareSummary,
  HardwareWorkspace,
} from '../src/shared/hardware-contracts.js'

export class HardwareBusinessError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode: number) {
    super(message)
  }
}

const commandDeviceKind: Record<HardwareCommandKind, HardwareDeviceKind> = {
  camera_capture: 'camera',
  headset_test: 'headset_gateway',
  printer_test: 'printer_bridge',
  scanner_test: 'scanner',
  edge_health_check: 'edge_gateway',
}

function defaultDevices(now: string, enabled: boolean): HardwareDevice[] {
  const device = (
    id: string,
    name: string,
    kind: HardwareDeviceKind,
    areaIds: string[],
    tableIds: string[],
    workstationIds: string[],
    capabilities: HardwareDevice['capabilities'],
  ): HardwareDevice => ({
    id, name, kind, adapter: 'simulator', enabled, status: enabled ? 'online' : 'disabled',
    connectionReference: 'simulator', areaIds, tableIds, workstationIds, capabilities,
    lastHeartbeatAt: enabled ? now : null, lastStatusChangeAt: now,
    diagnostics: { latencyMs: 12, firmwareVersion: 'sim-1.0', message: '模拟设备，仅用于无硬件联调' },
    updatedAt: now, updatedBy: 'system',
  })
  return [
    device('sim-camera-lounge', '大厅模拟摄像头', 'camera', ['lounge'], ['table-l01', 'table-l02'], [], ['capture_image', 'capture_clip']),
    device('sim-headset-gateway', '员工耳机模拟网关', 'headset_gateway', [], [], [], ['audio_notify', 'staff_acknowledge']),
    device('sim-printer-bridge', '出品打印模拟桥', 'printer_bridge', [], [], ['bar-main', 'kitchen-cold', 'kitchen-hot'], ['print_receipt']),
    device('sim-scanner', '货品扫码模拟设备', 'scanner', [], [], ['bar-main', 'kitchen-cold', 'kitchen-hot'], ['scan_code']),
    device('sim-edge-gateway', '门店边缘计算模拟节点', 'edge_gateway', ['lounge', 'interactive'], [], [], ['vision_inference', 'event_relay']),
  ]
}

export function createHardwareState(referenceNow = new Date(), enableSimulators = false): HardwareState {
  const now = referenceNow.toISOString()
  return {
    config: {
      version: 1,
      heartbeatWarningSeconds: 60,
      offlineAfterSeconds: 180,
      evidenceRetentionHours: 24,
      captureBeforeSeconds: 30,
      captureAfterSeconds: 30,
      fallbackChannels: ['in_app'],
      updatedAt: now,
      updatedBy: 'system',
    },
    devices: defaultDevices(now, enableSimulators),
    commands: [],
    idempotencyRecords: [],
  }
}

export function normalizeHardwareState(value: HardwareState | undefined): HardwareState {
  const fallback = createHardwareState(new Date(0), false)
  if (!value) return fallback
  return {
    config: {
      ...fallback.config,
      ...value.config,
      fallbackChannels: value.config?.fallbackChannels?.includes('in_app')
        ? [...new Set(value.config.fallbackChannels)]
        : ['in_app'],
    },
    devices: (value.devices ?? []).map((device) => ({
      ...device,
      status: device.enabled ? device.status ?? 'unconfigured' : 'disabled',
      connectionReference: device.connectionReference ?? '',
      areaIds: [...new Set(device.areaIds ?? [])],
      tableIds: [...new Set(device.tableIds ?? [])],
      workstationIds: [...new Set(device.workstationIds ?? [])],
      capabilities: [...new Set(device.capabilities ?? [])],
      lastHeartbeatAt: device.lastHeartbeatAt ?? null,
      diagnostics: {
        latencyMs: device.diagnostics?.latencyMs ?? null,
        firmwareVersion: device.diagnostics?.firmwareVersion ?? '',
        message: device.diagnostics?.message ?? '',
      },
    })),
    commands: (value.commands ?? []).slice(-500),
    idempotencyRecords: (value.idempotencyRecords ?? []).slice(-1000),
  }
}

export function hardwareFor(state: RuntimeState) {
  state.hardwareState = normalizeHardwareState(state.hardwareState)
  return state.hardwareState
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function replayResult(state: HardwareState, key: string, operation: string, input: unknown) {
  const existing = state.idempotencyRecords.find((record) => record.key === key)
  if (!existing) return null
  if (existing.operation !== operation || existing.fingerprint !== fingerprint(input)) {
    throw new HardwareBusinessError('幂等键已经用于其他设备操作', 'HARDWARE_IDEMPOTENCY_CONFLICT', 409)
  }
  return existing
}

function recordMutation(state: HardwareState, key: string, operation: string, input: unknown, resultId: string) {
  state.idempotencyRecords.push({ key, operation, fingerprint: fingerprint(input), resultId })
  state.idempotencyRecords = state.idempotencyRecords.slice(-1000)
}

function appendAudit(runtime: RuntimeState, actorId: string, action: string, objectType: string, objectId: string, details: Record<string, unknown>, occurredAt: string) {
  runtime.auditEntries.push({ id: `audit_${randomUUID()}`, actorId, action, objectType, objectId, occurredAt, details })
}

function connectionReferenceIsSafe(reference: string) {
  return !(/:\/\/[^/\s]+@/i.test(reference) || /(password|passwd|token|secret|key)\s*[=:]/i.test(reference))
}

function validateDeviceReferences(runtime: RuntimeState, input: HardwareConfigUpdateInput) {
  const areaIds = new Set(runtime.areas.map((item) => item.id))
  const tableIds = new Set(runtime.tables.map((item) => item.id))
  const workstationIds = new Set(runtime.config.workstations.map((item) => item.id))
  for (const device of input.devices) {
    if (!connectionReferenceIsSafe(device.connectionReference)) {
      throw new HardwareBusinessError(`${device.name}的连接引用包含凭据，请改用Secret Manager逻辑名称`, 'HARDWARE_SECRET_INLINE_FORBIDDEN', 400)
    }
    if (device.areaIds.some((id) => !areaIds.has(id))) throw new HardwareBusinessError(`${device.name}引用了不存在的区域`, 'HARDWARE_AREA_INVALID', 400)
    if (device.tableIds.some((id) => !tableIds.has(id))) throw new HardwareBusinessError(`${device.name}引用了不存在的桌台`, 'HARDWARE_TABLE_INVALID', 400)
    if (device.workstationIds.some((id) => !workstationIds.has(id))) throw new HardwareBusinessError(`${device.name}引用了不存在的工作站`, 'HARDWARE_WORKSTATION_INVALID', 400)
  }
}

export function effectiveHardwareDeviceStatus(device: HardwareDevice, config: HardwareState['config'], now = Date.now()) {
  if (!device.enabled) return 'disabled' as const
  if (device.adapter === 'simulator') {
    return ['online', 'degraded', 'offline'].includes(device.status) ? device.status : 'unconfigured' as const
  }
  if (!device.connectionReference) return 'unconfigured' as const
  if (!device.lastHeartbeatAt) return 'unconfigured' as const
  const ageSeconds = Math.max(0, (now - Date.parse(device.lastHeartbeatAt)) / 1000)
  if (ageSeconds >= config.offlineAfterSeconds) return 'offline' as const
  if (ageSeconds >= config.heartbeatWarningSeconds || device.status === 'degraded') return 'degraded' as const
  return device.status === 'offline' ? 'offline' as const : 'online' as const
}

function effectiveState(state: HardwareState, now = Date.now()): HardwareState {
  return {
    ...structuredClone(state),
    devices: state.devices.map((device) => ({ ...structuredClone(device), status: effectiveHardwareDeviceStatus(device, state.config, now) })),
    idempotencyRecords: [],
  }
}

export function summarizeHardware(state: HardwareState, now = Date.now()): HardwareSummary {
  const devices = state.devices.map((device) => ({ ...device, status: effectiveHardwareDeviceStatus(device, state.config, now) }))
  return {
    total: devices.length,
    enabled: devices.filter((device) => device.enabled).length,
    online: devices.filter((device) => device.status === 'online').length,
    degraded: devices.filter((device) => device.status === 'degraded').length,
    offline: devices.filter((device) => device.status === 'offline').length,
    unconfigured: devices.filter((device) => device.status === 'unconfigured').length,
    simulated: devices.filter((device) => device.enabled && device.adapter === 'simulator').length,
    pendingCommands: state.commands.filter((command) => command.status === 'queued').length,
    failedCommands: state.commands.filter((command) => ['failed', 'unconfigured'].includes(command.status)).length,
  }
}

export function buildHardwareWorkspace(state: RuntimeState, canManage: boolean, canOperate: boolean, now = Date.now()): HardwareWorkspace {
  const hardware = hardwareFor(state)
  return { state: effectiveState(hardware, now), summary: summarizeHardware(hardware, now), generatedAt: new Date(now).toISOString(), canManage, canOperate }
}

export function updateHardwareConfig(runtime: RuntimeState, actorId: string, input: HardwareConfigUpdateInput, now = new Date()) {
  const hardware = hardwareFor(runtime)
  const replay = replayResult(hardware, input.idempotencyKey, 'hardware.config.update', input)
  if (replay) return hardware.config
  if (!input.fallbackChannels.includes('in_app')) {
    throw new HardwareBusinessError('设备失败必须保留系统内降级通知', 'HARDWARE_FALLBACK_REQUIRED', 400)
  }
  if (input.heartbeatWarningSeconds >= input.offlineAfterSeconds) {
    throw new HardwareBusinessError('离线时间必须大于预警时间', 'HARDWARE_HEARTBEAT_WINDOW_INVALID', 400)
  }
  validateDeviceReferences(runtime, input)
  const previous = new Map(hardware.devices.map((device) => [device.id, device]))
  const nowIso = now.toISOString()
  hardware.devices = input.devices.map((device) => {
    const existing = previous.get(device.id)
    const status = !device.enabled ? 'disabled' : device.adapter !== 'simulator' && !device.connectionReference ? 'unconfigured' : existing?.status ?? 'unconfigured'
    return {
      ...structuredClone(device), status,
      lastHeartbeatAt: existing?.lastHeartbeatAt ?? (device.adapter === 'simulator' && device.enabled ? nowIso : null),
      lastStatusChangeAt: existing?.status === status ? existing.lastStatusChangeAt : nowIso,
      diagnostics: existing?.diagnostics ?? { latencyMs: null, firmwareVersion: '', message: '' },
      updatedAt: nowIso, updatedBy: actorId,
    }
  })
  hardware.config = {
    version: hardware.config.version + 1,
    heartbeatWarningSeconds: input.heartbeatWarningSeconds,
    offlineAfterSeconds: input.offlineAfterSeconds,
    evidenceRetentionHours: input.evidenceRetentionHours,
    captureBeforeSeconds: input.captureBeforeSeconds,
    captureAfterSeconds: input.captureAfterSeconds,
    fallbackChannels: [...new Set(input.fallbackChannels)],
    updatedAt: nowIso,
    updatedBy: actorId,
  }
  recordMutation(hardware, input.idempotencyKey, 'hardware.config.update', input, `hardware-config-v${hardware.config.version}`)
  appendAudit(runtime, actorId, 'hardware.config.updated.v1', 'hardware_config', `v${hardware.config.version}`, {
    reason: input.reason, deviceCount: hardware.devices.length,
  }, nowIso)
  runtime.revision += 1
  return hardware.config
}

export function recordHardwareHeartbeat(runtime: RuntimeState, deviceId: string, actorId: string, input: HardwareHeartbeatInput) {
  const hardware = hardwareFor(runtime)
  const replay = replayResult(hardware, input.idempotencyKey, 'hardware.heartbeat', { deviceId, ...input })
  const device = hardware.devices.find((candidate) => candidate.id === deviceId)
  if (!device) throw new HardwareBusinessError('设备不存在', 'HARDWARE_DEVICE_NOT_FOUND', 404)
  if (replay) return device
  if (Date.parse(input.observedAt) > Date.now() + 5 * 60_000) throw new HardwareBusinessError('设备心跳时间不能来自未来', 'HARDWARE_HEARTBEAT_TIME_INVALID', 400)
  const previousStatus = device.status
  device.status = device.enabled ? input.status : 'disabled'
  device.lastHeartbeatAt = input.observedAt
  if (previousStatus !== device.status) device.lastStatusChangeAt = input.observedAt
  device.diagnostics = { latencyMs: input.latencyMs, firmwareVersion: input.firmwareVersion, message: input.message }
  device.updatedAt = input.observedAt
  device.updatedBy = actorId
  recordMutation(hardware, input.idempotencyKey, 'hardware.heartbeat', { deviceId, ...input }, device.id)
  appendAudit(runtime, actorId, 'hardware.device.heartbeat.v1', 'hardware_device', device.id, {
    status: device.status, previousStatus, latencyMs: input.latencyMs,
  }, input.observedAt)
  runtime.revision += 1
  return device
}

function deviceForCommand(runtime: RuntimeState, hardware: HardwareState, input: HardwareCommandRequestInput) {
  const expectedKind = commandDeviceKind[input.kind]
  if (input.deviceId) {
    const selected = hardware.devices.find((device) => device.id === input.deviceId)
    if (!selected) throw new HardwareBusinessError('指定设备不存在', 'HARDWARE_DEVICE_NOT_FOUND', 404)
    if (selected.kind !== expectedKind) throw new HardwareBusinessError('指定设备不支持这个操作', 'HARDWARE_COMMAND_DEVICE_MISMATCH', 409)
    return selected
  }
  const table = input.tableId ? runtime.tables.find((item) => item.id === input.tableId) : null
  return hardware.devices
    .filter((device) => device.enabled && device.kind === expectedKind)
    .toSorted((left, right) => {
      const score = (device: HardwareDevice) => Number(Boolean(input.tableId && device.tableIds.includes(input.tableId))) * 4
        + Number(Boolean((input.areaId ?? table?.areaId) && device.areaIds.includes(input.areaId ?? table!.areaId))) * 2
        + Number(effectiveHardwareDeviceStatus(device, hardware.config) === 'online')
      return score(right) - score(left)
    })[0] ?? null
}

export function requestHardwareCommand(runtime: RuntimeState, actorId: string, input: HardwareCommandRequestInput, now = new Date()) {
  const hardware = hardwareFor(runtime)
  const replay = replayResult(hardware, input.idempotencyKey, 'hardware.command.request', input)
  if (replay) {
    const existing = hardware.commands.find((command) => command.id === replay.resultId)
    if (!existing) throw new HardwareBusinessError('设备命令重放记录不完整', 'HARDWARE_REPLAY_MISSING', 409)
    return existing
  }
  if (input.tableId && !runtime.tables.some((table) => table.id === input.tableId)) throw new HardwareBusinessError('命令引用的桌台不存在', 'HARDWARE_TABLE_INVALID', 400)
  if (input.areaId && !runtime.areas.some((area) => area.id === input.areaId)) throw new HardwareBusinessError('命令引用的区域不存在', 'HARDWARE_AREA_INVALID', 400)
  const selected = deviceForCommand(runtime, hardware, input)
  const nowIso = now.toISOString()
  const simulation = selected?.adapter === 'simulator'
  const effectiveStatus = selected ? effectiveHardwareDeviceStatus(selected, hardware.config, now.getTime()) : 'unconfigured'
  const isReady = selected && effectiveStatus === 'online'
  const commandId = `hardware_command_${randomUUID()}`
  const isCapture = input.kind === 'camera_capture'
  const command: HardwareCommand = {
    id: commandId,
    kind: input.kind,
    deviceId: selected?.id ?? null,
    source: input.source,
    sourceId: input.sourceId ?? null,
    tableId: input.tableId ?? null,
    areaId: input.areaId ?? (input.tableId ? runtime.tables.find((table) => table.id === input.tableId)?.areaId ?? null : null),
    content: input.content,
    captureBeforeSeconds: isCapture ? input.captureBeforeSeconds ?? hardware.config.captureBeforeSeconds : null,
    captureAfterSeconds: isCapture ? input.captureAfterSeconds ?? hardware.config.captureAfterSeconds : null,
    status: simulation && isReady ? 'completed' : isReady ? 'queued' : 'unconfigured',
    simulation,
    providerReference: simulation && isReady ? `simulator:${selected.id}:${commandId}` : null,
    evidenceReference: simulation && isReady && isCapture ? `simulated-evidence://${selected.id}/${commandId}` : null,
    verified: simulation && isCapture ? false : null,
    resultMessage: simulation && isReady
      ? isCapture ? '模拟抽帧已生成，仅用于流程联调，不能作为真实视觉验证。' : '模拟设备已返回联调回执，未触达真实硬件。'
      : isReady ? '命令已进入设备适配队列，等待真实硬件回执。' : '没有可用设备，核心任务已保留并降级到系统内通知。',
    requestedBy: actorId,
    requestedAt: input.requestedAt,
    completedAt: simulation && isReady ? nowIso : null,
  }
  hardware.commands.push(command)
  hardware.commands = hardware.commands.slice(-500)
  recordMutation(hardware, input.idempotencyKey, 'hardware.command.request', input, command.id)
  appendAudit(runtime, actorId, 'hardware.command.requested.v1', 'hardware_command', command.id, {
    kind: command.kind, deviceId: command.deviceId, status: command.status, simulation: command.simulation,
    fallbackChannels: command.status === 'unconfigured' ? hardware.config.fallbackChannels : [],
  }, nowIso)
  runtime.revision += 1
  return command
}

export function simulateHardwareStatus(runtime: RuntimeState, deviceId: string, actorId: string, input: HardwareSimulationInput) {
  const hardware = hardwareFor(runtime)
  const device = hardware.devices.find((candidate) => candidate.id === deviceId)
  if (!device) throw new HardwareBusinessError('设备不存在', 'HARDWARE_DEVICE_NOT_FOUND', 404)
  if (device.adapter !== 'simulator') throw new HardwareBusinessError('只有模拟设备可以人工切换状态', 'HARDWARE_NOT_SIMULATOR', 409)
  return recordHardwareHeartbeat(runtime, deviceId, actorId, {
    status: input.status,
    observedAt: input.occurredAt,
    latencyMs: input.status === 'online' ? 12 : input.status === 'degraded' ? 850 : null,
    firmwareVersion: 'sim-1.0',
    message: input.message,
    idempotencyKey: input.idempotencyKey,
  })
}
