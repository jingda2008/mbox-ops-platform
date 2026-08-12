import { describe, expect, it } from 'vitest'
import {
  addCalendarDays,
  arrivalIso,
  classifyZone,
  createArrivalSlots,
  formatMoney,
  remainingHoldSeconds,
  validateConfirmation,
  validateGuestDetails,
} from './reservation-model'
import type { ReservationDraft } from './types'

describe('reservation operating schedule', () => {
  it('creates Shanghai slots from noon through the next morning without natural-day ambiguity', () => {
    const slots = createArrivalSlots('2026-08-12', new Date('2026-08-11T00:00:00.000Z'))

    expect(slots[0]).toMatchObject({ label: '12:00', iso: '2026-08-12T12:00:00+08:00', nextDay: false })
    expect(slots.at(-1)).toMatchObject({ label: '01:30 次日', iso: '2026-08-13T01:30:00+08:00', nextDay: true })
    expect(arrivalIso('2026-08-12', '2026-08-12|1500')).toBe('2026-08-13T01:00:00+08:00')
  })

  it('removes elapsed same-day slots and validates calendar arithmetic', () => {
    const slots = createArrivalSlots('2026-08-12', new Date('2026-08-12T13:20:00+08:00'))
    expect(slots[0]?.label).toBe('14:00')
    expect(addCalendarDays('2026-02-28', 1)).toBe('2026-03-01')
  })
})

describe('reservation presentation rules', () => {
  it('groups venue areas without relying on table customer data', () => {
    expect(classifyZone({ code: 'VIP', name: '舞台卡座', type: 'vip' })).toBe('stage-front')
    expect(classifyZone({ code: 'MAIN', name: '室内中区', type: 'indoor' })).toBe('indoor-middle')
    expect(classifyZone({ code: 'W', name: '屋顶露台', type: 'outdoor' })).toBe('outdoor')
  })

  it('shows minimum spend clearly and validates self-selected confirmation', () => {
    expect(formatMoney(188800)).toBe('最低消费 ¥1,888')
    expect(formatMoney(null)).toBe('无最低消费')
    const draft: ReservationDraft = {
      date: '2026-08-12', time: '2026-08-12|1230', guestCount: 2,
      mode: 'self_select', tableCodes: [], customerName: '王女士', contact: '13800138000', note: '',
    }
    expect(validateConfirmation(draft)).toBe('请选择一个座位')
    expect(validateConfirmation({ ...draft, tableCodes: ['VIP1'] })).toBeNull()
    expect(validateGuestDetails(draft)).toBeNull()
  })

  it('calculates the server-provided hold deadline without extending it locally', () => {
    expect(remainingHoldSeconds('2026-08-12T12:20:00.000Z', new Date('2026-08-12T12:19:30.000Z'))).toBe(30)
    expect(remainingHoldSeconds('2026-08-12T12:20:00.000Z', new Date('2026-08-12T12:21:00.000Z'))).toBe(0)
  })
})
