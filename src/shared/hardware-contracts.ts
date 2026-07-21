import { z } from 'zod'

export const hardwareDeviceKinds = ['camera', 'headset_gateway', 'printer_bridge', 'scanner', 'edge_gateway'] as const
export type HardwareDeviceKind = typeof hardwareDeviceKinds[number]

export const hardwareAdapterKinds = ['simulator', 'rtsp', 'nvr', 'webhook', 'network', 'android_bridge', 'usb', 'vendor_sdk'] as const
export type HardwareAdapterKind = typeof hardwareAdapterKinds[number]

export const hardwareDeviceStatuses = ['disabled', 'online', 'degraded', 'offline', 'unconfigured'] as const
export type HardwareDeviceStatus = typeof hardwareDeviceStatuses[number]

export const hardwareCapabilities = [
  'capture_image', 'capture_clip', 'audio_notify', 'staff_acknowledge', 'print_receipt',
  'scan_code', 'vision_inference', 'event_relay',
] as const
export type HardwareCapability = typeof hardwareCapabilities[number]

export const hardwareCommandKinds = ['camera_capture', 'headset_test', 'printer_test', 'scanner_test', 'edge_health_check'] as const
export type HardwareCommandKind = typeof hardwareCommandKinds[number]
export type HardwareCommandStatus = 'queued' | 'completed' | 'failed' | 'unconfigured'

export interface HardwareDeviceDiagnostics {
  latencyMs: number | null
  firmwareVersion: string
  message: string
}

export interface HardwareDevice {
  id: string
  name: string
  kind: HardwareDeviceKind
  adapter: HardwareAdapterKind
  enabled: boolean
  status: HardwareDeviceStatus
  /** Logical secret or channel name only. Credentials are never stored in runtime state. */
  connectionReference: string
  areaIds: string[]
  tableIds: string[]
  workstationIds: string[]
  capabilities: HardwareCapability[]
  lastHeartbeatAt: string | null
  lastStatusChangeAt: string
  diagnostics: HardwareDeviceDiagnostics
  updatedAt: string
  updatedBy: string
}

export interface HardwareConfig {
  version: number
  heartbeatWarningSeconds: number
  offlineAfterSeconds: number
  evidenceRetentionHours: number
  captureBeforeSeconds: number
  captureAfterSeconds: number
  fallbackChannels: Array<'in_app' | 'wecom'>
  updatedAt: string
  updatedBy: string
}

export interface HardwareCommand {
  id: string
  kind: HardwareCommandKind
  deviceId: string | null
  source: 'manual' | 'sop' | 'duty_manager'
  sourceId: string | null
  tableId: string | null
  areaId: string | null
  content: string
  captureBeforeSeconds: number | null
  captureAfterSeconds: number | null
  status: HardwareCommandStatus
  simulation: boolean
  providerReference: string | null
  evidenceReference: string | null
  verified: boolean | null
  resultMessage: string
  requestedBy: string
  requestedAt: string
  completedAt: string | null
}

export interface HardwareIdempotencyRecord {
  key: string
  operation: string
  fingerprint: string
  resultId: string
}

export interface HardwareState {
  config: HardwareConfig
  devices: HardwareDevice[]
  commands: HardwareCommand[]
  idempotencyRecords: HardwareIdempotencyRecord[]
}

export interface HardwareSummary {
  total: number
  enabled: number
  online: number
  degraded: number
  offline: number
  unconfigured: number
  simulated: number
  pendingCommands: number
  failedCommands: number
}

export interface HardwareWorkspace {
  state: HardwareState
  summary: HardwareSummary
  generatedAt: string
  canManage: boolean
  canOperate: boolean
}

const identifier = z.string().trim().min(1).max(128)
const occurredAt = z.string().datetime({ offset: true })
const idempotencyKey = z.string().uuid()

export const hardwareDeviceSchema = z.object({
  id: identifier,
  name: z.string().trim().min(1).max(80),
  kind: z.enum(hardwareDeviceKinds),
  adapter: z.enum(hardwareAdapterKinds),
  enabled: z.boolean(),
  connectionReference: z.string().trim().max(160),
  areaIds: z.array(identifier).max(20),
  tableIds: z.array(identifier).max(100),
  workstationIds: z.array(identifier).max(30),
  capabilities: z.array(z.enum(hardwareCapabilities)).max(20),
}).strict()

export const hardwareConfigUpdateSchema = z.object({
  heartbeatWarningSeconds: z.number().int().min(10).max(3600),
  offlineAfterSeconds: z.number().int().min(30).max(7200),
  evidenceRetentionHours: z.number().int().min(1).max(168),
  captureBeforeSeconds: z.number().int().min(5).max(60),
  captureAfterSeconds: z.number().int().min(5).max(60),
  fallbackChannels: z.array(z.enum(['in_app', 'wecom'])).min(1).max(2),
  devices: z.array(hardwareDeviceSchema).max(100),
  reason: z.string().trim().min(2).max(300),
  idempotencyKey,
}).strict().superRefine((value, context) => {
  if (value.heartbeatWarningSeconds >= value.offlineAfterSeconds) {
    context.addIssue({ code: 'custom', path: ['offlineAfterSeconds'], message: '离线时间必须大于预警时间' })
  }
  if (!value.fallbackChannels.includes('in_app')) {
    context.addIssue({ code: 'custom', path: ['fallbackChannels'], message: '设备失败必须保留系统内降级通知' })
  }
  if (new Set(value.devices.map((device) => device.id)).size !== value.devices.length) {
    context.addIssue({ code: 'custom', path: ['devices'], message: '设备编号不能重复' })
  }
  if (new Set(value.fallbackChannels).size !== value.fallbackChannels.length) {
    context.addIssue({ code: 'custom', path: ['fallbackChannels'], message: '降级通道不能重复' })
  }
})

export type HardwareConfigUpdateInput = z.infer<typeof hardwareConfigUpdateSchema>

export const hardwareHeartbeatSchema = z.object({
  status: z.enum(['online', 'degraded', 'offline']),
  observedAt: occurredAt,
  latencyMs: z.number().int().min(0).max(120_000).nullable().default(null),
  firmwareVersion: z.string().trim().max(80).default(''),
  message: z.string().trim().max(240).default(''),
  idempotencyKey,
}).strict()

export type HardwareHeartbeatInput = z.infer<typeof hardwareHeartbeatSchema>

export const hardwareCommandRequestSchema = z.object({
  kind: z.enum(hardwareCommandKinds),
  deviceId: identifier.optional(),
  source: z.enum(['manual', 'sop', 'duty_manager']).default('manual'),
  sourceId: identifier.optional(),
  tableId: identifier.optional(),
  areaId: identifier.optional(),
  content: z.string().trim().min(1).max(500),
  captureBeforeSeconds: z.number().int().min(5).max(60).optional(),
  captureAfterSeconds: z.number().int().min(5).max(60).optional(),
  requestedAt: occurredAt,
  idempotencyKey,
}).strict()

export type HardwareCommandRequestInput = z.infer<typeof hardwareCommandRequestSchema>

export const hardwareSimulationSchema = z.object({
  status: z.enum(['online', 'degraded', 'offline']),
  message: z.string().trim().min(1).max(240),
  occurredAt,
  idempotencyKey,
}).strict()

export type HardwareSimulationInput = z.infer<typeof hardwareSimulationSchema>
