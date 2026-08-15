import { describe, expect, it } from 'vitest'
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
  tablesMissingMinimumSpend: 0,
  tablesMissingLayout: 0,
}

describe('normalized commercial readiness', () => {
  it('accepts a complete immutable store snapshot', () => {
    expect(evaluateCommercialReadiness(ready, ready.latestSourceCommitSha ?? undefined)).toEqual([])
  })

  it('blocks empty commerce, incomplete permissions and commit drift', () => {
    const issues = evaluateCommercialReadiness({
      ...ready,
      activeProducts: 0,
      guestVisibleProducts: 0,
      recommendationProducts: 0,
      financialRolesMissingLimits: ['MANAGER:refund.approve'],
      kdsRolesMissingStationScopes: ['BARTENDER'],
    }, 'b'.repeat(40))
    expect(issues.filter((issue) => issue.severity === 'blocker').map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'configuration.commit_mismatch',
      'catalog.empty',
      'catalog.guest_empty',
      'catalog.recommendations_insufficient',
      'access.financial_limit_missing',
      'access.kds_scope_missing',
    ]))
  })

  it('blocks unconfirmed table commercial data instead of pretending it is configured', () => {
    const issues = evaluateCommercialReadiness({
      ...ready,
      tablesMissingMinimumSpend: 65,
      tablesMissingLayout: 65,
    })
    expect(issues).toEqual([
      expect.objectContaining({ severity: 'blocker', code: 'tables.minimum_spend_unconfirmed' }),
      expect.objectContaining({ severity: 'blocker', code: 'tables.layout_unconfirmed' }),
    ])
  })
})
