export function guestFeedbackIdempotencyKey(action: 'confirm' | 'unresolved') {
  return `guest-feedback-${action}-${crypto.randomUUID()}`
}
