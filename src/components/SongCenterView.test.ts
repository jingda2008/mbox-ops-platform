import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { scheduleDateFieldLabels } from './SongCenterView'
import { moveLocalDatetimeToBusinessDate } from './performance-schedule'

const scheduleStyles = readFileSync(new URL('./SongCenterView.css', import.meta.url), 'utf8')

describe('performance schedule editor presentation', () => {
  it('uses clear Chinese labels for every configurable time', () => {
    expect(scheduleDateFieldLabels).toEqual({
      startsAt: '演出开始',
      endsAt: '演出结束',
      requestOpensAt: '预约开放',
      requestClosesAt: '点歌截止',
    })
  })

  it('does not force a wide schedule table and stacks every field on narrow phones', () => {
    expect(scheduleStyles).not.toContain('.schedule-list { min-width: 900px; }')
    expect(scheduleStyles).toContain('.schedule-list { min-width: 0; }')
    expect(scheduleStyles).toMatch(/@media \(max-width: 520px\).*\.schedule-toolbar, \.schedule-fields \{ grid-template-columns: 1fr; \}/s)
  })

  it('moves every configured time with the business date and preserves cross-midnight offsets', () => {
    expect(moveLocalDatetimeToBusinessDate('2026-07-18T20:30', '2026-07-18', '2026-07-25')).toBe('2026-07-25T20:30')
    expect(moveLocalDatetimeToBusinessDate('2026-07-19T00:30', '2026-07-18', '2026-07-25')).toBe('2026-07-26T00:30')
  })

  it('provides an obvious schedule selector and new/copy actions', () => {
    expect(scheduleStyles).toContain('.schedule-manager-bar')
    expect(scheduleStyles).toContain('.schedule-manager-actions')
  })
})
