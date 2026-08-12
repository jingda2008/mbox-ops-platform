import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

const productionRoots = ['server', 'src']
export const normalizedCandidateRoots = [
  'server/normalized',
  'server/normalized-server.ts',
  'server/migrate-normalized.ts',
  'server/provision-normalized-store.ts',
  'server/provision-normalized-catalog.ts',
  'server/verify-normalized-commercial-readiness.ts',
  'src/main.tsx',
  'src/normalized-api.ts',
  'src/normalized-ui',
  'src/shared/normalized-contracts.ts',
  'src/shared/order-contracts.ts',
  'src/shared/payment-contracts.ts',
  'src/shared/payment-provider-contracts.ts',
  'src/shared/postar-contracts.ts',
]
const ignoredSuffixes = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx']
const ignoredDirectories = new Set(['node_modules', 'dist', 'dist-server', 'coverage'])
const ignoredProductionFiles = new Set(['server/migrate-normalized.ts'])

export const normalizedArchitectureRules = [
  { id: 'repository-mutate', pattern: /\brepository\.mutate\s*\(/g },
  { id: 'runtime-state-table', pattern: /\bruntime_states\b/g },
  { id: 'runtime-state-type', pattern: /\bRuntimeState\b/g },
  { id: 'operational-projection', pattern: /\b(?:PostgresOperationalProjector|operational_projection_checkpoints)\b/g },
  { id: 'global-mutation-tail', pattern: /\bmutationTail\b/g },
  { id: 'whole-store-cas', pattern: /\bcompareAndSwapState\b/g },
]

async function sourceFiles(root, current = root) {
  const rootEntry = await stat(current)
  if (rootEntry.isFile()) {
    const relativePath = relative(process.cwd(), current)
    if (ignoredProductionFiles.has(relativePath)
      || ignoredSuffixes.some((suffix) => current.endsWith(suffix))
      || !['.ts', '.tsx', '.mjs'].includes(extname(current))) return []
    return [current]
  }
  const entries = await readdir(current, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    if (ignoredDirectories.has(entry.name)) return []
    const path = join(current, entry.name)
    if (entry.isDirectory()) return sourceFiles(root, path)
    if (ignoredProductionFiles.has(relative(process.cwd(), path))) return []
    if (!['.ts', '.tsx', '.mjs'].includes(extname(entry.name))) return []
    if (ignoredSuffixes.some((suffix) => entry.name.endsWith(suffix))) return []
    return [path]
  }))
  return nested.flat()
}

export async function scanNormalizedArchitecture({ cwd = process.cwd(), roots = productionRoots } = {}) {
  const findings = Object.fromEntries(normalizedArchitectureRules.map((rule) => [rule.id, []]))
  for (const productionRoot of roots) {
    for (const path of await sourceFiles(join(cwd, productionRoot))) {
      const source = await readFile(path, 'utf8')
      for (const rule of normalizedArchitectureRules) {
        const matches = [...source.matchAll(rule.pattern)]
        for (const match of matches) {
          const line = source.slice(0, match.index).split('\n').length
          findings[rule.id].push(`${relative(cwd, path)}:${line}`)
        }
      }
    }
  }
  return findings
}

export function findingCounts(findings) {
  return Object.fromEntries(Object.entries(findings).map(([rule, entries]) => [rule, entries.length]))
}

export function compareWithBaseline(counts, baseline) {
  return Object.entries(counts).flatMap(([rule, count]) => {
    const allowed = baseline[rule]
    if (!Number.isInteger(allowed)) return [`${rule}: baseline missing`]
    return count > allowed ? [`${rule}: ${count} exceeds baseline ${allowed}`] : []
  })
}
