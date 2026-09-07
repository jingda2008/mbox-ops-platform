import { createHash } from 'node:crypto'

export function storeConfigurationDigest(configBuffer) {
  return createHash('sha256').update(configBuffer).digest('hex')
}

export function verifyStoreConfigurationVersion({
  configBuffer,
  ledger,
  configPath = 'store configuration',
  ledgerPath = 'store configuration version ledger',
}) {
  const failures = []
  const config = JSON.parse(configBuffer.toString('utf8'))
  const entries = ledger.versions
  if (ledger.schemaVersion !== 1 || !Array.isArray(entries) || entries.length === 0) {
    return [`${ledgerPath} must contain a non-empty schemaVersion 1 ledger`]
  }
  const versions = entries.map((entry) => entry.version)
  if (new Set(versions).size !== versions.length) {
    return [`${ledgerPath} contains duplicate configuration versions`]
  }
  for (const entry of entries) {
    if (!/^\d{4}\.\d{2}\.\d{2}-v\d+$/.test(entry.version ?? '')
      || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) {
      return [`${ledgerPath} contains an invalid version or checksum`]
    }
  }
  const current = entries.find((entry) => entry.version === config.version)
  if (!current) {
    return [`${configPath} version ${config.version} is not appended to ${ledgerPath}`]
  }
  const digest = storeConfigurationDigest(configBuffer)
  if (current.sha256 !== digest) {
    failures.push(
      `${configPath} content changed without a new configuration version; expected ${current.sha256}, got ${digest}`,
    )
  }
  return failures
}
