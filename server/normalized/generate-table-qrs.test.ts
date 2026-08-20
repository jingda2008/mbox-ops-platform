import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TableQrProvisioner } from './table-qr-provisioner.js'
import {
  buildNormalizedTableQrEntries,
  generateNormalizedTableQrArtifacts,
} from './generate-table-qrs.js'

const scope = {
  tenantId: 'a1000000-0000-4000-8000-000000000001',
  storeId: 'a1000000-0000-4000-8000-000000000002',
}
const actorEmployeeId = 'a1000000-0000-4000-8000-000000000003'
const rawToken = 'N'.repeat(43)
const provisioned = [{
  tableId: 'a1000000-0000-4000-8000-000000000004',
  tableCode: 'L01',
  tableDisplayName: '互动01',
  qrVersion: 1,
  tableQrToken: rawToken,
}]

describe('normalized fixed table QR generation', () => {
  it('uses a 32-character opaque credential compatible with official WeChat scene limits', async () => {
    const run = vi.fn(async (_scope, command) => command({
      scope,
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{
          id: provisioned[0]!.tableId, code: 'L01', display_name: '互动01',
          qr_version: 1, active_credential_id: null,
        }] })
        .mockResolvedValue({ rows: [] }),
    }))
    const { TableQrProvisioner } = await import('./table-qr-provisioner.js')
    const result = await new TableQrProvisioner({ run }, 'S'.repeat(32)).provision({
      scope, businessDate: '2026-08-16', actorEmployeeId, tableCodes: ['L01'], reason: '正式小程序桌码',
    })
    expect(result[0]?.tableQrToken).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it('places the credential only in the URL fragment and keeps a harmless table hint in the query', () => {
    const [entry] = buildNormalizedTableQrEntries(provisioned, 'https://mbox.example/guest?channel=table')
    const url = new URL(entry!.url)

    expect(url.searchParams.get('table')).toBe('L01')
    expect(url.searchParams.get('channel')).toBe('table')
    expect(url.search).not.toContain(rawToken)
    expect(new URLSearchParams(url.hash.slice(1)).get('token')).toBe(rawToken)
    expect(entry!.tokenSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('writes a 0600 render manifest and a token-free audit manifest', async () => {
    const parent = await mkdtemp(resolve(tmpdir(), 'mbox-normalized-qr-'))
    const outputDirectory = resolve(parent, 'batch-001')
    const provision = vi.fn(async () => provisioned)

    const result = await generateNormalizedTableQrArtifacts({
      provisioner: { provision } as Pick<TableQrProvisioner, 'provision'>,
      scope,
      businessDate: '2026-08-11',
      actorEmployeeId,
      tableCodes: ['L01'],
      reason: '首次打印规范化固定桌码',
      guestBaseUrl: 'https://mbox.example/guest',
      outputDirectory,
      generatedAt: new Date('2026-08-11T12:00:00.000Z'),
    })

    const privateJson = await readFile(result.privateManifestPath, 'utf8')
    const auditJson = await readFile(result.auditManifestPath, 'utf8')
    expect(privateJson).toContain(rawToken)
    expect(privateJson).toContain('"legacyQrMigration": "disabled"')
    expect(auditJson).not.toContain(rawToken)
    expect(auditJson).not.toContain('https://')
    expect(auditJson).toMatch(/[0-9a-f]{64}/)
    expect((await stat(result.privateManifestPath)).mode & 0o777).toBe(0o600)
    expect((await stat(result.auditManifestPath)).mode & 0o777).toBe(0o600)
    expect((await stat(outputDirectory)).mode & 0o777).toBe(0o700)
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ rotateExisting: undefined }))
  })

  it('validates the URL and reserves a new output directory before provisioning', async () => {
    const parent = await mkdtemp(resolve(tmpdir(), 'mbox-normalized-qr-invalid-'))
    const provision = vi.fn(async () => provisioned)
    await expect(generateNormalizedTableQrArtifacts({
      provisioner: { provision } as Pick<TableQrProvisioner, 'provision'>,
      scope,
      businessDate: '2026-08-11',
      actorEmployeeId,
      tableCodes: ['L01'],
      reason: '首次打印规范化固定桌码',
      guestBaseUrl: 'https://user:password@mbox.example/guest',
      outputDirectory: resolve(parent, 'batch-002'),
    })).rejects.toThrow('不能包含账号或密码')
    expect(provision).not.toHaveBeenCalled()
  })

  it('never overwrites an existing batch directory or rotates codes implicitly', async () => {
    const parent = await mkdtemp(resolve(tmpdir(), 'mbox-normalized-qr-existing-'))
    const provision = vi.fn(async () => provisioned)
    await expect(generateNormalizedTableQrArtifacts({
      provisioner: { provision } as Pick<TableQrProvisioner, 'provision'>,
      scope,
      businessDate: '2026-08-11',
      actorEmployeeId,
      tableCodes: ['L01'],
      reason: '首次打印规范化固定桌码',
      guestBaseUrl: 'https://mbox.example/guest',
      outputDirectory: parent,
    })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(provision).not.toHaveBeenCalled()
  })
})
