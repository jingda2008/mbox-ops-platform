import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const scriptUrl = new URL('./run-normalized-postgres-tests.mjs', import.meta.url)

test('normalized PostgreSQL suite always uses an isolated disposable database', async () => {
  const source = await readFile(scriptUrl, 'utf8')
  assert.match(source, /CREATE DATABASE/)
  assert.match(source, /pg_terminate_backend/)
  assert.match(source, /DROP DATABASE IF EXISTS/)
  assert.match(source, /TEST_NORMALIZED_DATABASE_URL: databaseUrl/)
  assert.match(source, /--hookTimeout=30000/)
  assert.match(source, /if \(exitCode !== 0\) process\.exitCode = exitCode/)
  assert.doesNotMatch(source, /DROP SCHEMA\s+mbox/i)
})
