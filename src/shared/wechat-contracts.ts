import { z } from 'zod'

export const wechatFailureClasses = [
  'configuration',
  'authentication',
  'authorization',
  'validation',
  'rate_limit',
  'transient',
  'provider_rejection',
  'identity_conflict',
  'replay',
  'expired',
] as const

export type WechatFailureClass = (typeof wechatFailureClasses)[number]
export type WechatChannel = 'service_account' | 'wecom'

export interface WechatFailure {
  classification: WechatFailureClass
  code: string
  message: string
  retryable: boolean
  providerRequestId?: string
}

export type WechatProviderResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: WechatFailure }

export interface MiniProgramCodeSessionRequest {
  appId: string
  code: string
}

export interface MiniProgramCodeSession {
  openId: string
  unionId: string | null
  sessionKey: string
  providerRequestId?: string
}

export interface MiniProgramCodeSessionProvider {
  exchangeCode(request: MiniProgramCodeSessionRequest): Promise<WechatProviderResult<MiniProgramCodeSession>>
}

export interface WechatLoginChallenge {
  state: string
  nonce: string
  expiresAt: string
}

export interface WechatLoginChallengeClaims {
  version: 1
  challengeId: string
  tenantId: string
  storeId: string
  appId: string
  nonceHash: string
  issuedAt: number
  expiresAt: number
}

export interface WechatIdentityRecord {
  id: string
  principalId: string
  tenantId: string
  storeId: string
  appId: string
  openId: string
  unionId: string | null
  memberId: string | null
  createdAt: string
  lastAuthenticatedAt: string
}

export interface WechatAuthenticatedPrincipal {
  principalId: string
  identityId: string
  tenantId: string
  storeId: string
  appId: string
  memberId: string | null
  hasUnionId: boolean
}

export const miniProgramAuthenticationSchema = z.object({
  tenantId: z.string().trim().min(1).max(128),
  storeId: z.string().trim().min(1).max(128),
  appId: z.string().trim().min(1).max(128),
  code: z.string().trim().min(1).max(512),
  state: z.string().trim().min(16).max(4096),
  nonce: z.string().trim().min(16).max(512),
})

export type MiniProgramAuthenticationInput = z.infer<typeof miniProgramAuthenticationSchema>

export type MiniProgramAuthenticationResult =
  | {
      outcome: 'authenticated'
      principal: WechatAuthenticatedPrincipal
      sessionKey: string
      sessionExpiresAt: string
      providerRequestId?: string
    }
  | { outcome: 'failed'; failure: WechatFailure }

export interface WechatAccessToken {
  accessToken: string
  expiresInSeconds: number
  providerRequestId?: string
}

export interface WechatAccessTokenClient {
  refreshAccessToken(): Promise<WechatProviderResult<WechatAccessToken>>
}

export interface ServiceAccountSubscriptionMessageRequest {
  accessToken: string
  toOpenId: string
  templateId: string
  page?: string
  data: Record<string, { value: string }>
  clientRequestId: string
}

export interface WecomNotificationRequest {
  accessToken: string
  toUserId: string
  agentId: string
  content: string
  clientRequestId: string
}

export interface WechatProviderMessageReceipt {
  providerMessageId: string
  providerRequestId?: string
}

export interface ServiceAccountSubscriptionMessageClient {
  sendSubscriptionMessage(
    request: ServiceAccountSubscriptionMessageRequest,
  ): Promise<WechatProviderResult<WechatProviderMessageReceipt>>
}

export interface WecomNotificationClient {
  sendNotification(request: WecomNotificationRequest): Promise<WechatProviderResult<WechatProviderMessageReceipt>>
}

export type WechatNotificationRecipient =
  | { channel: 'service_account'; openId: string }
  | { channel: 'wecom'; userId: string }

export interface WechatNotificationRecipientResolver {
  resolveRecipient(
    channel: WechatChannel,
    memberId: string,
    templateCode: string,
  ): Promise<WechatProviderResult<WechatNotificationRecipient>>
}
