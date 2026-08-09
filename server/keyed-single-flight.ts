export class KeyedSingleFlight<T> {
  private readonly pending = new Map<string, Promise<T>>()

  run(key: string, operation: () => Promise<T>) {
    const existing = this.pending.get(key)
    if (existing) return existing
    const current = operation().finally(() => {
      if (this.pending.get(key) === current) this.pending.delete(key)
    })
    this.pending.set(key, current)
    return current
  }

  invalidate(key: string) {
    this.pending.delete(key)
  }

  get size() {
    return this.pending.size
  }
}
