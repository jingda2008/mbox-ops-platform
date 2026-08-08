import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { createSeedState } from './seed.js'
import { buildTableQrEntries, generateTableQrFiles } from './generate-table-qrs.js'
import { requireStaticTableQr, verifyTableAccessToken } from './table-access.js'

describe('table QR manifest', () => {
  it('creates one unique signed URL per configured table without putting tokens in the audit hash', () => {
    const secret = 'q'.repeat(32)
    const entries = buildTableQrEntries(createSeedState(), 'https://guest.example.com/guest', secret, 1_752_499_200_000)
    expect(entries).toHaveLength(createSeedState().tables.length)
    expect(new Set(entries.map((entry) => entry.url)).size).toBe(entries.length)
    const entryUrl = new URL(entries[0]!.url)
    const token = new URLSearchParams(entryUrl.hash.slice(1)).get('token')!
    expect(entryUrl.searchParams.get('table')).toBe(entries[0]!.tableCode)
    expect(entryUrl.searchParams.has('token')).toBe(false)
    expect(requireStaticTableQr(verifyTableAccessToken(token, secret))).toMatchObject({
      tokenType: 'table_qr',
      tableCode: entries[0]!.tableCode,
      tokenVersion: entries[0]!.tokenVersion,
    })
    expect(entries[0]!.tokenSha256).not.toContain(token)
  })

  it('renders a print-safe QR card with a visible table label and auditable format', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mbox-table-qr-'))
    try {
      const entry = buildTableQrEntries(
        createSeedState(),
        'https://guest.example.com/guest',
        'q'.repeat(32),
        1_752_499_200_000,
      ).find((candidate) => candidate.tableCode === 'L01')!

      await generateTableQrFiles([entry], directory)

      const card = PNG.sync.read(await readFile(join(directory, 'L01.png')))
      expect(card).toMatchObject({ width: 1024, height: 1240 })
      expect(await readFile(join(directory, 'audit.csv'), 'utf8')).toContain(
        '"L01","休闲01","L01","1",',
      )
      expect(await readFile(join(directory, 'audit.csv'), 'utf8')).toContain('"labeled_png_v2"')
    } finally {
      await rm(directory, { recursive: true })
    }
  })
})
