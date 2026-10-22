import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { reportCases, reconcileBrowserCoverage } from './normalized-browser-coverage.mjs'

const root = resolve('artifacts/normalized-browser-extended')
const active = resolve('artifacts/normalized-browser')
const specs = names => names.map(name => `tests/normalized-e2e/normalized-${name}.spec.ts`)
const groups = [
  { name: 'member-remaining', count: 12, flags: { MEMBER_CARDS: 'true', REQUIREMENTS_V9: 'true' }, files: specs(['member-cards', 'member-card-benefits', 'coupon-refund-review', 'marketing', 'requirements-v9', 'upgrade-qualification']) },
  // Legacy kitchen batches and the three-screen dispatch policy need different fixtures.
  { name: 'kitchen-batches', count: 5, flags: { KITCHEN: 'true' }, files: specs(['kitchen-batch']) },
  { name: 'three-screen-workflow', count: 1, flags: { KITCHEN: 'true', THREE_SCREEN: 'true' }, files: specs(['three-screen']) },
  { name: 'remake-handover', count: 1, flags: { REMAKE_HANDOVER: 'true' }, files: specs(['all-roles-business-day']), grep: '离店重做实物分份登记，最后一份丢回执仍可刷新恢复' },
]
mkdirSync(root, { recursive: true })
const reports = []
for (const group of groups) {
  const env = { ...process.env }
  for (const flag of ['MEMBER_CARDS', 'MEMBER_VISIT_REWARDS', 'REQUIREMENTS_V9', 'KITCHEN', 'THREE_SCREEN', 'REMAKE_HANDOVER', 'SERVICE_HISTORY']) delete env[`NORMALIZED_E2E_${flag}`]
  for (const [key, value] of Object.entries(group.flags)) env[`NORMALIZED_E2E_${key}`] = value
  rmSync(active, { recursive: true, force: true })
  const destination = resolve(root, group.name)
  rmSync(destination, { recursive: true, force: true })
  console.log(`Running ${group.name}: ${group.count} required cases on a fresh database`)
  const args = ['playwright', 'test', '--config', 'playwright.normalized.config.ts', ...group.files, ...(group.grep ? ['--grep', group.grep] : [])]
  const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { stdio: 'inherit', env })
  cpSync(active, destination, { recursive: true })
  if (result.error) throw result.error
  const report = JSON.parse(readFileSync(resolve(destination, 'report.json'), 'utf8'))
  const cases = reportCases(report)
  reports.push({ name: group.name, report })
  if (result.status !== 0 || cases.length !== group.count || cases.some(item => item.status !== 'expected')) {
    throw new Error(`${group.name} must pass all ${group.count} cases without skipped, flaky, or failed tests`)
  }
}
if (!process.argv.includes('--groups-only')) {
  const baseline = JSON.parse(readFileSync('artifacts/normalized-browser-baseline/report.json', 'utf8'))
  const dedicated = ['three-screen', 'member', 'service'].map(name => ({ name, report: JSON.parse(readFileSync(`artifacts/normalized-browser-${name}/report.json`, 'utf8')) }))
  const coverage = reconcileBrowserCoverage(baseline, [...dedicated, ...reports])
  writeFileSync(resolve(root, 'skip-coverage.json'), JSON.stringify(coverage, null, 2) + '\n')
  if (!coverage.passed) throw new Error(`Browser coverage incomplete: ${coverage.uncovered.length} uncovered skips, ${coverage.failed.length} failed/flaky cases`)
  console.log(`All ${coverage.baselineSkipped} baseline skips passed in dedicated fixture groups`)
}
