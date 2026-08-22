import { z } from 'zod'
import {
  isNavigationAllowedForStaffPermissions,
  staffNavigationIds,
  type StaffNavigationId,
} from './staff-navigation.js'
import type { OrderDomainState, ProductFulfillmentType } from './order-contracts.js'
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
import type { CommercialOpsState } from './commercial-ops-contracts.js'
import type { DutyManagerIncident } from './assistant-contracts.js'
import { assistantCapabilityIds, type AssistantCapabilityId } from './assistant-tool-contracts.js'
import type { HardwareState } from './hardware-contracts.js'
import { sopRuleSchema, type SopActionRecord, type SopExecution, type SopRule } from './sop-contracts.js'

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
export type ServiceWorkflowLevel = 'L0' | 'L1' | 'L2' | 'L3'
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
  /** Latest guest-selected mood for the current table visit. It is context, never a service task. */
  guestMood?: {
    moodId: string
    tableSessionId: string
    updatedAt: string
  } | null
}

export interface Employee {
  id: string
  displayName: string
  initials: string
  status: 'active' | 'inactive'
  roleId: string
  /** Additional duties this account may perform; roleId remains the default home identity. */
  roleIds?: string[]
  /** Optional personal grants are merged with all configured role permissions. */
  permissionIds?: StaffPermissionId[]
  /** Optional personal high-frequency entry override. Missing means follow the assigned role defaults. */
  primaryNavigationIds?: StaffNavigationId[]
  online: boolean
  paused: boolean
  areaIds: string[]
  skillIds?: string[]
}

export interface PresenceLease {
  sessionId: string
  actorId: string
  storeId: string
  businessDate: string
  establishedAt: number
  lastSeenAt: number
  expiresAt: number
  sessionExpiresAt: number
}

export interface ShiftAssignment {
  id: string
  employeeId: string
  businessDate: string
  startAt: string
  endAt: string
  roleId: string
  /** Additional duties active for this shift; roleId remains the primary duty. */
  roleIds?: string[]
  areaIds: string[]
  stationIds?: string[]
  isPrimary: boolean
  status: 'scheduled' | 'active' | 'completed' | 'cancelled'
}

export const menuProductKinds = ['single', 'bundle'] as const
export type MenuProductKind = (typeof menuProductKinds)[number]

export const menuBeverageFamilies = [
  'none',
  'cocktail',
  'beer',
  'wine',
  'sparkling',
  'spirits',
  'non_alcoholic',
  'mixed',
] as const
export type MenuBeverageFamily = (typeof menuBeverageFamilies)[number]

export const menuRecommendationScenes = [
  'unsure',
  'date',
  'brothers',
  'besties',
  'friends',
  'business',
  'celebration',
] as const
export type MenuRecommendationScene = (typeof menuRecommendationScenes)[number]

export const menuRecommendationIntents = ['relaxed', 'energetic', 'ritual', 'unsure'] as const
export type MenuRecommendationIntent = (typeof menuRecommendationIntents)[number]

export const menuRecommendationTastes = ['refreshing', 'layered', 'strong', 'any'] as const
export type MenuRecommendationTaste = (typeof menuRecommendationTastes)[number]

export const menuRecommendationDwells = ['one_set', 'stay_longer', 'no_rush'] as const
export type MenuRecommendationDwell = (typeof menuRecommendationDwells)[number]

export interface MenuBundleComponent {
  productId: string
  quantity: number
}

export interface MenuRecommendationConfig {
  enabled: boolean
  priority: number
  badge: string
  headline: string
  reason: string
  minimumPartySize: number
  maximumPartySize: number
  sceneTags: MenuRecommendationScene[]
  intentTags: MenuRecommendationIntent[]
  tasteTags: MenuRecommendationTaste[]
  dwellTags: MenuRecommendationDwell[]
  singleWaveEligible: boolean
  expectedPrepMinutes: number
  holdMinutes: number
  upgradeProductId: string | null
}

export interface MenuProduct {
  id: string
  sku: string
  name: string
  specification: string
  productKind?: MenuProductKind
  beverageFamily?: MenuBeverageFamily
  bundleComponents?: MenuBundleComponent[]
  substitutionProductIds?: string[]
  recommendation?: MenuRecommendationConfig
  categoryId?: string
  categoryName?: string
  description?: string
  imageUrl?: string
  tags?: string[]
  sortOrder?: number
  soldOut?: boolean
  soldOutReason?: string
  availableFrom?: string | null
  availableUntil?: string | null
  /** False keeps internal or adjustment products out of the guest self-order menu. */
  guestVisible?: boolean
  /** False records the sale without creating bar, kitchen, print or delivery work. */
  requiresFulfillment?: boolean
  /** Controls whether an item is made, picked directly, delivered as a service, or excluded from fulfillment. */
  fulfillmentType?: ProductFulfillmentType
  /** Per-order quantity limit; adjustment products can use a higher configured limit. */
  maxOrderQuantity?: number
  listPriceAmount: number
  costAmount: number
  /** Client-local ordinal derived from the server-returned order; not part of the public API payload. */
  serverRecommendationOrder?: number
  stationId: string
  enabled: boolean
  configVersion: number
}

export const staffPermissionIds = [
  'dashboard.view',
  'finance.view',
  'finance.manage',
  'audit.view',
  'config.manage',
  'identity.manage',
  'master_data.manage',
  'shift.manage',
  'table.open',
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
  'inventory.receive',
  'inventory.count',
  'inventory.remake',
  'inventory.bottle',
  'inventory.approve',
  'benefit.view',
  'benefit.grant',
  'benefit.approve',
  'benefit.manage',
  'song.view',
  'song.manage',
  'hardware.view',
  'hardware.operate',
  'hardware.manage',
  'printer.manage',
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
  /** Versioned high-frequency entries. Missing means use the built-in role profile. */
  primaryNavigationIds?: StaffNavigationId[]
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
  /** Optional while older config clients are still in circulation; runtime migration fills defaults. */
  workflowLevel?: ServiceWorkflowLevel
  allowBackupDirectComplete?: boolean
  allowCrossAreaComplete?: boolean
  requiresCompletionNote?: boolean
  duplicateSeconds?: number
}

export interface ProactiveOrderCareConfig {
  enabled: boolean
  firstReminderSeconds: number
  repeatReminderSeconds: number
  maxReminders: number
  serviceTypeId: string
}

export type MinimumSpendTargetType = 'area' | 'table'

export interface MinimumSpendRule {
  id: string
  name: string
  enabled: boolean
  targetType: MinimumSpendTargetType
  targetId: string
  /** JavaScript weekday values: 0 is Sunday and 6 is Saturday. */
  weekdays: number[]
  startTime: string
  endTime: string
  amount: number
  currency: string
}

export interface MinimumSpendReminderConfig {
  enabled: boolean
  firstReminderMinutes: number
  repeatMinutes: number
  thresholdPercent: number
}

export interface TableOperationsConfig {
  version: number
  updatedAt: string
  /** Automatically advances the operational business date in the store timezone. */
  automaticBusinessDayRollover?: boolean
  /** Whole Beijing-time hour when the prior overnight business day ends. */
  businessDayRolloverHour?: number
  /** Safety cutoff for forgotten handovers; normal M-Box sessions span less than one night. */
  maximumOpenHours?: number
  reminder: MinimumSpendReminderConfig
  minimumSpendRules: MinimumSpendRule[]
}

export interface MinimumSpendSnapshot {
  configVersion: number
  ruleId: string | null
  ruleName: string
  targetType: MinimumSpendTargetType | null
  targetId: string | null
  weekday: number
  startTime: string | null
  endTime: string | null
  amount: number
  currency: string
  reminder: MinimumSpendReminderConfig
  capturedAt: string
}

export type TableSessionOpenSource = 'reservation' | 'waitlist' | 'walk_in' | 'added_table' | 'legacy'

export interface TableSessionOperation {
  tableSessionId: string
  openedTableId: string
  openedTableCode: string
  source: TableSessionOpenSource
  sourceId: string | null
  /** Immutable party-size snapshot. Older persisted sessions may not contain it. */
  guestCount?: number
  /** Optional, visit-scoped context used to rank menu recommendations. */
  recommendationScene?: MenuRecommendationScene
  minimumSpendSnapshot: MinimumSpendSnapshot
  createdAt: string
}

export type SalesAttributionSubjectType = 'reservation' | 'waitlist' | 'walk_in' | 'table_session'

export interface SalesAttributionRecord {
  id: string
  subjectType: SalesAttributionSubjectType
  subjectId: string
  salesEmployeeId: string
  previousSalesEmployeeId: string | null
  actorId: string
  reason: string
  occurredAt: string
  idempotencyKey: string
}

export type TableCombinationKind = 'merge' | 'add_table'
export type TableCombinationAction = TableCombinationKind | 'split_back'

export interface TableCombinationRecord {
  id: string
  linkId: string
  action: TableCombinationAction
  kind: TableCombinationKind
  primaryTableId: string
  primaryTableCode: string
  primaryTableSessionId: string
  relatedTableId: string
  relatedTableCode: string
  relatedTableSessionId: string
  actorId: string
  reason: string
  occurredAt: string
  idempotencyKey: string
}

export interface TableSessionSummary {
  tableId: string
  tableCode: string
  tableSessionId: string
  minimumSpendAmount: number
  spendAmount: number
  differenceAmount: number
  progressPercent: number
  currency: string
  configVersion: number
  ruleName: string
  reminderRequired: boolean
  nextReminderAt: string | null
  salesEmployeeId: string | null
  recommendationScene?: MenuRecommendationScene
}

export interface GuestServiceLimitsConfig {
  windowSeconds: number
  maxRequests: number
  duplicateSeconds: number
}

export interface CommunityBrandConfig {
  enabled: boolean
  name: string
  eyebrow: string
  tagline: string
  markUrl: string
  highlights: string[]
  guestOrderVisible: boolean
  memberPortalVisible: boolean
}

export interface AssistantCapabilityPolicyConfig {
  id: AssistantCapabilityId
  enabled: boolean
  aliases: string[]
}

export type CommunityBrandPresentation = Pick<
  CommunityBrandConfig,
  'name' | 'eyebrow' | 'tagline' | 'markUrl' | 'highlights'
>

export interface StoreConfig {
  version: number
  status: 'published' | 'draft'
  publishedAt: string | null
  serviceTypes: ServiceTypeConfig[]
  roles: RoleConfig[]
  skills: SkillConfig[]
  workstations: WorkstationConfig[]
  proactiveOrderCare: ProactiveOrderCareConfig
  guestServiceLimits: GuestServiceLimitsConfig
  communityBrand: CommunityBrandConfig
  /** Configurable language aliases and enablement. Execution and risk policy remain code-enforced. */
  assistantCapabilities?: AssistantCapabilityPolicyConfig[]
  /** Versioned automation definitions. Missing on legacy snapshots and normalized during load. */
  sopRules?: SopRule[]
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

export type TableTransferKind = 'relocate' | 'temporary_to_final'

export interface TableTransferRecord {
  id: string
  tableSessionId: string
  kind: TableTransferKind
  sourceTableId: string
  sourceTableCode: string
  targetTableId: string
  targetTableCode: string
  guestCount: number
  actorId: string
  reason: string
  occurredAt: string
  idempotencyKey: string
  movedServiceTaskIds: string[]
  movedAwaitingOrderIntentIds: string[]
  movedReservationIds: string[]
  movedSongRequestIds: string[]
  movedBenefitRedemptionIds: string[]
}

export type WaitlistStatus = 'waiting' | 'notified' | 'seated' | 'cancelled' | 'skipped' | 'expired'

export interface WaitlistEntry {
  id: string
  customerReference: string
  customerName: string
  contactReference: string
  partySize: number
  areaPreferenceCode: string | null
  originalReservationId: string | null
  status: WaitlistStatus
  joinedSequence: number
  joinedAt: string
  maximumWaitUntil: string
  notifiedAt: string | null
  responseExpiresAt: string | null
  heldTableId: string | null
  heldTableCode: string | null
  tableSessionId: string | null
  seatedAt: string | null
  closedAt: string | null
  closeReason: string | null
  createdBy: string
  updatedAt: string
  revision: number
  configVersion: number
}

export interface ServiceTask {
  id: string
  tableId: string
  /** Immutable visit ownership. A table may have many visits in one business day. */
  tableSessionId: string | null
  serviceTypeId: string
  source: 'guest' | 'employee' | 'system'
  note: string
  status: TaskStatus
  priority: TaskPriority
  ownerId: string | null
  notifiedEmployeeIds: string[]
  /** Immutable SOP routing snapshots. Older tasks may not contain these fields. */
  dispatchRoleIdsSnapshot?: string[]
  targetEmployeeIdsSnapshot?: string[]
  managerRoleIdsSnapshot?: string[]
  slaSnapshot?: SlaConfig
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
  /** Immutable workflow snapshot. Optional only for persisted tasks created before V1 migration. */
  workflowLevel?: ServiceWorkflowLevel
  requestCount?: number
  firstRequestedAt?: string
  lastRequestedAt?: string
  viewedEmployeeIds?: string[]
  completedBy?: string | null
  triggerId: string | null
  archivedAt: string | null
  archiveOutcome: 'resolved' | 'unconfirmed' | 'unresolved' | null
  archivedFromStatus: TaskStatus | null
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
  /** Active device leases. Legacy snapshots are initialized by runtime migration. */
  presenceLeases?: PresenceLease[]
  shiftAssignments: ShiftAssignment[]
  products: MenuProduct[]
  orderDomain: OrderDomainState
  paymentDomain: PaymentDomainState
  inventoryDomain?: InventoryDomainState
  reservationState?: ReservationState
  commercialOps?: CommercialOpsState
  sopExecutions?: SopExecution[]
  sopActionRecords?: SopActionRecord[]
  dutyManagerIncidents?: DutyManagerIncident[]
  hardwareState?: HardwareState
  awaitingOrderIntents: AwaitingOrderIntent[]
  tableTransfers: TableTransferRecord[]
  tableOperationsConfig?: TableOperationsConfig
  tableSessionOperations?: TableSessionOperation[]
  salesAttributionRecords?: SalesAttributionRecord[]
  tableCombinationRecords?: TableCombinationRecord[]
  waitlistEntries: WaitlistEntry[]
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
  runtimeCapabilities?: {
    voiceTranscription: 'disabled' | 'google_v1'
    paymentSimulation: boolean
  }
  viewer?: {
    actorId: string
    permissionIds: StaffPermissionId[]
  }
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
  action: z.enum(['accept', 'arrive', 'complete', 'quick_complete', 'confirm', 'unresolved', 'cancel']),
  actorId: z.string().trim().min(1),
  note: z.string().trim().max(300).default(''),
  idempotencyKey: z.string().trim().min(8).max(128),
})

export type TaskActionInput = z.infer<typeof taskActionSchema>

export const managerTaskActionSchema = z.object({
  action: z.enum(['assist_complete', 'takeover', 'transfer']),
  actorId: z.string().trim().min(1),
  targetEmployeeId: z.string().trim().min(1).nullable().default(null),
  note: z.string().trim().max(300).default(''),
  idempotencyKey: z.string().trim().min(8).max(128),
})

export type ManagerTaskActionInput = z.infer<typeof managerTaskActionSchema>

export interface TaskTransferCandidate {
  employeeId: string
  displayName: string
  load: number
  capacity: number
  areaMatched: boolean
}

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
      workflowLevel: z.enum(['L0', 'L1', 'L2', 'L3']).optional(),
      allowBackupDirectComplete: z.boolean().optional(),
      allowCrossAreaComplete: z.boolean().optional(),
      requiresCompletionNote: z.boolean().optional(),
      duplicateSeconds: z.number().int().min(0).max(3600).optional(),
    }),
  ),
  roles: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().trim().min(1).max(40).optional(),
      maxConcurrentTasks: z.number().int().min(1).max(20),
      canReceiveTasks: z.boolean(),
      permissionIds: z.array(z.enum(staffPermissionIds)).max(staffPermissionIds.length).optional(),
      primaryNavigationIds: z.array(z.enum(staffNavigationIds)).min(1).max(4).nullable().optional(),
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
  guestServiceLimits: z.object({
    windowSeconds: z.number().int().min(10).max(600),
    maxRequests: z.number().int().min(1).max(30),
    duplicateSeconds: z.number().int().min(5).max(600),
  }),
  communityBrand: z.object({
    enabled: z.boolean(),
    name: z.string().trim().min(1).max(40),
    eyebrow: z.string().trim().min(1).max(60),
    tagline: z.string().trim().min(1).max(120),
    markUrl: z.string().trim().min(1).max(240),
    highlights: z.array(z.string().trim().min(1).max(20)).min(1).max(6),
    guestOrderVisible: z.boolean(),
    memberPortalVisible: z.boolean(),
  }).optional(),
  assistantCapabilities: z.array(z.object({
    id: z.enum(assistantCapabilityIds),
    enabled: z.boolean(),
    aliases: z.array(z.string().trim().min(1).max(60)).max(20),
  }).strict()).max(assistantCapabilityIds.length).superRefine((items, context) => {
    const seen = new Set<string>()
    for (const [index, item] of items.entries()) {
      if (seen.has(item.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: 'AI能力配置不能重复' })
      seen.add(item.id)
    }
  }).optional(),
  sopRules: z.array(sopRuleSchema).max(200).optional(),
}).superRefine((draft, context) => {
  draft.roles.forEach((role, roleIndex) => {
    const permissionIds = role.permissionIds ?? []
    role.primaryNavigationIds?.forEach((navigationId, navigationIndex) => {
      if (!isNavigationAllowedForStaffPermissions(navigationId, permissionIds)) {
        context.addIssue({
          code: 'custom',
          path: ['roles', roleIndex, 'primaryNavigationIds', navigationIndex],
          message: '高频入口必须属于该岗位已有权限',
        })
      }
    })
  })
})

export type ConfigDraftInput = z.infer<typeof configDraftSchema>

export const awaitingOrderActionSchema = z.object({
  actorId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(8).max(128),
  reason: z.string().trim().max(200).default(''),
  snoozeMinutes: z.number().int().min(5).max(240).optional(),
})

export type AwaitingOrderActionInput = z.infer<typeof awaitingOrderActionSchema>

export const closeTableSessionSchema = z.object({
  reason: z.string().trim().min(2).max(200),
  minimumSpendWaiver: z.object({
    reason: z.string().trim().min(5).max(300),
  }).strict().optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

export type CloseTableSessionInput = z.infer<typeof closeTableSessionSchema>

export const transferTableSessionSchema = z.object({
  targetTableId: z.string().trim().min(1).max(128),
  kind: z.enum(['relocate', 'temporary_to_final']).default('relocate'),
  reason: z.string().trim().min(2).max(200),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

export type TransferTableSessionInput = z.infer<typeof transferTableSessionSchema>

const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时段必须使用HH:mm格式')

export const minimumSpendRuleSchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  targetType: z.enum(['area', 'table']),
  targetId: z.string().trim().min(1).max(128),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  startTime: timeOfDaySchema,
  endTime: timeOfDaySchema,
  amount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict()

export const tableOperationsConfigInputSchema = z.object({
  automaticBusinessDayRollover: z.boolean().default(true),
  businessDayRolloverHour: z.number().int().min(0).max(23).default(6),
  maximumOpenHours: z.number().int().min(6).max(48).default(12),
  reminder: z.object({
    enabled: z.boolean(),
    firstReminderMinutes: z.number().int().min(1).max(720),
    repeatMinutes: z.number().int().min(1).max(720),
    thresholdPercent: z.number().int().min(1).max(100),
  }).strict(),
  minimumSpendRules: z.array(minimumSpendRuleSchema).max(500),
  reason: z.string().trim().min(2).max(300),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

export type TableOperationsConfigInput = z.infer<typeof tableOperationsConfigInputSchema>

export const walkInOpenSchema = z.object({
  partySize: z.number().int().min(1).max(100),
  salesEmployeeId: z.string().trim().min(1).max(128),
  customerName: z.string().trim().min(1).max(100).default('现场客人'),
  customerReference: z.string().trim().min(1).max(128).optional(),
  recommendationScene: z.enum(menuRecommendationScenes).optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

export type WalkInOpenInput = z.infer<typeof walkInOpenSchema>

export const salesAttributionSchema = z.object({
  salesEmployeeId: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(2).max(300),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict()

export type SalesAttributionInput = z.infer<typeof salesAttributionSchema>

export const tableCombinationSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.enum(['merge', 'add_table']),
    targetTableId: z.string().trim().min(1).max(128),
    reason: z.string().trim().min(2).max(300),
    idempotencyKey: z.string().trim().min(8).max(128),
  }).strict(),
  z.object({
    action: z.literal('split_back'),
    linkId: z.string().trim().min(1).max(128),
    reason: z.string().trim().min(2).max(300),
    idempotencyKey: z.string().trim().min(8).max(128),
  }).strict(),
])

export type TableCombinationInput = z.infer<typeof tableCombinationSchema>

export const employeeWriteSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  initials: z.string().trim().min(1).max(4),
  status: z.enum(['active', 'inactive']),
  roleId: z.string().trim().min(1).max(64),
  roleIds: z.array(z.string().trim().min(1).max(64)).max(12).optional(),
  permissionIds: z.array(z.enum(staffPermissionIds)).max(staffPermissionIds.length).optional(),
  primaryNavigationIds: z.array(z.enum(staffNavigationIds)).min(1).max(4).optional(),
  // Kept in the transport contract for old clients; presence leases are authoritative.
  online: z.boolean().transform(() => false),
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
  roleIds: z.array(z.string().trim().min(1).max(64)).max(12).optional(),
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
  productKind: z.enum(menuProductKinds).optional(),
  beverageFamily: z.enum(menuBeverageFamilies).optional(),
  bundleComponents: z.array(z.object({
    productId: z.string().trim().min(1).max(128),
    quantity: z.number().int().min(1).max(9999),
  })).max(50).optional(),
  substitutionProductIds: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
  recommendation: z.object({
    enabled: z.boolean(),
    priority: z.number().int().min(0).max(10_000),
    badge: z.string().trim().max(24),
    headline: z.string().trim().max(80),
    reason: z.string().trim().max(160),
    minimumPartySize: z.number().int().min(1).max(100),
    maximumPartySize: z.number().int().min(1).max(100),
    sceneTags: z.array(z.enum(menuRecommendationScenes)).max(menuRecommendationScenes.length),
    intentTags: z.array(z.enum(menuRecommendationIntents)).max(menuRecommendationIntents.length),
    tasteTags: z.array(z.enum(menuRecommendationTastes)).max(menuRecommendationTastes.length),
    dwellTags: z.array(z.enum(menuRecommendationDwells)).max(menuRecommendationDwells.length),
    singleWaveEligible: z.boolean(),
    expectedPrepMinutes: z.number().int().min(0).max(240),
    holdMinutes: z.number().int().min(0).max(240),
    upgradeProductId: z.string().trim().min(1).max(128).nullable(),
  }).optional(),
  categoryId: z.string().trim().min(1).max(64).optional(),
  categoryName: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().max(240).optional(),
  imageUrl: z.string().trim().max(500).optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(8).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  soldOut: z.boolean().optional(),
  soldOutReason: z.string().trim().max(80).optional(),
  availableFrom: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  availableUntil: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  guestVisible: z.boolean().optional(),
  requiresFulfillment: z.boolean().optional(),
  fulfillmentType: z.enum(['ready_to_serve', 'made_to_order', 'service_only', 'no_fulfillment']).optional(),
  maxOrderQuantity: z.number().int().min(1).max(9999).optional(),
  listPriceAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  costAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  stationId: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
}).superRefine((product, context) => {
  const hasStart = Boolean(product.availableFrom)
  const hasEnd = Boolean(product.availableUntil)
  if (hasStart !== hasEnd) {
    context.addIssue({ code: 'custom', message: '供应开始和结束时间必须同时填写', path: ['availableFrom'] })
  }
  if (hasStart && product.availableFrom === product.availableUntil) {
    context.addIssue({ code: 'custom', message: '供应开始和结束时间不能相同', path: ['availableUntil'] })
  }
  if (product.productKind === 'bundle' && (product.bundleComponents?.length ?? 0) === 0) {
    context.addIssue({ code: 'custom', message: '组合商品至少需要一个组成商品', path: ['bundleComponents'] })
  }
  if (product.productKind !== 'bundle' && (product.bundleComponents?.length ?? 0) > 0) {
    context.addIssue({ code: 'custom', message: '只有组合商品可以配置组成商品', path: ['bundleComponents'] })
  }
  if (
    product.recommendation
    && product.recommendation.minimumPartySize > product.recommendation.maximumPartySize
  ) {
    context.addIssue({ code: 'custom', message: '推荐最少人数不能大于最多人数', path: ['recommendation', 'minimumPartySize'] })
  }
})

export type ProductWriteInput = z.infer<typeof productWriteSchema>
