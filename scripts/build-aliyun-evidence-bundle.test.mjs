import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEvidenceBundle } from './build-aliyun-evidence-bundle.mjs'

test('builds a commit-scoped evidence bundle with a self-verifiable checksum ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mbox-evidence-bundle-'))
  const output = join(root, 'sealed')
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(join(source, 'result.json'), JSON.stringify({ status: 'passed' }))
  const result = await buildEvidenceBundle({
    output,
    channel: 'rc',
    releaseVersion: '1.0.0-rc.69',
    releaseSha: 'a'.repeat(40),
    ciRunId: '1234',
    inputs: [`quality=${source}`],
  })
  assert.equal(result.manifest.releaseSha, 'a'.repeat(40))
  const ledger = await readFile(join(output, 'SHA256SUMS'), 'utf8')
  assert.match(ledger, /manifest\.json/)
  assert.match(ledger, /quality\/result\.json/)
})

test('refuses evidence sources that contain customer privacy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mbox-evidence-private-'))
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(join(source, 'failure.json'), JSON.stringify({ phoneNumber: '13800138000' }))
  await assert.rejects(() => buildEvidenceBundle({
    output: join(root, 'sealed'), channel: 'temp', releaseVersion: '1.0.0', releaseSha: 'b'.repeat(40),
    inputs: [`runtime=${source}`],
  }), /sensitive or invalid/)
})
