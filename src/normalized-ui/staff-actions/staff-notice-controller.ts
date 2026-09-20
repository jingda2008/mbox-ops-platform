import type { StaffActionNotice } from './types'

type Notice = Exclude<StaffActionNotice, null>

/** Background reminders must leave time to read the result of the current action. */
export class StaffNoticeController {
  private readonly publish: (notice: StaffActionNotice) => void
  private current: Notice | null = null
  private reminders: Notice[] = []
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null

  constructor(publish: (notice: StaffActionNotice) => void) {
    this.publish = publish
  }

  show(notice: Notice): void {
    if (notice.kind === 'attention' && this.current !== null) {
      if (this.current.message !== notice.message) this.queueReminder(notice)
      return
    }
    if (this.current?.kind === 'attention') this.queueReminder(this.current)
    this.present(notice)
  }

  clear(): void {
    this.dispose()
    this.publish(null)
  }

  dispose(): void {
    if (this.timer !== null) globalThis.clearTimeout(this.timer)
    this.timer = null
    this.current = null
    this.reminders = []
  }

  private queueReminder(notice: Notice): void {
    if (!this.reminders.some(item => item.message === notice.message)) {
      // Counts and tasks remain in the workspace; avoid a long backlog of transient reminders.
      this.reminders = [...this.reminders, notice].slice(-3)
    }
  }

  private present(notice: Notice): void {
    if (this.timer !== null) globalThis.clearTimeout(this.timer)
    this.current = notice
    this.publish(notice)
    this.timer = globalThis.setTimeout(() => {
      this.timer = null
      this.current = null
      const next = this.reminders.shift()
      if (next) this.present(next)
      else this.publish(null)
    }, notice.kind === 'attention' ? 12_000 : notice.kind === 'guidance' ? 6_000 : 3_200)
  }
}
