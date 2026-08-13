export const NORMALIZED_RUNTIME_CONFIG_VERSION = 'normalized-runtime-config/v1'

export const LEGACY_NORMALIZED_CONFIG_FIELDS = Object.freeze([
  'DEPLOYMENT_TIER',
  'MBOX_POSTAR_ENABLED',
  'MBOX_POSTAR_ENVIRONMENT',
  'MBOX_POSTAR_AGENCY_ID',
  'MBOX_POSTAR_MERCHANT_ID',
  'MBOX_POSTAR_PUBLIC_KEY',
  'MBOX_POSTAR_CALLBACK_URL',
  'MBOX_POSTAR_HTTP_TIMEOUT_MS',
] as const)

export type IntegrationMode = 'disabled' | 'test' | 'uat' | 'production'

export interface NormalizedIntegrationModes {
  payment: IntegrationMode
  ai: IntegrationMode
  printing: IntegrationMode
  headset: IntegrationMode
}

export interface NormalizedIntegrationContract {
  modes: Readonly<NormalizedIntegrationModes>
  ai: null | Readonly<{
    provider: 'qwen'
    endpoint: string
    model: string
    apiKey: string
  }>
  printingEndpoint: string | null
  headsetEndpoint: string | null
}

export function readNormalizedIntegrationContract(
  environment: Readonly<Record<string, string | undefined>>,
  nodeEnv: 'development' | 'test' | 'production',
  deploymentTier: 'validation' | 'production',
  errors: string[],
): NormalizedIntegrationContract {
  const configVersion = clean(environment.MBOX_RUNTIME_CONFIG_VERSION)
  if (nodeEnv === 'production' && configVersion !== NORMALIZED_RUNTIME_CONFIG_VERSION) {
    errors.push('MBOX_RUNTIME_CONFIG_VERSION')
  } else if (configVersion !== null && configVersion !== NORMALIZED_RUNTIME_CONFIG_VERSION) {
    errors.push('MBOX_RUNTIME_CONFIG_VERSION')
  }

  for (const field of LEGACY_NORMALIZED_CONFIG_FIELDS) {
    if (clean(environment[field]) !== null) errors.push(field)
  }

  const modes = Object.freeze({
    payment: readMode(environment.MBOX_PAYMENT_MODE, 'MBOX_PAYMENT_MODE', nodeEnv, deploymentTier, errors),
    ai: readMode(environment.MBOX_AI_MODE, 'MBOX_AI_MODE', nodeEnv, deploymentTier, errors),
    printing: readMode(environment.MBOX_PRINT_MODE, 'MBOX_PRINT_MODE', nodeEnv, deploymentTier, errors),
    headset: readMode(environment.MBOX_HEADSET_MODE, 'MBOX_HEADSET_MODE', nodeEnv, deploymentTier, errors),
  })

  const aiProvider = clean(environment.MBOX_AI_PROVIDER)
  const aiEndpoint = clean(environment.MBOX_AI_ENDPOINT)
  const aiModel = clean(environment.MBOX_AI_MODEL)
  const aiApiKey = clean(environment.MBOX_AI_API_KEY)
  let ai: NormalizedIntegrationContract['ai'] = null
  if (modes.ai !== 'disabled') {
    if (aiProvider !== 'qwen') errors.push('MBOX_AI_PROVIDER')
    if (!isHttpsUrl(aiEndpoint)) errors.push('MBOX_AI_ENDPOINT')
    if (aiModel === null) errors.push('MBOX_AI_MODEL')
    if (aiApiKey === null || aiApiKey.length < 16) errors.push('MBOX_AI_API_KEY')
    if (aiProvider === 'qwen' && isHttpsUrl(aiEndpoint) && aiModel !== null && aiApiKey !== null) {
      ai = Object.freeze({ provider: aiProvider, endpoint: aiEndpoint, model: aiModel, apiKey: aiApiKey })
    }
  } else if ([aiProvider, aiEndpoint, aiModel, aiApiKey].some((value) => value !== null)) {
    errors.push('MBOX_AI_MODE')
  }

  const printingEndpoint = readOptionalIntegrationEndpoint(
    modes.printing,
    environment.MBOX_PRINT_ENDPOINT,
    'MBOX_PRINT_ENDPOINT',
    errors,
  )
  const headsetEndpoint = readOptionalIntegrationEndpoint(
    modes.headset,
    environment.MBOX_HEADSET_ENDPOINT,
    'MBOX_HEADSET_ENDPOINT',
    errors,
  )

  return Object.freeze({ modes, ai, printingEndpoint, headsetEndpoint })
}

function readMode(
  value: string | undefined,
  field: string,
  nodeEnv: 'development' | 'test' | 'production',
  deploymentTier: 'validation' | 'production',
  errors: string[],
): IntegrationMode {
  const normalized = clean(value)
  if (normalized === null && nodeEnv !== 'production') return 'disabled'
  if (normalized !== 'disabled' && normalized !== 'test' && normalized !== 'uat' && normalized !== 'production') {
    errors.push(field)
    return 'disabled'
  }
  if (deploymentTier === 'production' && normalized === 'test') errors.push(field)
  if (deploymentTier === 'validation' && normalized === 'production') errors.push(field)
  return normalized
}

function readOptionalIntegrationEndpoint(
  mode: IntegrationMode,
  value: string | undefined,
  field: string,
  errors: string[],
) {
  const endpoint = clean(value)
  if (mode === 'disabled') {
    if (endpoint !== null) errors.push(field)
    return null
  }
  if (!isHttpsUrl(endpoint)) errors.push(field)
  return isHttpsUrl(endpoint) ? endpoint : null
}

function clean(value: string | undefined) {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function isHttpsUrl(value: string | null): value is string {
  if (value === null) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
