import { describe, expect, it } from 'vitest'
import type { GuestTaskView } from '../shared/guest-contracts'
import { formatGuestCompactCountdown, formatGuestCountdown, guestCustomSongServiceNote, guestErrorMessage, guestFeedbackIdempotencyKey, guestMoodServiceNote, guestReplyNotice, guestSongReplyNotice, guestSongStatusLabel, guestTaskReplyNotice, reconcileGuestReply, resolveGuestStage, trackGuestSongTerminalStates, visibleGuestSongRequests, visibleGuestTasks } from './guest-portal-utils'

function guestTask(status: GuestTaskView['status'], id = `task-${status}`): GuestTaskView {
  return {
    id,
    serviceTypeId: 'water',
    serviceTypeName: '加水',
    status,
    priority: 'normal',
    createdAt: '2026-07-16T20:00:00+08:00',
    updatedAt: '2026-07-16T20:00:00+08:00',
    customerReply: '已经收到',
    ownerName: null,
  }
}

describe('guest service progress', () => {
  it('hides terminal tasks while keeping completed tasks for guest confirmation', () => {
    const tasks = [
      guestTask('confirmed'),
      guestTask('completed'),
      guestTask('cancelled'),
      guestTask('accepted'),
    ]

    expect(visibleGuestTasks(tasks).map((task) => task.status)).toEqual(['completed', 'accepted'])
  })

  it('applies the display limit after terminal tasks are removed', () => {
    const tasks = [
      guestTask('confirmed', 'confirmed-1'),
      guestTask('cancelled', 'cancelled-1'),
      guestTask('pending', 'pending-1'),
      guestTask('accepted', 'accepted-1'),
    ]

    expect(visibleGuestTasks(tasks, 2).map((task) => task.id)).toEqual(['pending-1', 'accepted-1'])
  })
})

describe('guest task reply lifecycle', () => {
  it('keeps a reply while the refreshed task remains in the same state', () => {
    const task = guestTask('pending', 'task-1')
    const notice = guestTaskReplyNotice('正在安排', task)

    expect(reconcileGuestReply(notice, [task], [])).toBe(notice)
  })

  it('dismisses a reply as soon as refreshed task state advances', () => {
    const notice = guestTaskReplyNotice('正在安排', guestTask('pending', 'task-1'))

    expect(reconcileGuestReply(notice, [guestTask('accepted', 'task-1')], [])).toBeNull()
    expect(reconcileGuestReply(notice, [], [])).toBeNull()
  })

  it('dismisses a task reply when the same status has newer task data', () => {
    const task = guestTask('accepted', 'task-1')
    const notice = guestTaskReplyNotice('服务伙伴正在赶来', task)

    expect(reconcileGuestReply(notice, [{ ...task, updatedAt: '2026-07-16T20:01:00+08:00' }], [])).toBeNull()
  })

  it('leaves non-task replies for the fallback timeout or manual close', () => {
    const notice = guestReplyNotice('支付成功')

    expect(reconcileGuestReply(notice, [guestTask('accepted')], [])).toBe(notice)
  })

  it('dismisses a point-song reply when its refreshed status advances', () => {
    const notice = guestSongReplyNotice('已经递给歌手', { id: 'song-1', status: 'pending_confirmation' })

    expect(reconcileGuestReply(notice, [], [{ id: 'song-1', status: 'pending_confirmation' }])).toBe(notice)
    expect(reconcileGuestReply(notice, [], [{ id: 'song-1', status: 'pending_payment' }])).toBeNull()
  })
})

describe('guest song request progress', () => {
  it('provides guest-facing copy for confirmation, onsite payment, and performance states', () => {
    expect(guestSongStatusLabel('pending_confirmation')).toBe('待服务伙伴确认')
    expect(guestSongStatusLabel('pending_payment')).toBe('已确认 · 等待现场收费')
    expect(guestSongStatusLabel('paid')).toBe('现场已收款')
    expect(guestSongStatusLabel('accepted')).toBe('歌手已接单')
    expect(guestSongStatusLabel('performing')).toBe('正在演唱')
    expect(guestSongStatusLabel('completed')).toBe('演唱完成')
  })

  it('keeps active requests and briefly retains terminal requests from first observation', () => {
    const requests = [
      { id: 'song-active', status: 'accepted' },
      { id: 'song-complete', status: 'completed' },
    ]
    const seenAt = trackGuestSongTerminalStates({}, requests, 1_000)

    expect(visibleGuestSongRequests(requests, seenAt, 20_999, 20_000).map((item) => item.id)).toEqual(['song-active', 'song-complete'])
    expect(visibleGuestSongRequests(requests, seenAt, 21_000, 20_000).map((item) => item.id)).toEqual(['song-active'])
  })

  it('starts a fresh terminal window only when a request enters a terminal state', () => {
    const initial = trackGuestSongTerminalStates({}, [{ id: 'song-1', status: 'performing' }], 1_000)
    const completed = trackGuestSongTerminalStates(initial, [{ id: 'song-1', status: 'completed' }], 5_000)
    const refreshed = trackGuestSongTerminalStates(completed, [{ id: 'song-1', status: 'completed' }], 9_000)

    expect(initial).toEqual({})
    expect(completed).toEqual({ 'song-1': 5_000 })
    expect(refreshed).toEqual({ 'song-1': 5_000 })
  })
})

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

  it('uses a compact countdown inside the stage card', () => {
    expect(formatGuestCompactCountdown(28 * 60_000 + 11_000)).toBe('28:11')
    expect(formatGuestCompactCountdown(65 * 60_000)).toBe('1:05:00')
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
