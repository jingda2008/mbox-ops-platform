export function guestFeedbackIdempotencyKey(action: 'confirm' | 'unresolved') {
  return `guest-feedback-${action}-${crypto.randomUUID()}`
}

export function guestMoodServiceNote(label: string, care: string) {
  return `客户心情反馈：${label}。关怀建议：${care} 请服务专员选择合适时机到桌关注。`
}
