/** Coalesce polling, but guarantee a read begun after a confirmed mutation.
 * Only disposal/identity changes abort a request; a timer never cancels work. */
export class RefreshQueue {
  private flight: Promise<void> | null = null
  private controller: AbortController | null = null
  private again = false
  private generation = 0

  private readonly read: (signal: AbortSignal) => Promise<void>

  constructor(read: (signal: AbortSignal) => Promise<void>) { this.read = read }

  request(afterCurrent = false): Promise<void> {
    if (this.flight) {
      if (afterCurrent) this.again = true
      return this.flight
    }
    const generation = this.generation
    const flight = Promise.resolve().then(async () => {
      do {
        if (generation !== this.generation) return
        this.again = false
        const controller = new AbortController()
        this.controller = controller
        await this.read(controller.signal)
      } while (this.again && generation === this.generation)
    }).finally(() => {
      if (this.flight === flight) {
        this.flight = null
        this.controller = null
      }
    })
    this.flight = flight
    return flight
  }

  cancel(): void {
    this.generation += 1
    this.again = false
    this.controller?.abort()
    this.controller = null
    this.flight = null
  }
}
