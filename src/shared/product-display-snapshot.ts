export const PRODUCT_SNAPSHOT_TOP_LEVEL_OPERATIONAL_KEYS = [
  'guestVisible',
  'searchText',
  'sortOrder',
  'availableFrom',
  'availableUntil',
  'allowedChannels',
  'maxOrderQuantity',
  'kdsPriority',
  'fulfillmentSlaSeconds',
  'costAmount',
  'orderWindows',
] as const

export const PRODUCT_SNAPSHOT_NESTED_OPERATIONAL_KEYS = [
  'enabled',
  'minimumPartySize',
  'maximumPartySize',
  'priority',
  'sceneTags',
  'intentTags',
  'tasteTags',
  'dwellTags',
  'singleWaveEligible',
  'expectedPrepMinutes',
  'holdMinutes',
  'upgradeProductId',
] as const

const topLevelOperationalKeys = new Set<string>(PRODUCT_SNAPSHOT_TOP_LEVEL_OPERATIONAL_KEYS)
const nestedOperationalKeys = new Set<string>([
  ...PRODUCT_SNAPSHOT_TOP_LEVEL_OPERATIONAL_KEYS,
  ...PRODUCT_SNAPSHOT_NESTED_OPERATIONAL_KEYS,
])

/**
 * Old catalog rows may still contain operational values in product_snapshot.
 * Keep display metadata while ensuring clients can safely round-trip the
 * snapshot through the current typed catalog contract.
 */
export function sanitizeProductDisplaySnapshot(
  snapshot: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const sanitized = Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => !topLevelOperationalKeys.has(key)),
  )

  for (const key of ['recommendation', 'source'] as const) {
    const nested = sanitized[key]
    if (!isRecord(nested)) continue
    sanitized[key] = Object.fromEntries(
      Object.entries(nested).filter(([entry]) => !nestedOperationalKeys.has(entry)),
    )
  }

  return sanitized
}

export function productDisplaySnapshotHasOperationalFields(
  snapshot: Readonly<Record<string, unknown>>,
): boolean {
  if (Object.keys(snapshot).some((key) => topLevelOperationalKeys.has(key))) return true
  return ['recommendation', 'source'].some((key) => {
    const nested = snapshot[key]
    return isRecord(nested) && Object.keys(nested).some((entry) => nestedOperationalKeys.has(entry))
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
