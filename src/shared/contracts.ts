import { z } from 'zod'
import type { OrderDomainState } from './order-contracts.js'
import type { PaymentDomainState } from './payment-contracts.js'
import type { InventoryDomainState } from './inventory-contracts.js'
import type {
  BenefitCampaign,
  BenefitGrantPolicy,
  BenefitGrantRequest,
  BenefitTemplate,
  CustomerNotification,
  MemberBenefit,
  MemberProfile,
} from './benefit-contracts.js'
import type { BenefitRedemption } from './benefit-redemption-contracts.js'
import type { ConfigVersionRecord } from './config-versioning-contracts.js'
import type { SongState } from './song-contracts.js'
import type { ReservationState } from './reservation-contracts.js'

export const taskStatuses = [
  'pending',
  'accepted',
  'arrived',
  'completed',
  'confirmed',
  'reopened',
  'escalated',
  'cancelled',
] as const

export type TaskStatus = (typeof taskStatuses)[number]
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'
export type TableStatus = 'available' | 'occupied' | 'reserved' | 'paused'

export interface StoreSummary {
  id: string
  name: string
  businessDate: string
  timezone: string
}

export interface Area {
  id: string
  name: string
  shortName: string
  color: string
  sortOrder: number
}

export interface Table {
  id: string
  code: string
  displayName: string
  areaId: string
  capacity: number
  status: TableStatus
  primaryEmployeeId: string
  backupEmployeeIds: string[]
  guestCount: number
  openedAt: string | null
}

export interface Employee {
  id: string
  displayName: string
  initials: string
  status: 'active' | 'inactive'
  roleId: string
  online: boolean
  paused: boolean
  areaIds: string[]
  skillIds?: string[]
}

export interface ShiftAssignment {
  id: string
  employeeId: string
  businessDate: string
  startAt: string
  endAt: string
  roleId: string
  areaIds: string[]
  stationIds?: string[]
  isPrimary: boolean
  status: 'scheduled' | 'active' | 'completed' | 'cancelled'
}

export interface MenuProduct {
  id: string
  sku: string
  name: string
  specification: string
  listPriceAmount: number
  costAmount: number
  stationId: string
  enabled: boolean
  configVersion: number
}

export const staffPermissionIds = [
  'dashboard.view',
  'finance.view',
  'audit.view',
  'config.manage',
  'identity.manage',
  'master_data.manage',
  'shift.manage',
  'table.manage',
  'table.close',
  'business_day.close',
  'reservation.view',
  'reservation.manage',
  'reservation.config.manage',
  'service.execute',
  'complaint.handle',
  'order.create',
  'order.view',
  'kds.prepare',
  'kds.deliver',
  'payment.collect',
  'payment.pos_report',
  'payment.refund.request',
  'payment.refund.approve',
  'commerce.authorization.request',
  'commerce.authorization.approve',
  'inventory.view',
  'inventory.manage',
  'inventory.approve',
  'benefit.view',
  'benefit.grant',
  'benefit.approve',
  'benefit.manage',
  'song.view',
  'song.manage',
  'store_import.apply',
] as const

export type StaffPermissionId = (typeof staffPermissionIds)[number]
export type RoleDataScope = 'own' | 'assigned_areas' | 'store' | 'all_stores'

export interface RoleApprovalLimits {
  giftAmount: number
  discountAmount: number
  refundRequestAmount: number
  refundApproveAmount: number
  inventoryAdjustmentAmount: number
}

export interface RoleConfig {
  id: string
  name: string
  maxConcurrentTasks: number
  canReceiveTasks: boolean
  permissionIds?: StaffPermissionId[]
  dataScope?: RoleDataScope
  approvalLimits?: RoleApprovalLimits
}

export interface SkillConfig {
  id: string
  name: string
  enabled: boolean
}

export type WorkstationKind = 'production' | 'delivery' | 'hybrid'

export interface WorkstationConfig {
  id: string
  name: string
  kind: WorkstationKind
  enabled: boolean
  productionRoleIds: string[]
  deliveryRoleIds: string[]
  requiredSkillIds: string[]
  productionSlaSeconds: number
  pickupSlaSeconds: number
  deliveryServiceTypeId: string | null
  fallbackStationId: string | null
}

export interface SlaConfig {
  warningSeconds: number
  escalateSeconds: number
  managerSeconds: number
}

export interface ServiceTypeConfig {
  id: string
  code: string
  name: string
  icon: 'water' | 'ice' | 'order' | 'bill' | 'complaint' | 'birthday'
  enabled: boolean
  guestVisible?: boolean
  priority: TaskPriority
  dispatchRoleIds: string[]
  sla: SlaConfig
  customerReply: string
  actionScript: string[]
}

export interface ProactiveOrderCareConfig {
  enabled: boolean
  firstReminderSeconds: number
  repeatReminderSeconds: number
  maxReminders: number
  serviceTypeId: string
}

export interface StoreConfig {
  version: number
  status: 'published' | 'draft'
  publishedAt: string | null
  serviceTypes: ServiceTypeConfig[]
  roles: RoleConfig[]
  skills: SkillConfig[]
  workstations: WorkstationConfig[]
  proactiveOrderCare: ProactiveOrderCareConfig
}

export interface AwaitingOrderIntent {
  id: string
  tableId: string
  status: 'active' | 'completed' | 'cancelled'
  startedBy: string
  startedAt: string
  nextReminderAt: string | null
  reminderCount: number
  lastReminderAt: string | null
  stoppedAt: string | null
  stoppedBy: string | null
  stopReason: string | null
  configVersion: number
}

export interface ServiceTask {
  id: string
  tableId: string
  serviceTypeId: string
  source: 'guest' | 'employee' | 'system'
  note: string
  status: TaskStatus
  priority: TaskPriority
  ownerId: string | null
  notifiedEmployeeIds: string[]
  createdAt: string
  updatedAt: string
  acceptedAt: string | null
  arrivedAt: string | null
  completedAt: string | null
  warningAt: string
  escalateAt: string
  managerAt: string
  escalationLevel: number
  configVersion: number
  customerReply: string
  actionScript: string[]
  resolution: string | null
  triggerId: string | null
}

export interface TaskEvent {
  id: string
  taskId: string
  type: string
  actorId: string
  occurredAt: string
  payload: Record<string, unknown>
}

export interface AuditEntry {
  id: string
  actorId: string
  action: string
  objectType: string
  objectId: string
  occurredAt: string
  details: Record<string, unknown>
}

export interface RuntimeState {
  revision: number
  store: StoreSummary
  areas: Area[]
  tables: Table[]
  employees: Employee[]
  shiftAssignments: ShiftAssignment[]
  products: MenuProduct[]
  orderDomain: OrderDomainState
  paymentDomain: PaymentDomainState
  inventoryDomain?: InventoryDomainState
  reservationState?: ReservationState
  awaitingOrderIntents: AwaitingOrderIntent[]
  members: MemberProfile[]
  benefitTemplates: BenefitTemplate[]
  benefitGrantPolicies: BenefitGrantPolicy[]
  benefitGrantRequests: BenefitGrantRequest[]
  memberBenefits: MemberBenefit[]
  benefitRedemptions: BenefitRedemption[]
  benefitCampaigns: BenefitCampaign[]
  customerNotifications: CustomerNotification[]
  songState: SongState
  config: StoreConfig
  configVersions: ConfigVersionRecord[]
  draftConfig: StoreConfig | null
  tasks: ServiceTask[]
  taskEvents: TaskEvent[]
  auditEntries: AuditEntry[]
}

export interface OperationsMetrics {
  occupiedTables: number
  openTasks: number
  atRiskTasks: number
  escalatedTasks: number
  complaints: number
}

export interface BootstrapResponse extends RuntimeState {
  serverNow: string
  metrics: OperationsMetrics
}

export const createTaskSchema = z.object({
  tableCode: z.string().trim().min(1).max(32),
  serviceTypeId: z.string().trim().min(1).max(64),
  source: z.enum(['guest', 'employee', 'system']).default('guest'),
  note: z.string().trim().max(300).default(''),
  idempotencyKey: z.string().trim().min(8).max(128),
})

export type CreateTaskInput = z.infer<typeof createTaskSchema>

export const taskActionSchema = z.object({
  action: z.enum(['accept', 'arrive', 'complete', 'confirm', 'unresolved', 'cancel']),
  actorId: z.string().trim().min(1),
  note: z.string().trim().max(300).default(''),
  idempotencyKey: z.string().trim().min(8).max(128),
})

export type TaskActionInput = z.infer<typeof taskActionSchema>

const slaSchema = z
  .object({
    warningSeconds: z.number().int().min(5).max(900),
    escalateSeconds: z.number().int().min(10).max(1800),
    managerSeconds: z.number().int().min(15).max(3600),
  })
  .refine(
    ({ warningSeconds, escalateSeconds, managerSeconds }) =>
      warningSeconds < escalateSeconds && escalateSeconds < managerSeconds,
    { message: 'SLA必须满足预警 < 首次升级 < 经理接管' },
  )

export const skillConfigSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(40),
  enabled: z.boolean(),
})

export const workstationConfigSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(40),
  kind: z.enum(['production', 'delivery', 'hybrid']),
  enabled: z.boolean(),
  productionRoleIds: z.array(z.string().trim().min(1).max(64)).max(20),
  deliveryRoleIds: z.array(z.string().trim().min(1).max(64)).max(20),
  requiredSkillIds: z.array(z.string().trim().min(1).max(64)).max(20),
  productionSlaSeconds: z.number().int().min(5).max(7200),
  pickupSlaSeconds: z.number().int().min(5).max(7200),
  deliveryServiceTypeId: z.string().trim().min(1).max(64).nullable(),
  fallbackStationId: z.string().trim().min(1).max(64).nullable(),
})

export const configDraftSchema = z.object({
  serviceTypes: z.array(
    z.object({
      id: z.string().min(1),
      enabled: z.boolean(),
      guestVisible: z.boolean().optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']),
      dispatchRoleIds: z.array(z.string().min(1)).min(1),
      customerReply: z.string().trim().min(1).max(200),
      actionScript: z.array(z.string().trim().min(1).max(120)).min(1).max(10),
      sla: slaSchema,
    }),
  ),
  roles: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().trim().min(1).max(40).optional(),
      maxConcurrentTasks: z.number().int().min(1).max(20),
      canReceiveTasks: z.boolean(),
      permissionIds: z.array(z.enum(staffPermissionIds)).max(staffPermissionIds.length).optional(),
      dataScope: z.enum(['own', 'assigned_areas', 'store', 'all_stores']).optional(),
      approvalLimits: z.object({
        giftAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        discountAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        refundRequestAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        refundApproveAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        inventoryAdjustmentAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      }).optional(),
    }),
  ),
  skills: z.array(skillConfigSchema).optional(),
  workstations: z.array(workstationConfigSchema).optional(),
  proactiveOrderCare: z.object({
    enabled: z.boolean(),
    firstReminderSeconds: z.number().int().min(30).max(3600),
    repeatReminderSeconds: z.number().int().min(30).max(3600),
    maxReminders: z.number().int().min(1).max(10),
    serviceTypeId: z.string().trim().min(1),
  }),
})

export type ConfigDraftInput = z.infer<typeof configDraftSchema>

export const awaitingOrderActionSchema = z.object({
  actorId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(8).max(128),
  reason: z.string().trim().max(200).default(''),
})

export type AwaitingOrderActionInput = z.infer<typeof awaitingOrderActionSchema>

export const closeTableSessionSchema = z.object({
  reason: z.string().trim().min(2).max(200),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

export type CloseTableSessionInput = z.infer<typeof closeTableSessionSchema>

export const employeeWriteSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  initials: z.string().trim().min(1).max(4),
  status: z.enum(['active', 'inactive']),
  roleId: z.string().trim().min(1).max(64),
  online: z.boolean(),
  paused: z.boolean(),
  areaIds: z.array(z.string().trim().min(1)).max(20),
  skillIds: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
})

export type EmployeeWriteInput = z.infer<typeof employeeWriteSchema>

export const tableWriteSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  areaId: z.string().trim().min(1).max(64),
  capacity: z.number().int().min(1).max(100),
  status: z.enum(['available', 'occupied', 'reserved', 'paused']),
  primaryEmployeeId: z.string().trim().min(1),
  backupEmployeeIds: z.array(z.string().trim().min(1)).max(10),
})

export type TableWriteInput = z.infer<typeof tableWriteSchema>

export const shiftWriteSchema = z.object({
  employeeId: z.string().trim().min(1),
  businessDate: z.iso.date(),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
  roleId: z.string().trim().min(1),
  areaIds: z.array(z.string().trim().min(1)).min(1).max(20),
  stationIds: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  isPrimary: z.boolean(),
  status: z.enum(['scheduled', 'active', 'completed', 'cancelled']),
})

export type ShiftWriteInput = z.infer<typeof shiftWriteSchema>

export const areaWriteSchema = z.object({
  name: z.string().trim().min(1).max(40),
  shortName: z.string().trim().min(1).max(12),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  sortOrder: z.number().int().min(1).max(999),
})

export type AreaWriteInput = z.infer<typeof areaWriteSchema>

export const productWriteSchema = z.object({
  sku: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(80),
  specification: z.string().trim().min(1).max(80),
  listPriceAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  costAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  stationId: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
})

export type ProductWriteInput = z.infer<typeof productWriteSchema>
