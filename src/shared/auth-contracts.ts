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
