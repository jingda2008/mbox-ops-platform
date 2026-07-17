import type { GuestSessionResponse, GuestTaskView } from '../shared/guest-contracts'

export interface GuestReplyNotice {
  message: string
  related?: { kind: 'task' | 'song'; id: string; status: string; updatedAt?: string }
}

export function guestReplyNotice(message: string): GuestReplyNotice {
  return { message }
}

export function guestSessionHistoryUrl(currentHref: string, tableToken: string) {
  const url = new URL(currentHref)
  url.searchParams.set('token', tableToken)
  return `${url.pathname}${url.search}${url.hash}`
}

export function guestTaskReplyNotice(message: string, task: GuestTaskView): GuestReplyNotice {
  return { message, related: { kind: 'task', id: task.id, status: task.status, updatedAt: task.updatedAt } }
}

export function guestSongReplyNotice(message: string, request: { id: string; status: string }): GuestReplyNotice {
  return { message, related: { kind: 'song', id: request.id, status: request.status } }
}

export function reconcileGuestReply(
  notice: GuestReplyNotice | null,
  tasks: GuestTaskView[],
  songRequests: ReadonlyArray<{ id: string; status: string }>,
) {
  if (!notice?.related) return notice
  if (notice.related.kind === 'task') {
    const refreshedTask = tasks.find((task) => task.id === notice.related?.id)
    return refreshedTask?.status === notice.related.status
      && refreshedTask.updatedAt === notice.related.updatedAt ? notice : null
  }
  const refreshedSongRequest = songRequests.find((request) => request.id === notice.related?.id)
  return refreshedSongRequest?.status === notice.related.status ? notice : null
}

export function visibleGuestTasks(tasks: GuestTaskView[], limit = 5) {
  return tasks.filter((task) => task.status !== 'confirmed' && task.status !== 'cancelled').slice(0, limit)
}

export const GUEST_SONG_TERMINAL_DISPLAY_MS = 20_000

const terminalGuestSongStatuses = new Set(['complete', 'completed', 'rejected', 'cancelled', 'refunded'])

export function guestSongStatusLabel(status: string) {
  const labels: Record<string, string> = {
    pending_confirmation: '待服务伙伴确认',
    pending_payment: '已确认 · 等待现场收费',
    paid: '现场已收款',
    accepted: '歌手已接单',
    performing: '正在演唱',
    complete: '演唱完成',
    completed: '演唱完成',
    rejected: '暂时无法安排',
    cancelled: '已取消',
    refund_required: '正在安排退款',
    refunded: '已退款',
  }
  return labels[status] ?? '状态更新中'
}

export function trackGuestSongTerminalStates(
  current: Record<string, number>,
  requests: ReadonlyArray<{ id: string; status: string }>,
  now: number,
) {
  return Object.fromEntries(requests.flatMap((request) => (
    terminalGuestSongStatuses.has(request.status) ? [[request.id, current[request.id] ?? now]] : []
  )))
}

export function visibleGuestSongRequests<T extends { id: string; status: string }>(
  requests: T[],
  terminalSeenAt: Record<string, number>,
  now: number,
  terminalDisplayMs = GUEST_SONG_TERMINAL_DISPLAY_MS,
) {
  return requests.filter((request) => (
    !terminalGuestSongStatuses.has(request.status)
    || now - (terminalSeenAt[request.id] ?? now) < terminalDisplayMs
  ))
}

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

export function formatGuestCompactCountdown(durationMs: number) {
  const formatted = formatGuestCountdown(durationMs)
  return formatted.startsWith('00:') ? formatted.slice(3) : formatted.replace(/^0/, '')
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

export function guestErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(error.message)) {
    return '现场网络打了个盹～您的内容还在，再轻点一次；需要时也可以直接招呼身边伙伴。'
  }
  if (/系统返回了无法识别的响应|系统请求失败/.test(error.message)) return fallback
  return error.message
}
