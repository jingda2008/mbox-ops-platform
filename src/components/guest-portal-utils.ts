import type { GuestSessionResponse } from '../shared/guest-contracts'

export function guestFeedbackIdempotencyKey(action: 'confirm' | 'unresolved') {
  return `guest-feedback-${action}-${crypto.randomUUID()}`
}

export function resolveGuestStage(schedule: GuestSessionResponse['stageSchedule'], now: number) {
  const ordered = schedule.toSorted((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt))
  const current = ordered.find((appearance) => Date.parse(appearance.startsAt) <= now && now < Date.parse(appearance.endsAt)) ?? null
  const next = ordered.find((appearance) => Date.parse(appearance.startsAt) > now) ?? null
  if (current) return { mode: 'live' as const, current, next, countdownMs: Math.max(0, Date.parse(current.endsAt) - now) }
  if (next) return { mode: 'upcoming' as const, current: null, next, countdownMs: Math.max(0, Date.parse(next.startsAt) - now) }
  return { mode: ordered.length > 0 ? 'finished' as const : 'idle' as const, current: null, next: null, countdownMs: 0 }
}

export function formatGuestCountdown(durationMs: number) {
  const totalSeconds = Math.max(0, Math.ceil(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
}

export function guestMoodServiceNote(label: string, care: string, previousLabel = '') {
  const state = previousLabel && previousLabel !== label
    ? `客户心情更新：${previousLabel} → ${label}，请以最新状态为准。`
    : `客户心情反馈：${label}。`
  return `${state}关怀建议：${care} 请服务专员选择合适时机到桌关注。`
}

export function guestCustomSongServiceNote(input: { title: string; artist: string; singerName: string; customerNote: string }) {
  const parts = [`自定义点歌申请：${input.title.trim()}`]
  if (input.artist.trim()) parts.push(`原唱：${input.artist.trim()}`)
  if (input.singerName.trim()) parts.push(`希望歌手：${input.singerName.trim()}`)
  if (input.customerNote.trim()) parts.push(`客人补充：${input.customerNote.trim()}`)
  const confirmation = '。请服务员确认歌手能否演唱、价格和预计安排时间，确认前不要收款。'
  return `${parts.join('；').slice(0, 300 - confirmation.length)}${confirmation}`
}
