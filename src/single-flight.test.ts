import { describe, expect, it, vi } from 'vitest'
import { runSingleFlight, type SingleFlightRef } from './single-flight'

describe('runSingleFlight', () => {
  it('shares an active request and permits the next one after settlement', async () => {
    let resolveFirst!: (value: string) => void
    const first = new Promise<string>((resolve) => { resolveFirst = resolve })
    const operation = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce('second')
    const inFlight: SingleFlightRef<string> = { current: null }

    const requestA = runSingleFlight(inFlight, operation)
    const requestB = runSingleFlight(inFlight, operation)

    expect(requestB).toBe(requestA)
    expect(operation).toHaveBeenCalledTimes(1)
    resolveFirst('first')
    await expect(requestA).resolves.toBe('first')
    await Promise.resolve()

    await expect(runSingleFlight(inFlight, operation)).resolves.toBe('second')
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('clears a failed request so polling can recover', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce('recovered')
    const inFlight: SingleFlightRef<string> = { current: null }

    await expect(runSingleFlight(inFlight, operation)).rejects.toThrow('network timeout')
    await Promise.resolve()
    await expect(runSingleFlight(inFlight, operation)).resolves.toBe('recovered')
    expect(operation).toHaveBeenCalledTimes(2)
  })
})
