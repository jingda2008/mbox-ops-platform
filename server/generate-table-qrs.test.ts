import { describe, expect, it } from 'vitest'
import { createSeedState } from './seed.js'
import { buildTableQrEntries } from './generate-table-qrs.js'
import { requireStaticTableQr, verifyTableAccessToken } from './table-access.js'

describe('table QR manifest', () => {
  it('creates one unique signed URL per configured table without putting tokens in the audit hash', () => {
    const secret = 'q'.repeat(32)
    const entries = buildTableQrEntries(createSeedState(), 'https://guest.example.com/guest', secret, 1_752_499_200_000)
    expect(entries).toHaveLength(createSeedState().tables.length)
    expect(new Set(entries.map((entry) => entry.url)).size).toBe(entries.length)
    const token = new URL(entries[0]!.url).searchParams.get('token')!
    expect(requireStaticTableQr(verifyTableAccessToken(token, secret))).toMatchObject({
      tokenType: 'table_qr',
      tableCode: entries[0]!.tableCode,
      tokenVersion: entries[0]!.tokenVersion,
    })
    expect(entries[0]!.tokenSha256).not.toContain(token)
  })
})
