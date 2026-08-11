import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  compareWithBaseline,
  findingCounts,
  normalizedCandidateRoots,
  scanNormalizedArchitecture,
} from './normalized-architecture-policy.mjs'

const cwd = process.cwd()
const requireZero = process.argv.includes('--require-zero')
const findings = await scanNormalizedArchitecture({
  cwd,
  ...(requireZero ? { roots: normalizedCandidateRoots } : {}),
})
const counts = findingCounts(findings)
const baseline = JSON.parse(await readFile(resolve(cwd, 'docs/architecture/normalized-dependency-baseline.json'), 'utf8'))
const errors = requireZero
  ? Object.entries(counts).filter(([, count]) => count !== 0).map(([rule, count]) => `${rule}: expected 0, found ${count}`)
  : compareWithBaseline(counts, baseline)

process.stdout.write(`${JSON.stringify({
  mode: requireZero ? 'zero' : 'ratchet',
  scope: requireZero ? 'normalized-candidate-production' : 'whole-repository-legacy-ratchet',
  counts,
}, null, 2)}\n`)
if (errors.length) {
  process.stderr.write(`Normalized architecture gate failed:\n- ${errors.join('\n- ')}\n`)
  process.exitCode = 1
}
