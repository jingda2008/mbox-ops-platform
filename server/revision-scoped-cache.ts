export class RevisionScopedCache<T> {
  private readonly entries = new Map<string, T>()

  constructor(private readonly maxEntries = 64) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be a positive integer')
  }

  getOrCreate(scope: string, revision: number, create: () => T): T {
    const key = `${scope}:${revision}`
    const cached = this.entries.get(key)
    if (cached !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      return cached
    }

    const value = create()
    this.entries.set(key, value)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return value
  }

  delete(scope: string, revision: number) {
    return this.entries.delete(`${scope}:${revision}`)
  }

  get size() {
    return this.entries.size
  }
}
