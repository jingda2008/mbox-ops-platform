import assert from 'node:assert/strict'
import test from 'node:test'
import { loadMiniModule } from './load-miniprogram-test-module.mjs'
import { readFile } from 'node:fs/promises'
const { currentActivities, activityTimeText } = loadMiniModule(new URL('../miniprogram/utils/activity-display.js', import.meta.url))
const now = Date.parse('2026-09-08T12:00:00+08:00')
const active = { startsAt:'2026-09-05 03:00:00+08', endsAt:'2026-09-09 03:00:00+08', status:'published', title:'退款测试' }

test('activity display uses end time, never title or past start to hide ongoing events', () => {
  assert.deepEqual(currentActivities([active], now), [active])
  assert.match(activityTimeText(active, now), /^进行中 · 至 /)
  assert.match(activityTimeText({...active, startsAt:'2026-09-09T01:00:00+08:00'}, now), / 开始$/)
})
test('expired, exact-boundary, malformed and unpublished activities are not advertised', () => {
  for (const patch of [{endsAt:'2026-09-08T11:59:59+08:00'}, {endsAt:'2026-09-08T12:00:00+08:00'}, {endsAt:'bad'}, {endsAt:null}, {status:'cancelled'}, {status:'draft'}]) {
    assert.deepEqual(currentActivities([{...active,...patch}], now), [])
  }
  assert.equal(currentActivities(null, now).length, 0)
  assert.equal(currentActivities([{...active,status:'full'}], now).length, 1)
})
test('bundle sheet reserves footer and keeps full names and two-column choices on narrow screens', async () => {
  const css=await readFile(new URL('../miniprogram/pages/order/index.wxss',import.meta.url),'utf8')
  assert.match(css,/\.product-detail-scroll\s*\{[^}]*height: 0;[^}]*min-height: 0;[^}]*flex: 1 1 60vh;/)
  assert.match(css,/\.product-detail-footer\s*\{[^}]*flex: 0 0 auto;/)
  const name=css.match(/\.product-detail-choice view text:first-child\s*\{([^}]+)\}/)[1]
  assert.match(name,/white-space:normal/)
  assert.doesNotMatch(name,/ellipsis|nowrap|overflow:hidden/)
  assert.doesNotMatch(css,/\.product-detail-choice-options\s*\{\s*grid-template-columns:\s*1fr;/)
})
