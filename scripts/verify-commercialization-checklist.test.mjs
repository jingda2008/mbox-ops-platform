import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { verifyChecklist } from './verify-commercialization-checklist.mjs'
test('preserves complete readable historical records and fails on truncation or corrupt encoding', async () => {
  const bytes = await readFile('docs/commercialization-pending-checklist.md')
  assert.equal(verifyChecklist(bytes).verified, true)
  const text = bytes.toString('utf8')
  assert.throws(() => verifyChecklist(Buffer.from(text.replaceAll('SYS-242', 'REMOVED-242'))), /丢失历史/)
  assert.throws(() => verifyChecklist(Buffer.from(text + '\uFFFD')), /乱码/)
  assert.throws(() => verifyChecklist(Buffer.from([0xff, 0xfe])))
})
