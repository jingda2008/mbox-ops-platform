import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { renderAlipayTableMiniCodes } from './render-alipay-table-mini-codes.js'

describe('Alipay table mini-program code rendering', () => {
  it('renders from the protected private manifest without exposing raw tokens in audit output', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'mbox-alipay-table-codes-'))
    const privateManifestPath = resolve(root, 'table-qrs.private.json')
    const token = 'T'.repeat(32)
    await writeFile(privateManifestPath, JSON.stringify({
      format: 'mbox.normalized-fixed-table-qr.v1', entries: [{
        tableId: 'a1000000-0000-4000-8000-000000000004', tableCode: 'L01',
        tableDisplayName: '互动01', qrVersion: 2, tokenSha256: 'a'.repeat(64),
        url: `https://mbox.example/guest?table=L01#token=${token}`,
      }],
    }), { mode: 0o600 })
    await chmod(privateManifestPath, 0o600)
    const render = vi.fn(async () => Buffer.alloc(256, 9))
    const result = await renderAlipayTableMiniCodes({
      privateManifestPath,
      outputDirectory: resolve(root, 'official'),
      provider: { render },
      appId: '2021006196615276',
      page: 'pages/order/index',
      renderedAt: new Date('2026-09-04T10:00:00.000Z'),
    })
    expect(render).toHaveBeenCalledWith({
      appId: '2021006196615276',
      page: 'pages/order/index',
      query: `token=${token}`,
      width: 430,
    })
    const audit = await readFile(result.auditManifestPath, 'utf8')
    expect(audit).not.toContain(token)
    expect(audit).toContain('mbox.official-alipay-table-mini-codes.v1')
    expect(JSON.parse(audit).entries[0].imageSha256).toMatch(/^[0-9a-f]{64}$/)
    if (process.platform !== 'win32') {
      expect((await stat(resolve(root, 'official/L01.alipay-mini-code.png'))).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects empty tokens instead of producing a misleading Alipay code', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'mbox-alipay-table-codes-old-'))
    const privateManifestPath = resolve(root, 'table-qrs.private.json')
    await writeFile(privateManifestPath, JSON.stringify({
      format: 'mbox.normalized-fixed-table-qr.v1', entries: [{
        tableId: 'a1000000-0000-4000-8000-000000000004', tableCode: 'L01',
        tableDisplayName: '互动01', qrVersion: 1, tokenSha256: 'b'.repeat(64),
        url: 'https://mbox.example/guest',
      }],
    }), { mode: 0o600 })
    await chmod(privateManifestPath, 0o600)
    await expect(renderAlipayTableMiniCodes({
      privateManifestPath,
      outputDirectory: resolve(root, 'official'),
      provider: { render: vi.fn() },
      appId: '2021006196615276',
      page: 'pages/order/index',
    })).rejects.toThrow('必须明确轮换')
  })
})
