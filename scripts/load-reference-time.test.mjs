import assert from 'node:assert/strict'
import test from 'node:test'
import { loadReferenceTime } from './load-reference-time.mjs'

test('uses the current Shanghai business date after the 06:00 boundary', () => {
  assert.equal(loadReferenceTime(new Date('2026-08-09T12:00:00.000Z')), '2026-08-09T12:00:00.000Z')
})

test('keeps the previous business date before the 06:00 boundary', () => {
  assert.equal(loadReferenceTime(new Date('2026-08-09T21:59:59.000Z')), '2026-08-09T12:00:00.000Z')
  assert.equal(loadReferenceTime(new Date('2026-08-09T22:00:00.000Z')), '2026-08-10T12:00:00.000Z')
})
