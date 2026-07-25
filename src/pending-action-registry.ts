export class PendingActionRegistry {
  private readonly keys = new Set<string>()

  begin(key: string) {
    if (this.keys.has(key)) return false
    this.keys.add(key)
    return true
  }

  finish(key: string) {
    this.keys.delete(key)
  }

  has(key: string) {
    return this.keys.has(key)
  }

  hasSuffix(suffix: string) {
    return [...this.keys].some((key) => key.endsWith(suffix))
  }

  snapshot(): ReadonlySet<string> {
    return new Set(this.keys)
  }
}
