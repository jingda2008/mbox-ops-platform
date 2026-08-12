export const STAFF_BOOTSTRAP_SCHEMA_VERSION = 1 as const

export type StaffBusinessDayStatus = 'open' | 'awaiting_close' | 'closed' | 'not_initialized'

export type StaffDomainKey =
  | 'live'
  | 'service'
  | 'fulfillment'
  | 'reservations'
  | 'payments'
  | 'inventory'
  | 'printing'

export interface StaffNavigationItem {
  code: string
  label: string
  route: string
  icon: string | null
  sortOrder: number
  displayConfig: Record<string, unknown>
}

export interface StaffHighFrequencyEntry {
  code: string
  label: string
  route: string
  icon: string | null
}

export interface StaffDomainSummary {
  key: StaffDomainKey
  label: string
  activeCount: number
  attentionCount: number
  readyCount: number
  endpointRef: string
}

export interface StaffEndpointReferences {
  workspace: string
  sessions: string
  operations: string
  tableManagement: string
  fulfillment: string
  reservations: string
  reservationIntake: string
  reconciliation: string
  inventory: string
  notifications: string
  aiCapabilities: string
  hardwareWork: string
}

export interface StaffBootstrapView {
  schemaVersion: typeof STAFF_BOOTSTRAP_SCHEMA_VERSION
  generatedAt: string
  watermark: string
  store: {
    id: string
    code: string
    name: string
    timezone: string
    businessDayCutoff: string
    currency: string
  }
  businessDay: {
    date: string
    status: StaffBusinessDayStatus
    openedAt: string | null
    rolloverAt: string | null
    closedAt: string | null
  }
  staff: {
    id: string
    code: string
    displayName: string
    roleCodes: string[]
    roleNames: string[]
  }
  access: {
    permissions: string[]
    deniedPermissions: string[]
    dataScopes: Array<{
      key: string
      effect: 'include' | 'exclude'
      value: unknown
    }>
    approvalLimits: Array<{
      code: string
      amountMinor: number | null
      currency: string
      rules: Record<string, unknown>
    }>
    resolvedAt: string
  }
  navigation: StaffNavigationItem[]
  highFrequencyEntries: StaffHighFrequencyEntry[]
  domainSummaries: StaffDomainSummary[]
  endpointRefs: StaffEndpointReferences
}

export interface StaffBootstrapResponse {
  data: StaffBootstrapView
  meta: NormalizedApiMeta
}

export interface StaffAccessPermissionView {
  code: string
  name: string
  category: string
  description: string | null
}

export interface StaffAccessRoleView {
  id: string
  code: string
  name: string
  status: string
  memberCount: number
  permissionCodes: string[]
  dataScopes: StaffAccessDataScopeView[]
  approvalLimits: StaffAccessApprovalLimitView[]
  navigation: StaffAccessNavigationView[]
  dataScopeCount: number
  approvalLimitCount: number
  navigationCount: number
}

export interface StaffAccessDataScopeView {
  key: string
  effect: 'include' | 'exclude'
  value: unknown
  enabled: boolean
}

export interface StaffAccessApprovalLimitView {
  code: string
  amountMinor: number | null
  currency: string
  rules: Record<string, unknown>
  enabled: boolean
}

export interface StaffAccessNavigationView {
  code: string
  label: string
  route: string
  icon: string | null
  sortOrder: number
  enabled: boolean
  displayConfig: Record<string, unknown>
}

export interface StaffAccessAreaView {
  id: string
  code: string
  name: string
}

export interface StaffAccessConfigurationDefinitionView {
  kind: 'approval_limit' | 'data_scope' | 'navigation'
  code: string
  label: string
  description: string | null
  requiredPermissionCodes: string[]
  sortOrder: number
  config: Record<string, unknown>
}

export interface StaffAccessEmployeeOverrideView {
  permissionCode: string
  effect: 'grant' | 'deny'
  reason: string
  endsAt: string | null
}

export interface StaffAccessEmployeeView {
  id: string
  code: string
  displayName: string
  status: string
  roleCodes: string[]
  overrides: StaffAccessEmployeeOverrideView[]
}

export interface StaffAccessManagementOverview {
  generatedAt: string
  roles: StaffAccessRoleView[]
  employees: StaffAccessEmployeeView[]
  permissions: StaffAccessPermissionView[]
  areas: StaffAccessAreaView[]
  configurationDefinitions: StaffAccessConfigurationDefinitionView[]
}

export type StaffPermissionDeploymentChange =
  | { kind: 'role_permission'; roleId: string; permissionCode: string; enabled: boolean }
  | { kind: 'employee_override'; employeeId: string; permissionCode: string; effect: 'grant' | 'deny' | null }
  | { kind: 'role_data_scope'; roleId: string; scopeKey: string; effect: 'include' | 'exclude'; scopeValue: unknown; enabled: boolean }
  | { kind: 'role_approval_limit'; roleId: string; approvalCode: string; amountMinor: number | null; currency: string; rules: Record<string, unknown>; enabled: boolean }
  | { kind: 'role_navigation'; roleId: string; navigationCode: string; label: string; route: string; icon: string | null; sortOrder: number; enabled: boolean; displayConfig: Record<string, unknown> }

export interface StaffPermissionDeploymentResult {
  status: 'verified'
  verifiedAt: string
  replayed: boolean
  changes: Array<{
    kind: StaffPermissionDeploymentChange['kind']
    targetId: string
    configurationCode: string
    applied: boolean
    effectiveEmployeeCount: number
    affectedEmployeeCount: number
  }>
  overview: StaffAccessManagementOverview
}

export interface NormalizedApiMeta {
  requestId?: string
  generatedAt: string
}

export interface NormalizedApiSuccessBody<Data> {
  data: Data
  meta: NormalizedApiMeta
}

export interface NormalizedApiErrorBody {
  error: {
    code: string
    message: string
    retryable: boolean
    details?: Record<string, unknown>
  }
  meta?: { requestId?: string }
}

export type StaffOnDemandResource = 'sessions' | 'operations' | 'fulfillment' | 'reservation-summary'

export interface StaffOnDemandEndpointMap {
  sessions: StaffEndpointReferences['sessions']
  operations: StaffEndpointReferences['operations']
  fulfillment: StaffEndpointReferences['fulfillment']
  'reservation-summary': StaffEndpointReferences['reservations']
}
