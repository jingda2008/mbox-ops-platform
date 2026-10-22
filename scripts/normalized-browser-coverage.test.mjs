import assert from 'node:assert/strict'
import test from 'node:test'
import { reconcileBrowserCoverage } from './normalized-browser-coverage.mjs'
const report = rows => ({ suites: [{ suites: [{ file: 'a.spec.ts', specs: rows.map(([title, status, file = 'a.spec.ts']) => ({ title, file, tests: [{ status }] })) }] }] })
test('coverage fails when a skipped case has no successful dedicated result', () => {
  const baseline = report([['ready', 'expected'], ['optional', 'skipped']])
  for (const status of ['skipped', 'unexpected', 'flaky']) assert.equal(reconcileBrowserCoverage(baseline, [{ name: 'dedicated', report: report([['optional', status]]) }]).passed, false)
  assert.equal(reconcileBrowserCoverage(baseline, [{ name: 'dedicated', report: report([['optional', 'expected', 'other.spec.ts']]) }]).passed, false)
})
test('coverage maps every baseline skip to a passed fixture group and still rejects baseline failures', () => {
  const dedicated = [{ name: 'kitchen', report: report([['optional', 'expected']]) }]
  const result = reconcileBrowserCoverage(report([['optional', 'skipped']]), dedicated)
  assert.equal(result.passed, true); assert.equal(result.covered, 1); assert.deepEqual(result.skipped[0].passedIn, ['kitchen'])
  assert.equal(reconcileBrowserCoverage(report([['optional', 'skipped'], ['regression', 'unexpected']]), dedicated).passed, false)
})

test('empty reports cannot make the skipped-case gate green', () => {
  assert.equal(reconcileBrowserCoverage({}, []).passed, false)
  assert.equal(reconcileBrowserCoverage(report([['ready', 'expected']]), [{ name: 'empty', report: {} }]).passed, false)
})
