import { OfficialSocialAccountAdapter } from './social-account-adapter.js'
import { SocialAccountRepository } from './social-account-repository.js'
import type { ActivityContactProtectionKeyring } from './personal-contact-protection.js'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

export interface ServiceAccountSubscriptionReport {
  appId: string
  openId: string
  authorizationRef: string
  acceptedTemplateIds: readonly string[]
}

export async function recordServiceAccountSubscription(
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
  scope: Readonly<StoreScope>,
  protection: ActivityContactProtectionKeyring,
  input: Readonly<ServiceAccountSubscriptionReport>,
  request: typeof fetch = fetch,
): Promise<void> {
  const configured = await transactions.run(scope, tx => (
    new SocialAccountRepository(tx, protection).enabledServiceAccount(input.appId)
  ), { readOnly: true })
  // An existing follower may never emit a new subscribe callback. Refresh from
  // the official user API outside a database transaction. Never trust a client
  // supplied customer ID, union ID, follow state or subscription quota.
  const observedAt = new Date().toISOString()
  let user: { active: boolean; unionId: string | null } | null = null
  try { user = await new OfficialSocialAccountAdapter(configured.account, configured.credentials, request).user(input.openId) }
  catch { /* Preserve the report; a provider outage must not invent a revocation. */ }
  await transactions.run(scope, async tx => {
    const repo = new SocialAccountRepository(tx, protection)
    await repo.recordSubscriptionReport(input)
    if (user) await repo.applyRelationship({ accountId: configured.account.id, externalId: input.openId,
      staffId: '', active: user.active, unionId: user.unionId, occurredAt: observedAt })
  })
}
