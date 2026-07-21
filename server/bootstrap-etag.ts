import { createHash } from 'node:crypto'
import type { RuntimeState } from '../src/shared/contracts.js'

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value === null || typeof value !== 'object') return value

  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJson((value as Record<string, unknown>)[key])
  }
  return sorted
}

export function buildBootstrapViewEtag(state: RuntimeState): string {
  const { revision: _revision, presenceLeases: _presenceLeases, ...visibleState } = state
  const digest = createHash('sha256')
    .update(JSON.stringify(sortJson(visibleState)))
    .digest('base64url')
    .slice(0, 24)
  return `"view-${digest}"`
}
