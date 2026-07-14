export type RuntimeMode = 'local' | 'test' | 'staging' | 'production'

export interface StaffSessionClaims {
  version: 1
  actorId: string
  storeId: string
  issuedAt: number
  expiresAt: number
}

export interface RequestActorContext {
  actorId: string
  storeId: string
  roleId: string
  runtimeMode: RuntimeMode
  authenticatedBy: 'local_header' | 'signed_session'
}

export interface PilotEmployeeOption {
  id: string
  displayName: string
  roleName: string
}

export interface PilotLoginResponse {
  employees?: PilotEmployeeOption[]
  token?: string
  expiresAt?: number
  employee?: PilotEmployeeOption
}
