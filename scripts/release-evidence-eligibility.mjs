import { execFileSync } from 'node:child_process'

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i

export function inspectReleaseEvidenceEligibility(sourceCommitSha, options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const runGit = options.runGit ?? ((args) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim())

  if (!FULL_COMMIT_SHA.test(sourceCommitSha ?? '')) {
    return { eligible: false, reason: 'source_commit_sha_must_be_full_40_character_sha' }
  }

  try {
    const headSha = runGit(['rev-parse', 'HEAD']).toLowerCase()
    if (headSha !== sourceCommitSha.toLowerCase()) {
      return { eligible: false, reason: 'source_commit_sha_does_not_match_worktree_head', headSha }
    }
    const changes = runGit(['status', '--porcelain', '--untracked-files=all'])
    if (changes.length > 0) {
      return { eligible: false, reason: 'worktree_has_uncommitted_changes', headSha }
    }
    return { eligible: true, reason: 'clean_worktree_matches_source_commit', headSha }
  } catch {
    return { eligible: false, reason: 'git_state_could_not_be_verified' }
  }
}

export function currentGitCommitSha(options = {}) {
  const cwd = options.cwd ?? process.cwd()
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
