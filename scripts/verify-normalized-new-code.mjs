import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { findingCounts, scanNormalizedArchitecture } from './normalized-architecture-policy.mjs'
import { scanImportClosure } from './normalized-import-closure.mjs'

const cwd = process.cwd()
const findings = await scanNormalizedArchitecture({ cwd, roots: ['server/normalized'] })
const counts = findingCounts(findings)
const errors = Object.entries(counts)
  .filter(([, count]) => count !== 0)
  .map(([rule, count]) => `${rule}: expected 0 in new normalized code, found ${count}`)

const frontendClosure = await scanImportClosure({ cwd, entries: ['src/main.tsx'] })
const forbiddenFrontendDependencies = ['src/api.ts', 'src/offline.ts']
for (const forbidden of forbiddenFrontendDependencies) {
  if (frontendClosure.files.includes(forbidden)) {
    const incoming = frontendClosure.edges.filter((edge) => edge.to === forbidden)
    errors.push(`${forbidden}: reachable from normalized default entry via ${incoming.map((edge) => edge.from).join(', ')}`)
  }
}

const migrationDirectory = resolve(cwd, 'database/normalized-migrations')
const migrationFiles = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.sql'))
const forbiddenMigrationIdentifiers = [
  'runtime_states',
  'runtime_state_versions',
  'operational_projection_checkpoints',
  'operational_tables',
  'operational_table_sessions',
  'operational_service_tasks',
  'operational_orders',
  'operational_order_items',
  'operational_kds_tasks',
  'operational_kds_task_events',
  'operational_payment_intents',
  'operational_inventory_balances',
]
for (const filename of migrationFiles) {
  const source = await readFile(resolve(migrationDirectory, filename), 'utf8')
  for (const forbidden of forbiddenMigrationIdentifiers) {
    if (new RegExp(`\\b${forbidden}\\b`).test(source)) {
      errors.push(`${filename}: forbidden schema dependency ${forbidden}`)
    }
  }
}

process.stdout.write(`${JSON.stringify({
  normalizedCodeCounts: counts,
  normalizedFrontendImportFiles: frontendClosure.files.length,
  forbiddenFrontendDependencies,
  migrationFiles: migrationFiles.length,
}, null, 2)}\n`)
if (errors.length) {
  process.stderr.write(`New normalized code gate failed:\n- ${errors.join('\n- ')}\n`)
  process.exitCode = 1
}
