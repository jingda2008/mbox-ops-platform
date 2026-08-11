import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  compareWithBaseline,
  findingCounts,
  normalizedCandidateRoots,
  scanNormalizedArchitecture,
} from './normalized-architecture-policy.mjs'

describe('normalized architecture ratchet', () => {
  it('counts findings by rule', () => {
    assert.deepEqual(findingCounts({ mutate: ['a:1', 'b:2'], runtime: [] }), { mutate: 2, runtime: 0 })
  })

  it('allows architectural debt to decrease', () => {
    assert.deepEqual(compareWithBaseline({ mutate: 2, runtime: 1 }, { mutate: 3, runtime: 1 }), [])
  })

  it('rejects new architectural debt', () => {
    assert.deepEqual(compareWithBaseline({ mutate: 4 }, { mutate: 3 }), ['mutate: 4 exceeds baseline 3'])
  })

  it('rejects an untracked rule', () => {
    assert.deepEqual(compareWithBaseline({ mutate: 1 }, {}), ['mutate: baseline missing'])
  })

  it('keeps the normalized candidate production closure free of legacy state patterns', async () => {
    const findings = await scanNormalizedArchitecture({
      cwd: process.cwd(),
      roots: normalizedCandidateRoots,
    })
    assert.deepEqual(findingCounts(findings), {
      'repository-mutate': 0,
      'runtime-state-table': 0,
      'runtime-state-type': 0,
      'operational-projection': 0,
      'global-mutation-tail': 0,
      'whole-store-cas': 0,
    })
  })
})
