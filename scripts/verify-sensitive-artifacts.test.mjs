import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectEvidenceDirectory } from './verify-sensitive-artifacts.mjs'

test('accepts checksums and bounded operational evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mbox-safe-evidence-'))
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ releaseSha: 'a'.repeat(40), status: 'passed' }))
  await writeFile(join(root, 'SHA256SUMS'), `${'b'.repeat(64)}  manifest.json\n`)
  await writeFile(join(root, 'verify-release.sh'), '#!/bin/sh\nset -eu\nprintf "verified\\n"\n')
  assert.deepEqual(await inspectEvidenceDirectory(root), [])
})

test('inspects shell scripts for credentials instead of rejecting the extension', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mbox-shell-evidence-'))
  await writeFile(join(root, 'deploy.sh'), `#!/bin/sh\nAPI_KEY=sk-${'x'.repeat(24)}\n`)
  const findings = await inspectEvidenceDirectory(root)
  assert.deepEqual(findings, [{ file: 'deploy.sh', rule: 'model-api-key', line: 2 }])
})

test('reports secret and privacy classes without echoing matched values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mbox-unsafe-evidence-'))
  await mkdir(join(root, 'nested'))
  await writeFile(join(root, 'nested', 'report.json'), JSON.stringify({
    requestBody: { mobile: '13800138000' },
    endpoint: 'postgresql://user:not-safe@db.example/mbox',
  }))
  const findings = await inspectEvidenceDirectory(root)
  assert.ok(findings.some((finding) => finding.rule === 'raw-mobile-number'))
  assert.ok(findings.some((finding) => finding.rule === 'database-password'))
  assert.ok(findings.some((finding) => finding.rule === 'forbidden-json-field'))
  assert.equal(JSON.stringify(findings).includes('13800138000'), false)
  assert.equal(JSON.stringify(findings).includes('not-safe'), false)
})

test('rejects credentials embedded in text and media that cannot be privacy-inspected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mbox-uninspectable-evidence-'))
  await writeFile(join(root, 'browser.log'), 'authorization:Bearer abcdefghijklmnopqrstuvwxyz123456\n')
  await writeFile(join(root, 'screenshot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await writeFile(join(root, 'runtime.env'), 'SAFE=true\n')
  const findings = await inspectEvidenceDirectory(root)
  assert.ok(findings.some((finding) => finding.rule === 'bearer-credential'))
  assert.equal(findings.filter((finding) => finding.rule === 'uninspectable-or-sensitive-artifact').length, 2)
  assert.equal(JSON.stringify(findings).includes('abcdefghijklmnopqrstuvwxyz123456'), false)
})

test('rejects unknown file types instead of silently skipping them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mbox-unknown-evidence-'))
  await writeFile(join(root, 'opaque.bin'), Buffer.from([0x00, 0x01, 0x02]))
  await writeFile(join(root, 'opaque'), Buffer.from([0x00, 0x01, 0x02]))
  await writeFile(join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]))
  const findings = await inspectEvidenceDirectory(root)
  assert.deepEqual(findings, [
    { file: 'invalid.txt', rule: 'invalid-text-encoding' },
    { file: 'opaque', rule: 'unapproved-artifact-extension' },
    { file: 'opaque.bin', rule: 'unapproved-artifact-extension' },
  ])
})
