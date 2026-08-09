import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('load harness waits until the requested database can execute a query', async () => {
  const source = await readFile(new URL('./run-local-rc68-load.sh', import.meta.url), 'utf8')
  assert.match(source, /psql -U mbox -d mbox_load -Atqc "SELECT 1"/)
  assert.doesNotMatch(source, /pg_isready -U mbox -d mbox_load/)
})
