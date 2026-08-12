export type RuntimeMode = 'local' | 'test' | 'staging' | 'production'

export interface StaffSessionClaims {
  version: 1
  sessionId: string
  actorId: string
  storeId: string
  issuedAt: number
  expiresAt: number
}

export interface StoreAccessPassClaims {
  version: 1
  tokenType: 'store_access'
  storeId: string
  chinaDate: string
  issuedAt: number
  expiresAt: number
}

export interface RequestActorContext {
  actorId: string
  storeId: string
  roleId: string
  runtimeMode: RuntimeMode
  authenticatedBy: 'local_header' | 'signed_session'
  sessionId: string | null
  sessionExpiresAt: number | null
  businessDate?: string
  presenceExpiresAt?: number
}

export interface PilotEmployeeOption {
  id: string
  displayName: string
  roleName: string
}

export interface PilotLoginResponse {
  employees?: PilotEmployeeOption[]
  storeAccessToken?: string
  storeAccessExpiresAt?: number
  token?: string
  expiresAt?: number
  employee?: PilotEmployeeOption
  sessionId?: string
  presenceExpiresAt?: number
}

export interface StaffPresenceResponse {
  sessionId: string
  actorId: string
  online: boolean
  leaseExpiresAt: number | null
  heartbeatAfterMs: number
}
