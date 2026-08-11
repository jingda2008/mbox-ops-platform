import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { findingCounts, scanNormalizedArchitecture } from './normalized-architecture-policy.mjs'

const cwd = process.cwd()
const findings = await scanNormalizedArchitecture({ cwd, roots: ['server/normalized'] })
const counts = findingCounts(findings)
const errors = Object.entries(counts)
  .filter(([, count]) => count !== 0)
  .map(([rule, count]) => `${rule}: expected 0 in new normalized code, found ${count}`)

const migrationDirectory = resolve(cwd, 'database/normalized-migrations')
const migrationFiles = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.sql'))
for (const filename of migrationFiles) {
  const source = await readFile(resolve(migrationDirectory, filename), 'utf8')
  for (const forbidden of ['runtime_states', 'runtime_state_versions', 'operational_']) {
    if (source.includes(forbidden)) errors.push(`${filename}: forbidden schema dependency ${forbidden}`)
  }
}

process.stdout.write(`${JSON.stringify({ normalizedCodeCounts: counts, migrationFiles: migrationFiles.length }, null, 2)}\n`)
if (errors.length) {
  process.stderr.write(`New normalized code gate failed:\n- ${errors.join('\n- ')}\n`)
  process.exitCode = 1
}
