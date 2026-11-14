import { useState, useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedApiClient, StaffAuthView } from '../normalized-api'
import { PrintIncidentPanel } from './PrintIncidentPanel'
import type { PrintIncident } from './print-incident-policy'
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: vi.fn(), useRef: vi.fn(), useEffect: vi.fn(), useCallback: (callback: unknown) => callback}))
const row: PrintIncident = {id: 'incident-1', episodeStartedAt: '2026-11-14T02:00:00Z', bridgeId: 'bridge-1', jobId: 'job-1', kind: 'print_result', failureCode: 'ambiguous_print_result', status: 'claimed', firstSeenAt: '2026-11-14T02:00:00Z', lastSeenAt: '2026-11-14T02:00:00Z', occurrences: 2, claimedBy: 'employee-1', resolution: null, escalation: 'administrator'}
describe('print incident request recovery', () => {
  let states: unknown[], refs: Array<{current: unknown}>, stateIndex: number, refIndex: number
  const post = vi.fn(), get = vi.fn()
  function render(permissions = ['print.reprint']) {
    stateIndex = 0; refIndex = 0
    const wrapper = PrintIncidentPanel({api: {postEndpoint: post, getEndpoint: get} as unknown as NormalizedApiClient, auth: {session: {employeeId: 'employee-1'}, permissions} as StaffAuthView})
    return wrapper.type(wrapper.props)
  }
  beforeEach(() => {
    vi.clearAllMocks(); states = [[row], true]; refs = []
    get.mockResolvedValue({data: [row]})
    vi.mocked(useState).mockImplementation(initial => {
      const index = stateIndex++; if (!(index in states)) states[index] = initial
      return [states[index], (value: unknown) => {states[index] = value}] as never
    })
    vi.mocked(useRef).mockImplementation(initial => {
      const index = refIndex++; return (refs[index] ?? (refs[index] = {current: initial})) as never
    })
  })
  it('deduplicates repeated clicks in the same render and never invokes print endpoints', async () => {
    let finish!: (value: unknown) => void
    post.mockImplementation(() => new Promise(resolve => {finish = resolve}))
    const tree = render()
    tree.props.onAction(row.id, 'not_printed'); tree.props.onAction(row.id, 'not_printed')
    expect(post).toHaveBeenCalledOnce()
    expect(post.mock.calls[0].slice(0, 2)).toEqual(['/api/hardware/print-incidents/incident-1/resolve', {resolution: 'not_printed', expectedEpisodeAt: row.episodeStartedAt}])
    finish({}); await vi.waitFor(() => expect(states[2]).toBe(false))
    expect(states[4]).toContain('未触发补打')
  })
  it('retains original request after network uncertainty and rejects a different resolution', async () => {
    post.mockRejectedValue(new Error('timeout'))
    render().props.onAction(row.id, 'not_printed')
    await vi.waitFor(() => expect(states[2]).toBe(false))
    const key = post.mock.calls[0][2].idempotencyKey
    states[0] = [{...row, episodeStartedAt: '2026-11-14T03:00:00Z'}]
    render().props.onAction(row.id, 'paper_confirmed')
    expect(post).toHaveBeenCalledOnce()
    render().props.onAction(row.id, 'not_printed')
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post.mock.calls[1][2].idempotencyKey).toBe(key)
    expect(post.mock.calls[1][1].expectedEpisodeAt).toBe(row.episodeStartedAt)
  })
  it('can recover an uncertain original request absent from the capped list without assuming success', async () => {
    post.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({replayed: true})
    render().props.onAction(row.id, 'not_printed')
    await vi.waitFor(() => expect(states[2]).toBe(false))
    states[0] = []; get.mockResolvedValue({data: []})
    render().props.onAction(row.id, 'not_printed')
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post.mock.calls[1][2]).toEqual(post.mock.calls[0][2])
  })
  it('does not let retry-only viewers claim an incident even if a handler is invoked', () => {
    states[0] = [{...row, status: 'open', claimedBy: null}]
    render(['print.retry']).props.onAction(row.id, 'claim')
    expect(post).not.toHaveBeenCalled()
  })
  it('does not submit with revoked permissions or stale data', () => {
    render(['print.retry']).props.onAction(row.id, 'not_printed')
    states[1] = false
    render().props.onAction(row.id, 'not_printed')
    expect(post).not.toHaveBeenCalled()
  })
})
