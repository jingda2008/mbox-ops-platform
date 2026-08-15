import test from 'node:test'
import assert from 'node:assert/strict'
import { scanImportClosure } from './normalized-import-closure.mjs'

test('normalized default entry cannot reach the legacy API or offline runtime', async () => {
  const closure = await scanImportClosure({ cwd: process.cwd(), entries: ['src/main.tsx'] })
  assert.equal(closure.files.includes('src/api.ts'), false)
  assert.equal(closure.files.includes('src/offline.ts'), false)
})
