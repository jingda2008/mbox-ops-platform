import { z } from 'zod'

const identifierSchema = z.string().trim().min(1).max(128)
const shortIdentifierSchema = z.string().trim().min(1).max(64)
const nonEmptyTextSchema = z.string().trim().min(1)
const occurredAtSchema = z.string().datetime({ offset: true })
const businessDateSchema = z.iso.date()

const storeSchema = z.object({
  id: shortIdentifierSchema,
  name: z.string().trim().min(1).max(120),
  businessDate: businessDateSchema,
  timezone: z.string().trim().min(1).max(80),
}).strict()

const areaSchema = z.object({
  id: shortIdentifierSchema,
  name: z.string().trim().min(1).max(40),
  shortName: z.string().trim().min(1).max(12),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  sortOrder: z.number().int().min(1).max(999),
}).strict()

const tableSchema = z.object({
  id: shortIdentifierSchema,
  code: z.string().trim().min(1).max(32),
  displayName: z.string().trim().min(1).max(40),
  areaId: shortIdentifierSchema,
  capacity: z.number().int().min(1).max(100),
  status: z.enum(['available', 'occupied', 'reserved', 'paused']),
  primaryEmployeeId: identifierSchema,
  backupEmployeeIds: z.array(identifierSchema).min(1).max(10),
  guestCount: z.number().int().min(0).max(100),
  openedAt: occurredAtSchema.nullable(),
}).strict()

const employeeSchema = z.object({
  id: identifierSchema,
  displayName: z.string().trim().min(1).max(40),
  initials: z.string().trim().min(1).max(4),
  status: z.enum(['active', 'inactive']),
  roleId: shortIdentifierSchema,
  online: z.boolean(),
  paused: z.boolean(),
  areaIds: z.array(shortIdentifierSchema).max(20),
}).strict()

const shiftSchema = z.object({
  id: identifierSchema,
  employeeId: identifierSchema,
  businessDate: businessDateSchema,
  startAt: occurredAtSchema,
  endAt: occurredAtSchema,
  roleId: shortIdentifierSchema,
  areaIds: z.array(shortIdentifierSchema).min(1).max(20),
  isPrimary: z.boolean(),
  status: z.enum(['scheduled', 'active', 'completed', 'cancelled']),
}).strict()

const productSchema = z.object({
  id: identifierSchema,
  sku: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(80),
  specification: z.string().trim().min(1).max(80),
  listPriceAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  costAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  stationId: shortIdentifierSchema,
  enabled: z.boolean(),
  configVersion: z.number().int().positive(),
}).strict()

const approvalSchema = z.object({
  operationsApproverId: identifierSchema,
  financeApproverId: identifierSchema,
  approvedAt: occurredAtSchema,
  reason: z.string().trim().min(2).max(500),
}).strict()

const authoritySchema = z.object({
  id: identifierSchema,
  actorId: identifierSchema,
  kinds: z.array(z.enum(['discount', 'gift'])).min(1).max(2),
  maxAmount: z.number().int().min(0).max(10_000_000),
  allowedSkuIds: z.array(identifierSchema).nullable(),
  tableSessionIds: z.array(identifierSchema).nullable(),
  validFrom: occurredAtSchema,
  validUntil: occurredAtSchema,
  approval: approvalSchema,
}).strict()

const roleSchema = z.object({
  id: shortIdentifierSchema,
  name: z.string().trim().min(1).max(40),
  maxConcurrentTasks: z.number().int().min(1).max(20),
  canReceiveTasks: z.boolean(),
}).strict()

const slaSchema = z.object({
  warningSeconds: z.number().int().min(5).max(900),
  escalateSeconds: z.number().int().min(10).max(1800),
  managerSeconds: z.number().int().min(15).max(3600),
}).strict()

const serviceTypeSchema = z.object({
  id: shortIdentifierSchema,
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  icon: z.enum(['water', 'ice', 'order', 'bill', 'complaint', 'birthday']),
  enabled: z.boolean(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  dispatchRoleIds: z.array(shortIdentifierSchema).min(1),
  sla: slaSchema,
  customerReply: z.string().trim().min(1).max(200),
  actionScript: z.array(z.string().trim().min(1).max(120)).min(1).max(10),
}).strict()

const configSchema = z.object({
  version: z.number().int().positive(),
  status: z.literal('published'),
  publishedAt: occurredAtSchema,
  serviceTypes: z.array(serviceTypeSchema).min(1),
  roles: z.array(roleSchema).min(1),
  proactiveOrderCare: z.object({
    enabled: z.boolean(),
    firstReminderSeconds: z.number().int().min(30).max(3600),
    repeatReminderSeconds: z.number().int().min(30).max(3600),
    maxReminders: z.number().int().min(1).max(10),
    serviceTypeId: shortIdentifierSchema,
  }).strict(),
}).strict()

export const storeImportCompletenessValues = ['complete', 'partial', 'draft'] as const
export type StoreImportCompleteness = (typeof storeImportCompletenessValues)[number]

const completenessSchema = z.enum(storeImportCompletenessValues)
const singletonPolicySchema = z.object({ completeness: completenessSchema }).strict()
const collectionPolicySchema = z.object({
  mode: z.enum(['replace', 'upsert']),
  completeness: completenessSchema,
}).strict()

const responsibilityRolesSchema = z.object({
  primaryRoleIds: z.array(shortIdentifierSchema).min(1),
  backupRoleIds: z.array(shortIdentifierSchema).min(1),
  supervisorRoleIds: z.array(shortIdentifierSchema).min(1),
  managerRoleIds: z.array(shortIdentifierSchema).min(1),
}).strict()

export const storeImportPackageSchema = z.object({
  schemaVersion: z.literal(1),
  packageId: identifierSchema,
  packageVersion: z.number().int().positive(),
  targetStoreId: shortIdentifierSchema,
  createdAt: occurredAtSchema,
  source: z.object({
    sourceSystem: z.string().trim().min(1).max(120),
    sourceReference: z.string().trim().min(1).max(300),
    preparedBy: z.string().trim().min(1).max(120),
  }).strict(),
  declaredMissingData: z.array(nonEmptyTextSchema.max(300)).max(100),
  policy: z.object({
    target: z.enum(['sandbox', 'production']),
    sections: z.object({
      store: singletonPolicySchema,
      config: singletonPolicySchema,
      areas: collectionPolicySchema,
      tables: collectionPolicySchema,
      employees: collectionPolicySchema,
      shiftAssignments: collectionPolicySchema,
      products: collectionPolicySchema,
      authorizationAuthorities: collectionPolicySchema,
    }).strict(),
    responsibilityRoles: responsibilityRolesSchema,
    requireShiftRoleMatchEmployeeRole: z.boolean(),
    allowZeroListPrice: z.boolean(),
  }).strict(),
  data: z.object({
    store: storeSchema,
    config: configSchema,
    areas: z.array(areaSchema).min(1),
    tables: z.array(tableSchema).min(1),
    employees: z.array(employeeSchema).min(1),
    shiftAssignments: z.array(shiftSchema).min(1),
    products: z.array(productSchema).min(1),
    authorizationAuthorities: z.array(authoritySchema).min(1),
  }).strict(),
}).strict()

export type StoreImportPackage = z.infer<typeof storeImportPackageSchema>
export type StoreImportAuthority = StoreImportPackage['data']['authorizationAuthorities'][number]

export const storeImportApplyCommandSchema = z.object({
  actorId: identifierSchema,
  occurredAt: occurredAtSchema,
  reason: z.string().trim().min(2).max(500),
}).strict()

export type StoreImportApplyCommand = z.infer<typeof storeImportApplyCommandSchema>

export type StoreImportSection =
  | 'package'
  | 'store'
  | 'config'
  | 'areas'
  | 'tables'
  | 'employees'
  | 'shiftAssignments'
  | 'products'
  | 'authorizationAuthorities'

export interface StoreImportIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
  section: StoreImportSection
  /** One-based row number for collection sections. */
  row: number | null
  field: string | null
}

export type StoreImportDiffOperation = 'add' | 'update' | 'remove' | 'unchanged'

export interface StoreImportDiffEntry {
  id: string
  operation: StoreImportDiffOperation
  changedFields: string[]
  before: unknown | null
  after: unknown | null
}

export interface StoreImportSectionDiff {
  added: number
  updated: number
  removed: number
  unchanged: number
  entries: StoreImportDiffEntry[]
}

export interface StoreImportPreview {
  store: StoreImportSectionDiff
  config: StoreImportSectionDiff
  areas: StoreImportSectionDiff
  tables: StoreImportSectionDiff
  employees: StoreImportSectionDiff
  shiftAssignments: StoreImportSectionDiff
  products: StoreImportSectionDiff
  authorizationAuthorities: StoreImportSectionDiff
}

export interface StoreImportPreflightResult {
  valid: boolean
  issues: StoreImportIssue[]
  preview: StoreImportPreview | null
}
