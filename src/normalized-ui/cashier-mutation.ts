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

  prepare(action: string, body: unknown): CashierMutationAttempt {
    const signature = mutationSignature(action, body)
    const attempt = this.pending.get(signature) ?? {
      idempotencyKey: createIdempotencyKey(action),
      body,
    }
    this.pending.set(signature, attempt)
    return { signature, ...attempt }
  }

  complete(signature: string): void {
    this.pending.delete(signature)
  }

  fail(signature: string, retryable: boolean): void {
    if (!retryable) this.pending.delete(signature)
  }
}
