import type { KdsActionInput } from './shared/commerce-api'
import type { ServiceTask, TaskActionInput } from './shared/contracts'
import type { KdsTask } from './shared/order-contracts'
import type { Reservation } from './shared/reservation-contracts'

export function projectServiceTask(task: ServiceTask, action: TaskActionInput['action'], actorId: string, now: string): ServiceTask {
  return {
    ...task,
    status: action === 'accept' ? 'accepted' : action === 'arrive' ? 'arrived' : action === 'complete' ? 'confirmed' : task.status,
    ownerId: action === 'accept' ? actorId : task.ownerId,
    acceptedAt: action === 'accept' ? now : task.acceptedAt,
    arrivedAt: action === 'arrive' ? now : task.arrivedAt,
    completedAt: action === 'complete' ? now : task.completedAt,
    resolution: action === 'complete' ? '现场服务完成' : task.resolution,
    updatedAt: now,
  }
}

export function projectKdsTask(task: KdsTask, action: KdsActionInput['action'], actorId: string, now: string): KdsTask {
  return {
    ...task,
    status: action === 'start' ? 'preparing' : action === 'complete' ? 'completed' : action === 'pickUp' ? 'picked_up' : 'delivered',
    startedAt: action === 'start' ? now : task.startedAt,
    startedBy: action === 'start' ? actorId : task.startedBy,
    completedAt: action === 'complete' ? now : task.completedAt,
    completedBy: action === 'complete' ? actorId : task.completedBy,
    pickedUpAt: action === 'pickUp' ? now : task.pickedUpAt,
    pickedUpBy: action === 'pickUp' ? actorId : task.pickedUpBy,
    deliveredAt: action === 'deliver' ? now : task.deliveredAt,
    deliveredBy: action === 'deliver' ? actorId : task.deliveredBy,
  }
}

export function projectReservation(reservation: Reservation, action: 'confirm' | 'arrive', now: string): Reservation {
  return {
    ...reservation,
    status: action === 'confirm' ? 'confirmed' : 'arrived',
    confirmedAt: action === 'confirm' ? now : reservation.confirmedAt,
    arrivedAt: action === 'arrive' ? now : reservation.arrivedAt,
    updatedAt: now,
  }
}
