import type { JsonObject, JsonValue } from './command-executor.js'

const CHANNELS = ['guest_qr', 'staff_assisted', 'cashier', 'reservation', 'integration'] as const
const SCENES = ['date', 'brothers', 'besties', 'friends', 'business', 'celebration', 'unsure'] as const
const INTENTS = ['relaxed', 'energetic', 'ritual', 'unsure'] as const
const TASTES = ['refreshing', 'layered', 'strong', 'any'] as const
const DWELLS = ['one_set', 'stay_longer', 'no_rush'] as const

export interface ProductOperationalFields {
  displaySnapshot: JsonObject
  guestVisible: boolean
  searchText: string
  recommendationEnabled: boolean
  recommendationMinGuests: number
  recommendationMaxGuests: number
  recommendationPriority: number
  recommendationSceneTags: string[]
  recommendationIntentTags: string[]
  recommendationTasteTags: string[]
  recommendationDwellTags: string[]
  recommendationSingleWaveEligible: boolean
  recommendationExpectedPrepMinutes: number
  recommendationHoldMinutes: number
  recommendationUpgradeProductId: string | null
  menuSortOrder: number
  availableFrom: string | null
  availableUntil: string | null
  allowedChannels: string[]
  maxOrderQuantity: number
  kdsPriority: number
  fulfillmentSlaSeconds: number | null
  costAmountMinor: number | null
}

export function extractProductOperationalFields(
  snapshot: Readonly<JsonObject>,
  identity: Readonly<{ code: string; name: string }>,
): ProductOperationalFields {
  const source = objectValue(snapshot.source)
  const recommendation = objectValue(snapshot.recommendation)
  const minimum = integerValue(recommendation.minimumPartySize, 1, 200, 1, 'minimumPartySize')
  const maximum = integerValue(recommendation.maximumPartySize, 1, 200, 100, 'maximumPartySize')
  if (minimum > maximum) throw new TypeError('recommendation minimumPartySize must not exceed maximumPartySize')
  const searchText = stringValue(snapshot.searchText, 'product searchText')
    ?? [identity.code, identity.name, ...searchParts(snapshot), ...searchParts(source)]
      .join(' ').replace(/\s+/g, ' ').trim()
  if (searchText.length > 4000) throw new TypeError('product searchText is too long')
  const availableFrom = optionalTime(snapshot.availableFrom ?? source.availableFrom, 'availableFrom')
  const availableUntil = optionalTime(snapshot.availableUntil ?? source.availableUntil, 'availableUntil')
  if ((availableFrom === null) !== (availableUntil === null) || availableFrom === availableUntil && availableFrom !== null) {
    throw new TypeError('product availability start and end must be different and configured together')
  }
  return {
    displaySnapshot: stripOperationalFields(snapshot),
    guestVisible: snapshot.guestVisible !== false && source.guestVisible !== false,
    searchText,
    recommendationEnabled: recommendation.enabled === true,
    recommendationMinGuests: minimum,
    recommendationMaxGuests: maximum,
    recommendationPriority: integerValue(recommendation.priority, 0, 1000, 100, 'priority'),
    recommendationSceneTags: enumArray(recommendation.sceneTags, SCENES, 'recommendation sceneTags'),
    recommendationIntentTags: enumArray(recommendation.intentTags, INTENTS, 'recommendation intentTags'),
    recommendationTasteTags: enumArray(recommendation.tasteTags, TASTES, 'recommendation tasteTags'),
    recommendationDwellTags: enumArray(recommendation.dwellTags, DWELLS, 'recommendation dwellTags'),
    recommendationSingleWaveEligible: optionalBoolean(recommendation.singleWaveEligible, true, 'recommendation singleWaveEligible'),
    recommendationExpectedPrepMinutes: integerValue(recommendation.expectedPrepMinutes, 0, 240, 8, 'expectedPrepMinutes'),
    recommendationHoldMinutes: integerValue(recommendation.holdMinutes, 0, 240, 10, 'holdMinutes'),
    recommendationUpgradeProductId: optionalUuid(recommendation.upgradeProductId, 'recommendation upgradeProductId'),
    menuSortOrder: integerValue(snapshot.sortOrder ?? source.sortOrder, 0, 100_000, 999, 'sortOrder'),
    availableFrom,
    availableUntil,
    allowedChannels: enumArray(snapshot.allowedChannels ?? source.allowedChannels, CHANNELS, 'allowedChannels', [...CHANNELS]),
    maxOrderQuantity: integerValue(snapshot.maxOrderQuantity ?? source.maxOrderQuantity, 1, 9_999, 50, 'maxOrderQuantity'),
    kdsPriority: integerValue(snapshot.kdsPriority ?? source.kdsPriority, 0, 1_000, 100, 'kdsPriority'),
    fulfillmentSlaSeconds: nullableInteger(snapshot.fulfillmentSlaSeconds ?? source.fulfillmentSlaSeconds, 30, 14_400, 'fulfillmentSlaSeconds'),
    costAmountMinor: nullableMoney(snapshot.costAmount),
  }
}

export function hydrateProductSnapshot(
  snapshot: Readonly<JsonObject>,
  fields: Readonly<Omit<ProductOperationalFields, 'displaySnapshot'>>,
): JsonObject {
  const recommendation = objectValue(snapshot.recommendation)
  return {
    ...snapshot,
    guestVisible: fields.guestVisible,
    searchText: fields.searchText,
    sortOrder: fields.menuSortOrder,
    availableFrom: fields.availableFrom,
    availableUntil: fields.availableUntil,
    allowedChannels: fields.allowedChannels,
    maxOrderQuantity: fields.maxOrderQuantity,
    kdsPriority: fields.kdsPriority,
    fulfillmentSlaSeconds: fields.fulfillmentSlaSeconds,
    orderWindows: fields.availableFrom === null ? [] : [{
      days: [1, 2, 3, 4, 5, 6, 7], start: fields.availableFrom, end: fields.availableUntil,
    }],
    ...(fields.costAmountMinor === null ? {} : { costAmount: fields.costAmountMinor }),
    recommendation: {
      ...recommendation,
      enabled: fields.recommendationEnabled,
      minimumPartySize: fields.recommendationMinGuests,
      maximumPartySize: fields.recommendationMaxGuests,
      priority: fields.recommendationPriority,
      sceneTags: fields.recommendationSceneTags,
      intentTags: fields.recommendationIntentTags,
      tasteTags: fields.recommendationTasteTags,
      dwellTags: fields.recommendationDwellTags,
      singleWaveEligible: fields.recommendationSingleWaveEligible,
      expectedPrepMinutes: fields.recommendationExpectedPrepMinutes,
      holdMinutes: fields.recommendationHoldMinutes,
      upgradeProductId: fields.recommendationUpgradeProductId,
    },
  }
}

function stripOperationalFields(snapshot: Readonly<JsonObject>): JsonObject {
  const {
    guestVisible: _guestVisible, searchText: _searchText, costAmount: _costAmount,
    sortOrder: _sortOrder, availableFrom: _availableFrom, availableUntil: _availableUntil,
    allowedChannels: _allowedChannels, maxOrderQuantity: _maxOrderQuantity,
    kdsPriority: _kdsPriority, fulfillmentSlaSeconds: _fulfillmentSlaSeconds,
    orderWindows: _orderWindows, recommendation: rawRecommendation, source: rawSource, ...rest
  } = snapshot
  const {
    enabled: _enabled, minimumPartySize: _minimum, maximumPartySize: _maximum, priority: _priority,
    sceneTags: _sceneTags, intentTags: _intentTags, tasteTags: _tasteTags, dwellTags: _dwellTags,
    singleWaveEligible: _singleWave, expectedPrepMinutes: _prep, holdMinutes: _hold,
    upgradeProductId: _upgrade, ...displayRecommendation
  } = objectValue(rawRecommendation)
  const {
    guestVisible: _sourceVisible, searchText: _sourceSearch, costAmount: _sourceCost,
    sortOrder: _sourceSort, availableFrom: _sourceFrom, availableUntil: _sourceUntil,
    allowedChannels: _sourceChannels, maxOrderQuantity: _sourceMaximum,
    kdsPriority: _sourceKdsPriority, fulfillmentSlaSeconds: _sourceSla,
    orderWindows: _sourceOrderWindows, ...displaySource
  } = objectValue(rawSource)
  return {
    ...rest,
    ...(rawSource === undefined ? {} : { source: displaySource }),
    ...(rawRecommendation === undefined ? {} : { recommendation: displayRecommendation }),
  }
}

function searchParts(value: Readonly<JsonObject>): string[] {
  return ['aliases', 'pinyin', 'specification'].flatMap((key) => {
    const entry = value[key]
    if (typeof entry === 'string') return [entry]
    if (Array.isArray(entry)) return entry.filter((item): item is string => typeof item === 'string')
    return []
  })
}

function integerValue(value: JsonValue | undefined, minimum: number, maximum: number, fallback: number, label: string): number {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`product ${label} is invalid`)
  }
  return Number(value)
}

function nullableInteger(value: JsonValue | undefined, minimum: number, maximum: number, label: string): number | null {
  if (value === undefined || value === null) return null
  return integerValue(value, minimum, maximum, minimum, label)
}

function nullableMoney(value: JsonValue | undefined): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError('product costAmount is invalid')
  return Number(value)
}

function stringValue(value: JsonValue | undefined, label: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new TypeError(`${label} is invalid`)
  return value.trim()
}

function optionalTime(value: JsonValue | undefined, label: string): string | null {
  const text = stringValue(value, `product ${label}`)
  if (text === null || text === '') return null
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new TypeError(`product ${label} is invalid`)
  return text
}

function optionalBoolean(value: JsonValue | undefined, fallback: boolean, label: string): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${label} is invalid`)
  return value
}

function optionalUuid(value: JsonValue | undefined, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function enumArray<const Value extends string>(
  value: JsonValue | undefined,
  allowed: readonly Value[],
  label: string,
  fallback: Value[] = [],
): Value[] {
  if (value === undefined || value === null) return [...fallback]
  if (!Array.isArray(value) || value.length === 0 && fallback.length > 0
    || value.some((item) => typeof item !== 'string' || !allowed.includes(item as Value))) {
    throw new TypeError(`product ${label} is invalid`)
  }
  return [...new Set(value as Value[])]
}

function objectValue(value: JsonValue | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}
