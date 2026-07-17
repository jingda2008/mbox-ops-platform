import { describe, expect, it } from 'vitest'
import type { ServiceTask } from '../shared/contracts'
import { taskAcceptMode, taskQueueIsOpen } from './task-queue'

function task(ownerId: string | null, status: ServiceTask['status'] = 'pending') {
  return { ownerId, status } as ServiceTask
}

describe('task queue claim controls', () => {
  it('shows claim for unowned work and accept only to the assigned employee', () => {
    expect(taskAcceptMode(task(null), 'emp-lin', true)).toBe('claim')
    expect(taskAcceptMode(task(null), 'emp-lin', false)).toBeNull()
    expect(taskAcceptMode(task('emp-lin'), 'emp-lin', false)).toBe('accept')
    expect(taskAcceptMode(task('emp-jie'), 'emp-lin', true)).toBeNull()
  })

  it('does not offer claim or accept after work has already been accepted', () => {
    expect(taskAcceptMode(task(null, 'accepted'), 'emp-lin', true)).toBeNull()
    expect(taskAcceptMode(task('emp-lin', 'completed'), 'emp-lin', true)).toBeNull()
  })

  it('removes completed service from the employee reminder queue immediately', () => {
    expect(taskQueueIsOpen(task('emp-lin', 'arrived'))).toBe(true)
    expect(taskQueueIsOpen(task('emp-lin', 'completed'))).toBe(false)
    expect(taskQueueIsOpen(task('emp-lin', 'confirmed'))).toBe(false)
  })
})
