import { describe, it, expect } from 'vitest'
import { executeRecoverableCommand } from './recoverable-command'

describe('recoverable command intent ownership', () => {
  it('reuses the original key after an unknown response but creates a fresh intentional command after success', async () => {
    const namespace = crypto.randomUUID()
    const keys: string[] = []
    await expect(executeRecoverableCommand(namespace, { amount: 100 }, 'original', async (key) => {
      keys.push(key); throw new Error('response lost after commit')
    })).rejects.toThrow('response lost')
    await executeRecoverableCommand(namespace, { amount: 100 }, 'retry-new-key', async (key) => { keys.push(key); return 1 })
    await executeRecoverableCommand(namespace, { amount: 100 }, 'intentional-second', async (key) => { keys.push(key); return 2 })
    expect(keys).toEqual(['original', 'original', 'intentional-second'])
  })

  it('deduplicates concurrent same-intent submissions and separates employee/table scopes', async () => {
    const namespace = crypto.randomUUID()
    let resolve!: (value: number) => void
    const response = new Promise<number>((done) => { resolve = done })
    const keys: string[] = []
    const send = (key: string) => { keys.push(key); return response }
    const a = executeRecoverableCommand(namespace, { item: 1 }, 'a', send)
    const b = executeRecoverableCommand(namespace, { item: 1 }, 'b', send)
    const other = executeRecoverableCommand(`${namespace}:other`, { item: 1 }, 'other', send)
    // Let digest promises complete without depending on a fixed execution order.
    while (keys.length < 2) await new Promise((done) => setTimeout(done, 1))
    expect(keys).toHaveLength(2)
    expect(keys).toContain('other')
    resolve(4)
    expect(await Promise.all([a, b, other])).toEqual([4, 4, 4])
  })

  it('releases a definitely rejected command so corrected input can be submitted', async () => {
    const namespace = crypto.randomUUID()
    await expect(executeRecoverableCommand(namespace, {}, 'rejected', async () => { throw { status: 403 } })).rejects.toEqual({ status: 403 })
    const key = await executeRecoverableCommand(namespace, {}, 'fresh', async (value) => value)
    expect(key).toBe('fresh')
  })
})
