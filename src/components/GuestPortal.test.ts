import { describe, expect, it } from 'vitest'
import { formatGuestCountdown, guestCustomSongServiceNote, guestErrorMessage, guestFeedbackIdempotencyKey, guestMoodServiceNote, resolveGuestStage } from './guest-portal-utils'

describe('guest feedback idempotency key', () => {
  it('stays within the API limit regardless of the service task ID length', () => {
    const first = guestFeedbackIdempotencyKey('confirm')
    const second = guestFeedbackIdempotencyKey('confirm')

    expect(first.length).toBeLessThanOrEqual(128)
    expect(first).toMatch(/^guest-feedback-confirm-/)
    expect(second).not.toBe(first)
  })
})

describe('guest mood service note', () => {
  it('turns a guest mood into an actionable note within the API limit', () => {
    const note = guestMoodServiceNote('微醺', '请主动补水，关注饮酒节奏和身体状态，避免继续强推酒水。')

    expect(note).toContain('客户心情反馈：微醺')
    expect(note).toContain('请主动补水')
    expect(note).toContain('服务专员')
    expect(note.length).toBeLessThanOrEqual(300)
  })

  it('marks a changed mood as the latest service signal', () => {
    const note = guestMoodServiceNote('安静', '请降低打扰频率。', '互动')

    expect(note).toContain('互动 → 安静')
    expect(note).toContain('以最新状态为准')
    expect(note.length).toBeLessThanOrEqual(300)
  })
})

describe('guest stage schedule', () => {
  const profile = { photoUrl: '', headline: '', bio: '', styleTags: [] }
  const schedule = [
    { performanceSessionId: 'p1', performanceTitle: '第一轮', appearanceId: 'a1', singerId: 's1', singerName: '天天', startsAt: '2026-07-16T20:30:00+08:00', endsAt: '2026-07-16T21:15:00+08:00', acceptingRequests: true, profile },
    { performanceSessionId: 'p1', performanceTitle: '第一轮', appearanceId: 'a2', singerId: 's2', singerName: '郑南', startsAt: '2026-07-16T21:35:00+08:00', endsAt: '2026-07-16T22:20:00+08:00', acceptingRequests: true, profile },
  ]

  it('shows the current and next singer while a set is live', () => {
    const stage = resolveGuestStage(schedule, Date.parse('2026-07-16T21:00:00+08:00'))
    expect(stage).toMatchObject({ mode: 'live', current: { singerName: '天天' }, next: { singerName: '郑南' } })
    expect(formatGuestCountdown(stage.countdownMs)).toBe('00:15:00')
  })

  it('counts down to the next singer during a changeover', () => {
    const stage = resolveGuestStage(schedule, Date.parse('2026-07-16T21:20:00+08:00'))
    expect(stage).toMatchObject({ mode: 'upcoming', current: null, next: { singerName: '郑南' } })
    expect(formatGuestCountdown(stage.countdownMs)).toBe('00:15:00')
  })
})

describe('custom song service note', () => {
  it('asks staff to confirm availability and price before collecting payment', () => {
    const note = guestCustomSongServiceNote({ title: '海阔天空', artist: 'Beyond', singerName: '郑南', customerNote: '送给今晚过生日的朋友' })
    expect(note).toContain('希望歌手：郑南')
    expect(note).toContain('确认前不要收款')
    expect(note.length).toBeLessThanOrEqual(300)
  })

  it('keeps the confirmation instruction when customer details are long', () => {
    const note = guestCustomSongServiceNote({ title: '歌'.repeat(80), artist: '原唱'.repeat(40), singerName: '歌手'.repeat(40), customerNote: '祝福'.repeat(80) })
    expect(note).toHaveLength(300)
    expect(note).toMatch(/确认前不要收款。$/)
  })
})

describe('guest-facing error copy', () => {
  it('turns browser network failures into a service-minded retry message', () => {
    expect(guestErrorMessage(new TypeError('Failed to fetch'), '稍后再试')).toContain('网络打了个盹')
  })

  it('preserves an already humanized server message', () => {
    expect(guestErrorMessage(new Error('这张桌子的服务还没接上，请招呼身边伙伴。'), '稍后再试')).toBe('这张桌子的服务还没接上，请招呼身边伙伴。')
  })
})
