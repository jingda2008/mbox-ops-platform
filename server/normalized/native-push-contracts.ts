import type { StoreScope } from './transaction-runner.js'

export interface NativePushActor {
  scope: Readonly<StoreScope>
  employeeId: string
  staffSessionId: string
  deviceAccessLeaseId: string
  businessDate: string
}
export interface NativePushRegistration {
  expectedRevision: number
  platform: 'ios'
  provider: 'apns'
  token: string
  permission: 'authorized' | 'provisional'
  appVersion: string
  revocationSecret: string
}
export interface NativePushInstallationState {
  installationId: string
  revision: number
  status: 'active' | 'revoked' | 'invalid_token' | 'expired'
  boundToCurrentSession: boolean
  expiresAt: string
  lastRequestKey: string | null
}
export interface NativePushInstallationReceipt {
  protocol: 1
  employeeId: string
  staffSessionId: string
  requestKey: string
  installation: NativePushInstallationState
}
export const NATIVE_PUSH_PERMISSIONS = ['service.view', 'service.execute', 'service.manage', 'complaint.handle'] as const
export class NativePushError extends Error {
  constructor(readonly code: string, readonly statusCode: number, readonly notCommitted = false) {
    super('原生通知请求无法完成')
    this.name = 'NativePushError'
  }
}
export const nativePushIdentity = (actor: NativePushActor) => ({ protocol: 1 as const, employeeId: actor.employeeId, staffSessionId: actor.staffSessionId })
