import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('config templates use explicit integration modes without secrets', () => {
  const output = mkdtempSync(join(tmpdir(), 'mbox-runtime-config-'))
  execFileSync('npx', ['tsx', 'scripts/generate-normalized-runtime-config.ts', output], {
    cwd: new URL('..', import.meta.url),
  })
  const validation = readFileSync(join(output, 'validation.env.template'), 'utf8')
  const production = readFileSync(join(output, 'production.env.template'), 'utf8')
  const required = JSON.parse(readFileSync(join(output, 'required-fields.json'), 'utf8'))
  assert.match(validation, /MBOX_PAYMENT_MODE=disabled/)
  assert.doesNotMatch(validation, /POSTAR_AGENCY_ID=/)
  assert.match(production, /MBOX_PAYMENT_MODE=production/)
  assert.equal(required.configVersion, 'normalized-runtime-config/v1')
  assert.doesNotMatch(`${validation}${production}`, /sk-[A-Za-z0-9]/)
})
