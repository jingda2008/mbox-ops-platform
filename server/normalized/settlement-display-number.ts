import { createHash } from 'node:crypto'

/** OCR display reference only; the full business reference remains authoritative.
 * Stable inputs make source retries, pages and copies share the same number. */
export function settlementDisplayNumber(issuedAt: string, tenantId: string, storeId: string, sessionId: string): string {
  const instant = new Date(issuedAt)
  if (!Number.isFinite(instant.getTime())) throw new TypeError('结账开票时间无效')
  const shanghai = new Date(instant.getTime() + 8 * 60 * 60 * 1000).toISOString()
  const date = shanghai.slice(0, 10).replaceAll('-', '')
  const time = shanghai.slice(11, 19).replaceAll(':', '')
  const digest = createHash('sha256').update(JSON.stringify([tenantId, storeId, sessionId])).digest('hex')
  const suffix = (BigInt(`0x${digest}`) % 1_000_000n).toString().padStart(6, '0')
  return `${date}-${time}-${suffix}`
}
