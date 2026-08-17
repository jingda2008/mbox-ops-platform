import { describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import {
  evaluateCommercialReadiness,
  type CommercialReadinessSnapshot,
} from './verify-normalized-commercial-readiness.js'

const ready: CommercialReadinessSnapshot = {
  schemaFlavor: 'normalized-core-v1',
  schemaVersion: '046',
  storeActive: true,
  configurationApplications: 1,
  latestConfigVersion: 'v1',
  latestConfigSha256: 'a'.repeat(64),
  latestSourceCommitSha: '27e9cba12947456ce83f8da16aa4eca63af731cf',
  catalogApplications: 1,
  latestCatalogVersion: 'catalog-v1',
  latestCatalogSha256: 'b'.repeat(64),
  latestCatalogSourceCommitSha: '27e9cba12947456ce83f8da16aa4eca63af731cf',
  reservationPolicies: 1,
  activeTables: 65,
  activeEmployees: 13,
  activeProducts: 81,
  guestVisibleProducts: 80,
  recommendationProducts: 3,
  productsMissingCurrentPrice: 0,
  productsMissingCost: 0,
  bundlesMissingComponents: 0,
  invalidBundleComponents: 0,
  financialRolesMissingLimits: [],
  kdsRolesMissingStationScopes: [],
  operationalRolesMissingPermissions: [],
  tablesMissingMinimumSpend: 0,
  tablesMissingLayout: 0,
}

const miniKeys = generateKeyPairSync('ed25519')
const miniTrust = {
  keyId: 'wechat-approval-2026-01',
  publicKeyBase64: Buffer.from(miniKeys.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64'),
}
const miniAttestation = Buffer.from(JSON.stringify({
  format: 'mbox.wechat-miniprogram-platform-attestation.v1',
  stage: 'release',
  keyId: miniTrust.keyId,
  issuer: '微信发布复核岗',
  approvalTicket: 'CAB-20260816-001',
  issuedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  evidencePayloadSha256: 'e'.repeat(64),
  candidateManifestSha256: 'd'.repeat(64),
  sourceCommitSha: ready.latestSourceCommitSha!,
  appId: 'wx1234567890abcdef',
  apiBaseUrl: 'https://api.shmbox.cn',
}))
const miniReady = {
  format: 'mbox.wechat-miniprogram-release-verification.v1' as const,
  status: 'ready' as const,
  stage: 'release' as const,
  checkedAt: new Date().toISOString(),
  sourceCommitSha: ready.latestSourceCommitSha!,
  appId: 'wx1234567890abcdef',
  apiBaseUrl: 'https://api.shmbox.cn',
  evidenceSha256: 'c'.repeat(64),
  evidencePayloadSha256: 'e'.repeat(64),
  candidateManifestSha256: 'd'.repeat(64),
  evidenceTrust: 'trusted_external_attestation' as const,
  attestationKeyId: miniTrust.keyId,
  attestationSha256: createHash('sha256').update(miniAttestation).digest('hex'),
  attestationPayloadBase64: miniAttestation.toString('base64'),
  attestationSignature: sign(null, miniAttestation, miniKeys.privateKey).toString('base64'),
  failures: [],
}

describe('normalized commercial readiness', () => {
  it('accepts a complete immutable store snapshot', () => {
    expect(evaluateCommercialReadiness(ready, ready.latestSourceCommitSha ?? undefined, miniReady, miniTrust)).toEqual([])
  })

  it('blocks empty commerce, incomplete permissions and commit drift', () => {
    const issues = evaluateCommercialReadiness({
      ...ready,
      activeProducts: 0,
      guestVisibleProducts: 0,
      recommendationProducts: 0,
      financialRolesMissingLimits: ['MANAGER:refund.request'],
      kdsRolesMissingStationScopes: ['BARTENDER'],
      operationalRolesMissingPermissions: ['OWNER:checkout.upgrade.rule.publish'],
    }, 'b'.repeat(40), miniReady, miniTrust)
    expect(issues.filter((issue) => issue.severity === 'blocker').map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'configuration.commit_mismatch',
      'catalog.empty',
      'catalog.guest_empty',
      'catalog.recommendations_insufficient',
      'access.financial_limit_missing',
      'access.kds_scope_missing',
      'access.operational_permission_missing',
    ]))
  })

  it('blocks unconfirmed table commercial data instead of pretending it is configured', () => {
    const issues = evaluateCommercialReadiness({
      ...ready,
      tablesMissingMinimumSpend: 65,
      tablesMissingLayout: 65,
    }, undefined, miniReady, miniTrust)
    expect(issues).toEqual([
      expect.objectContaining({ severity: 'blocker', code: 'tables.minimum_spend_unconfirmed' }),
      expect.objectContaining({ severity: 'blocker', code: 'tables.layout_unconfirmed' }),
    ])
  })

  it('blocks missing, failed or commit-drifted mini-program external evidence', () => {
    expect(evaluateCommercialReadiness(ready).map((issue) => issue.code)).toContain('miniprogram.release_evidence_missing')
    expect(evaluateCommercialReadiness(ready, ready.latestSourceCommitSha!, {
      ...miniReady, status: 'blocked', failures: ['platform receipt absent'],
    }, miniTrust).map((issue) => issue.code)).toContain('miniprogram.release_evidence_missing')
    expect(evaluateCommercialReadiness(ready, 'e'.repeat(40), miniReady, miniTrust).map((issue) => issue.code)).toContain('miniprogram.commit_mismatch')
    expect(evaluateCommercialReadiness(ready, undefined, {
      ...miniReady, apiBaseUrl: 'https://139.224.254.60',
    }, miniTrust).map((issue) => issue.code)).toContain('miniprogram.release_evidence_missing')
    expect(evaluateCommercialReadiness(ready, undefined, {
      ...miniReady, stage: 'candidate', evidenceTrust: 'local_integrity_only',
      attestationKeyId: '', attestationSha256: '', attestationPayloadBase64: '', attestationSignature: '',
    }, miniTrust).map((issue) => issue.code)).toContain('miniprogram.release_evidence_missing')
    expect(evaluateCommercialReadiness(ready, undefined, {
      ...miniReady, stage: 'upload',
    }, miniTrust).map((issue) => issue.code)).toContain('miniprogram.release_evidence_missing')
    expect(evaluateCommercialReadiness(ready, undefined, miniReady).map((issue) => issue.code))
      .toContain('miniprogram.release_evidence_missing')
    expect(evaluateCommercialReadiness(ready, undefined, {
      ...miniReady, attestationSignature: Buffer.alloc(64, 7).toString('base64'),
    }, miniTrust).map((issue) => issue.code)).toContain('miniprogram.release_evidence_missing')
  })
})
