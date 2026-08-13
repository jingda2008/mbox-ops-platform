import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectReleaseEvidenceEligibility } from './release-evidence-eligibility.mjs'

const sha = 'a'.repeat(40)

test('accepts only a clean worktree whose HEAD matches the evidence SHA', () => {
  const result = inspectReleaseEvidenceEligibility(sha, {
    runGit(args) {
      if (args[0] === 'rev-parse') return sha
      if (args[0] === 'status') return ''
      throw new Error('unexpected git command')
    },
  })
  assert.deepEqual(result, {
    eligible: true,
    reason: 'clean_worktree_matches_source_commit',
    headSha: sha,
  })
})

test('rejects a dirty worktree even when the supplied SHA matches HEAD', () => {
  const result = inspectReleaseEvidenceEligibility(sha, {
    runGit(args) {
      if (args[0] === 'rev-parse') return sha
      if (args[0] === 'status') return ' M server/example.ts'
      throw new Error('unexpected git command')
    },
  })
  assert.equal(result.eligible, false)
  assert.equal(result.reason, 'worktree_has_uncommitted_changes')
})

test('rejects a SHA that does not match the checked-out commit', () => {
  const result = inspectReleaseEvidenceEligibility(sha, {
    runGit(args) {
      if (args[0] === 'rev-parse') return 'b'.repeat(40)
      return ''
    },
  })
  assert.equal(result.eligible, false)
  assert.equal(result.reason, 'source_commit_sha_does_not_match_worktree_head')
})

test('rejects shortened or descriptive commit identifiers', () => {
  assert.equal(inspectReleaseEvidenceEligibility('worktree-diagnostic').eligible, false)
  assert.equal(inspectReleaseEvidenceEligibility('abc1234').eligible, false)
})
