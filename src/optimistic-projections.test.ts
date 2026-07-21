import { describe, expect, it } from 'vitest'
import { projectKdsTask, projectReservation, projectServiceTask } from './optimistic-projections'
import type { ServiceTask } from './shared/contracts'
import type { KdsTask } from './shared/order-contracts'
import type { Reservation } from './shared/reservation-contracts'

const now = '2026-07-21T12:00:00.000Z'

describe('optimistic projections', () => {
  it('projects the complete staff service action to the server auto-confirmed state', () => {
    const task = { status: 'arrived', completedAt: null, resolution: null } as ServiceTask
    expect(projectServiceTask(task, 'complete', 'emp-tom', now)).toMatchObject({
      status: 'confirmed', completedAt: now, resolution: '现场服务完成', updatedAt: now,
    })
  })

  it('projects each KDS handoff without changing unrelated timestamps', () => {
    const task = { status: 'completed', pickedUpAt: null, pickedUpBy: null, deliveredAt: null } as KdsTask
    expect(projectKdsTask(task, 'pickUp', 'emp-tom', now)).toMatchObject({
      status: 'picked_up', pickedUpAt: now, pickedUpBy: 'emp-tom', deliveredAt: null,
    })
  })

  it('projects arrival while preserving the confirmed timestamp', () => {
    const reservation = { status: 'confirmed', confirmedAt: 'earlier', arrivedAt: null } as Reservation
    expect(projectReservation(reservation, 'arrive', now)).toMatchObject({
      status: 'arrived', confirmedAt: 'earlier', arrivedAt: now, updatedAt: now,
    })
  })
})
