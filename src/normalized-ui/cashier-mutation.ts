export function createIdempotencyKey(action: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `cashier:${action}:${suffix}`.slice(0, 128)
}

export function mutationSignature(action: string, body: unknown): string {
  return `${action}:${JSON.stringify(body, (key, value) => key === 'occurredAt' ? undefined : value)}`
}

export interface CashierMutationAttempt {
  signature: string
  idempotencyKey: string
  body: unknown
}

export class CashierMutationCoordinator {
  private readonly pending = new Map<string, Omit<CashierMutationAttempt, 'signature'>>()
  private readonly flights = new Map<string, Promise<unknown>>()

  prepare(action: string, body: unknown): CashierMutationAttempt {
    const signature = mutationSignature(action, body)
    const attempt = this.pending.get(signature) ?? {
      idempotencyKey: createIdempotencyKey(action),
      body: structuredClone(body),
    }
    this.pending.set(signature, attempt)
    return { signature, ...attempt }
  }

  complete(signature: string): void {
    this.pending.delete(signature)
  }

  async execute<T>(action: string, body: unknown, send: (attempt: CashierMutationAttempt) => Promise<T>, readback: () => Promise<void>): Promise<T> {
    const attempt = this.prepare(action, body)
    const existing = this.flights.get(attempt.signature)
    if (existing) return existing as Promise<T>
    // A timeout, permission error or failed read is not proof that money was
    // untouched. Keep the original body/key until both receipt and read succeed.
    const operation = Promise.resolve().then(() => send(attempt)).then(async result => {
      await readback()
      this.complete(attempt.signature)
      return result
    }).finally(() => this.flights.delete(attempt.signature))
    this.flights.set(attempt.signature, operation)
    return operation
  }

  fail(signature: string, retryable: boolean): void {
    if (!retryable) this.pending.delete(signature)
  }
}
