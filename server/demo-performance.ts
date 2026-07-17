import { randomUUID } from 'node:crypto'
import type { RuntimeState } from '../src/shared/contracts.js'
import type { PerformanceSession, Singer, SingerRepertoireEntry, SongCatalogItem } from '../src/shared/song-contracts.js'

export const DEMO_PERFORMANCE_SESSION_ID = 'performance-demo-live'

const DEMO_SINGERS: Singer[] = [
  {
    id: 'singer-demo-lin-xiaoman',
    displayName: '林小满',
    actorId: 'singer-demo-lin-xiaoman',
    active: true,
    photoUrl: '/singers/lin-xiaoman.jpg',
    headline: '暖调女声 · 华语流行与轻爵士',
    bio: '林小满擅长用细腻、松弛的声线讲述一首歌。她喜欢从熟悉的华语旋律里加入一点轻爵士色彩，也很享受和台下客人自然聊天。今晚如果是生日、纪念日，或者只是想把一句话送给朋友，都可以告诉她。',
    styleTags: ['华语流行', '轻爵士', '温柔女声', '生日互动'],
  },
  {
    id: 'singer-demo-zhou-yichen',
    displayName: '周奕辰',
    actorId: 'singer-demo-zhou-yichen',
    active: true,
    photoUrl: '/singers/zhou-yichen.jpg',
    headline: '质感男声 · 城市民谣与经典摇滚',
    bio: '周奕辰的现场从克制的城市民谣慢慢升温到经典摇滚。声音有颗粒感，但聊天时轻松幽默，适合朋友聚会、合唱和临时起意的告白。下一轮他会带来几首大家熟悉、容易一起唱起来的作品。',
    styleTags: ['城市民谣', '经典摇滚', '合唱', '现场互动'],
  },
]

const DEMO_SONGS: SongCatalogItem[] = [
  { id: 'song-demo-lin-1', title: '后来（演示曲目）', artist: '刘若英', durationSeconds: 260, active: true },
  { id: 'song-demo-lin-2', title: '慢冷（演示曲目）', artist: '梁静茹', durationSeconds: 286, active: true },
  { id: 'song-demo-zhou-1', title: '成都（演示曲目）', artist: '赵雷', durationSeconds: 330, active: true },
  { id: 'song-demo-zhou-2', title: '海阔天空（演示曲目）', artist: 'Beyond', durationSeconds: 310, active: true },
]

const DEMO_REPERTOIRE: SingerRepertoireEntry[] = [
  { id: 'repertoire-demo-lin-1', singerId: 'singer-demo-lin-xiaoman', songId: 'song-demo-lin-1', priceAmount: 9800, currency: 'CNY', configVersion: 1, enabled: true },
  { id: 'repertoire-demo-lin-2', singerId: 'singer-demo-lin-xiaoman', songId: 'song-demo-lin-2', priceAmount: 9800, currency: 'CNY', configVersion: 1, enabled: true },
  { id: 'repertoire-demo-zhou-1', singerId: 'singer-demo-zhou-yichen', songId: 'song-demo-zhou-1', priceAmount: 12800, currency: 'CNY', configVersion: 1, enabled: true },
  { id: 'repertoire-demo-zhou-2', singerId: 'singer-demo-zhou-yichen', songId: 'song-demo-zhou-2', priceAmount: 12800, currency: 'CNY', configVersion: 1, enabled: true },
]

function upsertById<T extends { id: string }>(items: T[], next: T) {
  const index = items.findIndex((item) => item.id === next.id)
  if (index === -1) items.push(next)
  else items[index] = next
}

export function loadDemoPerformance(state: RuntimeState, now = new Date()) {
  const minute = 60_000
  const currentStartsAt = new Date(now.getTime() - 10 * minute)
  const currentEndsAt = new Date(now.getTime() + 35 * minute)
  const nextStartsAt = currentEndsAt
  const nextEndsAt = new Date(now.getTime() + 80 * minute)
  const session: PerformanceSession = {
    id: DEMO_PERFORMANCE_SESSION_ID,
    businessDate: state.store.businessDate,
    title: 'M-BOX 今晚现场（功能演示）',
    status: 'live',
    startsAt: new Date(now.getTime() - 30 * minute).toISOString(),
    endsAt: new Date(now.getTime() + 100 * minute).toISOString(),
    appearances: [
      {
        id: 'appearance-demo-lin-live',
        singerId: 'singer-demo-lin-xiaoman',
        startsAt: currentStartsAt.toISOString(),
        endsAt: currentEndsAt.toISOString(),
        requestOpensAt: new Date(now.getTime() - 20 * minute).toISOString(),
        requestClosesAt: new Date(now.getTime() + 30 * minute).toISOString(),
        acceptingRequests: true,
      },
      {
        id: 'appearance-demo-zhou-next',
        singerId: 'singer-demo-zhou-yichen',
        startsAt: nextStartsAt.toISOString(),
        endsAt: nextEndsAt.toISOString(),
        requestOpensAt: nextStartsAt.toISOString(),
        requestClosesAt: new Date(nextEndsAt.getTime() - 5 * minute).toISOString(),
        acceptingRequests: true,
      },
    ],
  }

  DEMO_SINGERS.forEach((singer) => upsertById(state.songState.singers, structuredClone(singer)))
  DEMO_SONGS.forEach((song) => upsertById(state.songState.songs, structuredClone(song)))
  DEMO_REPERTOIRE.forEach((entry) => upsertById(state.songState.repertoire, structuredClone(entry)))
  upsertById(state.songState.performanceSessions, session)
  state.songState.businessDate = state.store.businessDate
  state.auditEntries.unshift({
    id: randomUUID(),
    actorId: 'system-demo-loader',
    action: 'performance.demo_loaded.v1',
    objectType: 'performanceSession',
    objectId: session.id,
    occurredAt: now.toISOString(),
    details: {
      currentSingerId: session.appearances[0]?.singerId,
      nextSingerId: session.appearances[1]?.singerId,
      currentEndsAt: session.appearances[0]?.endsAt,
      nextStartsAt: session.appearances[1]?.startsAt,
    },
  })
  state.revision += 1
  return session
}
