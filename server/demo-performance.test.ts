import { describe, expect, it } from 'vitest'
import { resolveGuestStage } from '../src/components/guest-portal-utils.js'
import { createSeedState } from './seed.js'
import { DEMO_PERFORMANCE_SESSION_ID, loadDemoPerformance } from './demo-performance.js'

describe('demo performance fixture', () => {
  it('creates a current singer, a next singer, profiles, photos, and repertoire', () => {
    const now = new Date('2026-07-16T23:15:00+08:00')
    const state = createSeedState(now)
    const revision = state.revision

    const performance = loadDemoPerformance(state, now)
    const schedule = performance.appearances.map((appearance) => {
      const singer = state.songState.singers.find((item) => item.id === appearance.singerId)!
      return {
        performanceSessionId: performance.id,
        performanceTitle: performance.title,
        appearanceId: appearance.id,
        singerId: singer.id,
        singerName: singer.displayName,
        startsAt: appearance.startsAt,
        endsAt: appearance.endsAt,
        acceptingRequests: appearance.acceptingRequests,
        profile: {
          photoUrl: singer.photoUrl ?? '',
          headline: singer.headline ?? '',
          bio: singer.bio ?? '',
          styleTags: singer.styleTags ?? [],
        },
      }
    })
    const stage = resolveGuestStage(schedule, now.getTime())

    expect(performance.id).toBe(DEMO_PERFORMANCE_SESSION_ID)
    expect(stage).toMatchObject({ mode: 'live', current: { singerName: '林小满' }, next: { singerName: '周奕辰' } })
    expect(stage.countdownMs).toBe(35 * 60_000)
    expect(schedule[0]?.profile).toMatchObject({ photoUrl: '/singers/lin-xiaoman.jpg' })
    expect(schedule[0]?.profile.bio.length).toBeGreaterThan(60)
    expect(state.songState.repertoire.filter((item) => item.singerId === 'singer-demo-lin-xiaoman' && item.enabled)).toHaveLength(2)
    expect(state.revision).toBe(revision + 1)
  })

  it('updates the demo schedule without duplicating singer, song, repertoire, or session records', () => {
    const state = createSeedState(new Date('2026-07-16T23:00:00+08:00'))
    loadDemoPerformance(state, new Date('2026-07-16T23:15:00+08:00'))
    loadDemoPerformance(state, new Date('2026-07-16T23:20:00+08:00'))

    expect(state.songState.performanceSessions.filter((item) => item.id === DEMO_PERFORMANCE_SESSION_ID)).toHaveLength(1)
    expect(state.songState.singers.filter((item) => item.id.startsWith('singer-demo-'))).toHaveLength(2)
    expect(state.songState.songs.filter((item) => item.id.startsWith('song-demo-lin-') || item.id.startsWith('song-demo-zhou-'))).toHaveLength(4)
    expect(state.songState.repertoire.filter((item) => item.id.startsWith('repertoire-demo-'))).toHaveLength(4)
  })
})
