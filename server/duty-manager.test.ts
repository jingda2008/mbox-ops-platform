import { describe, expect, it } from 'vitest'
import { createServiceTask } from './domain.js'
import {
  buildDutyManagerBriefing,
  buildDutyManagerHandover,
  calculateDutyManagerEffectiveness,
  reconcileDutyManagerIncidents,
} from './duty-manager.js'
import { createSeedState } from './seed.js'

describe('AI duty manager briefing', () => {
  it('prioritizes manager-level service breaches and overdue fulfillment', () => {
    const state = createSeedState(new Date('2026-07-20T12:00:00.000Z'))
    state.tasks = []
    state.orderDomain.kdsTasks = []
    state.sopExecutions = []
    state.sopActionRecords = []
    state.reservationState!.reservations = []
    state.hardwareState!.devices.forEach((device) => { device.enabled = false })
    const serviceTask = createServiceTask(state, {
      tableCode: 'L01', serviceTypeId: 'water', source: 'guest', note: '请加水',
    })
    serviceTask.createdAt = '2026-07-20T11:56:00.000Z'
    serviceTask.warningAt = '2026-07-20T12:00:00.000Z'
    serviceTask.escalateAt = '2026-07-20T12:01:00.000Z'
    serviceTask.managerAt = '2026-07-20T12:02:00.000Z'
    serviceTask.ownerId = null
    state.orderDomain.kdsTasks.push({
      id: 'kds-overdue', orderId: 'order-1', orderItemId: 'line-1', tableSessionId: serviceTask.tableSessionId!,
      tableCode: 'L01', stationId: 'bar-main', itemName: '精酿啤酒', specification: '330ml', quantity: 2,
      status: 'preparing', productionSla: { targetSeconds: 180, dueAt: '2026-07-20T12:00:00.000Z' },
      pickupSla: { targetSeconds: 60, dueAt: null }, queuedAt: '2026-07-20T11:57:00.000Z',
      startedAt: '2026-07-20T11:58:00.000Z', startedBy: 'emp-qing', completedAt: null, completedBy: null,
      pickedUpAt: null, pickedUpBy: null, deliveredAt: null, deliveredBy: null,
    })

    const briefing = buildDutyManagerBriefing(state, Date.parse('2026-07-20T12:06:00.000Z'))

    expect(briefing.health).toBe('critical')
    expect(briefing.counts).toMatchObject({ critical: 2, openServiceTasks: 1, overdueFulfillmentTasks: 1 })
    expect(briefing.risks.slice(0, 2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'service', severity: 'critical', tableCode: 'L01' }),
      expect.objectContaining({ category: 'fulfillment', severity: 'critical', tableCode: 'L01' }),
    ]))
  })

  it('ignores old-business-day KDS work and groups current table workstation breaches', () => {
    const now = Date.parse('2026-07-20T12:10:00.000Z')
    const state = createSeedState(new Date(now))
    state.tasks = []
    state.sopExecutions = []
    state.sopActionRecords = []
    state.reservationState!.reservations = []
    state.hardwareState!.devices.forEach((device) => { device.enabled = false })
    state.tables = state.tables.map((table) => ({ ...table, status: 'available', primaryEmployeeId: null }))
    const template = structuredClone(state.orderDomain.kdsTasks[0]!)
    state.orderDomain.kdsTasks = [
      {
        ...structuredClone(template), id: 'kds-current-beer', orderItemId: 'line-current-beer', itemName: '精酿啤酒',
        quantity: 2, status: 'preparing', queuedAt: '2026-07-20T12:00:00.000Z',
        productionSla: { targetSeconds: 180, dueAt: '2026-07-20T12:03:00.000Z' }, exceptionEvents: [],
      },
      {
        ...structuredClone(template), id: 'kds-current-snack', orderItemId: 'line-current-snack', itemName: '薯条',
        quantity: 1, status: 'queued', queuedAt: '2026-07-20T12:01:00.000Z',
        productionSla: { targetSeconds: 180, dueAt: '2026-07-20T12:04:00.000Z' }, exceptionEvents: [],
      },
      {
        ...structuredClone(template), id: 'kds-old', orderItemId: 'line-old', itemName: '历史啤酒',
        quantity: 8, status: 'preparing', queuedAt: '2026-07-19T12:00:00.000Z',
        productionSla: { targetSeconds: 180, dueAt: '2026-07-19T12:03:00.000Z' }, exceptionEvents: [],
      },
    ]

    const briefing = buildDutyManagerBriefing(state, now)
    const fulfillmentRisks = briefing.risks.filter((risk) => risk.category === 'fulfillment')

    expect(fulfillmentRisks).toHaveLength(1)
    expect(fulfillmentRisks[0]).toMatchObject({
      title: expect.stringContaining('2项出品制作超时'),
      detail: expect.stringMatching(/共2个任务、3份，最久超时7分钟/),
    })
    expect(fulfillmentRisks[0]?.detail).not.toContain('历史啤酒')
    expect(briefing.counts.overdueFulfillmentTasks).toBe(2)
  })

  it('reports stable operation when no visible operational item needs attention', () => {
    const state = createSeedState(new Date('2026-07-20T12:00:00.000Z'))
    state.tasks = []
    state.orderDomain.kdsTasks = []
    state.sopExecutions = []
    state.sopActionRecords = []
    state.reservationState!.reservations = []
    state.tables = state.tables.map((table) => ({ ...table, status: 'available', primaryEmployeeId: null }))

    const briefing = buildDutyManagerBriefing(state, Date.parse('2026-07-20T12:00:00.000Z'))

    expect(briefing).toMatchObject({ health: 'stable', risks: [], headline: '当前没有未接管的风险，现场运行平稳。' })
  })

  it('measures response, closure, automatic assignment and cross-day improvement', () => {
    const now = Date.parse('2026-07-20T13:00:00.000Z')
    const state = createSeedState(new Date(now))
    state.tasks = []
    state.taskEvents = []
    state.auditEntries = []
    state.sopExecutions = []

    for (let index = 0; index < 6; index += 1) {
      const currentDay = index < 3
      const day = currentDay ? '20' : '19'
      const createdAt = `2026-07-${day}T12:0${index % 3}:00.000Z`
      const responseSeconds = currentDay ? 10 : 45
      const task = createServiceTask(state, {
        tableCode: 'L01', serviceTypeId: 'water', source: 'guest', note: '加水',
        idempotencyKey: `effectiveness-${index}`,
      })
      task.createdAt = createdAt
      task.acceptedAt = new Date(Date.parse(createdAt) + responseSeconds * 1_000).toISOString()
      task.completedAt = new Date(Date.parse(createdAt) + 90_000).toISOString()
      task.status = 'confirmed'
      task.escalationLevel = currentDay ? 0 : 1
    }

    const effectiveness = calculateDutyManagerEffectiveness(state, now)

    expect(effectiveness.service).toMatchObject({
      sampleSize: 3,
      responseSampleSize: 3,
      completedTasks: 3,
      completionRate: 100,
      responseWithinSlaRate: 100,
      medianFirstResponseSeconds: 10,
      automaticAssignmentRate: 100,
      escalationRate: 0,
    })
    expect(effectiveness.comparison).toMatchObject({
      previousBusinessDate: '2026-07-19',
      previousSampleSize: 3,
      previousResponseSampleSize: 3,
      responseWithinSlaDeltaPoints: 100,
      medianFirstResponseDeltaSeconds: -35,
    })
    expect(effectiveness.trend).toBe('improving')
    expect(buildDutyManagerBriefing(state, now).effectiveness).toEqual(effectiveness)
  })

  it('does not count a new task as a missed response before its SLA deadline', () => {
    const now = Date.parse('2026-07-20T13:00:00.000Z')
    const state = createSeedState(new Date(now))
    state.tasks = []
    state.taskEvents = []
    state.auditEntries = []
    const task = createServiceTask(state, {
      tableCode: 'L01', serviceTypeId: 'water', source: 'guest', note: '刚刚提交',
      idempotencyKey: 'response-window-not-due',
    })
    task.createdAt = new Date(now).toISOString()
    task.warningAt = new Date(now + 30_000).toISOString()
    task.acceptedAt = null

    expect(calculateDutyManagerEffectiveness(state, now)).toMatchObject({
      service: { sampleSize: 1, responseSampleSize: 0, responseWithinSlaRate: null },
      trend: 'insufficient_data',
      summary: '今日已有0次服务形成首响结果，累计到3次后开始判断服务趋势。',
    })
  })

  it('uses Beijing business time and raises a critical risk when the persisted business day is stale', () => {
    const state = createSeedState(new Date('2026-07-15T12:00:00.000Z'))
    state.tasks = []
    state.orderDomain.kdsTasks = []
    state.sopExecutions = []
    state.sopActionRecords = []
    state.reservationState!.reservations = []
    state.tables = state.tables.map((table) => ({ ...table, status: 'available', primaryEmployeeId: null }))

    const briefing = buildDutyManagerBriefing(state, Date.parse('2026-07-20T12:00:00.000Z'))

    expect(briefing.businessDate).toBe('2026-07-20')
    expect(briefing.risks).toContainEqual(expect.objectContaining({
      category: 'system', severity: 'critical', recommendedCommand: '打开运行状态',
    }))
  })

  it('shows reservation arrival time in Beijing time instead of raw UTC', () => {
    const now = Date.parse('2026-07-20T01:00:00.000Z')
    const state = createSeedState(new Date(now))
    state.tasks = []
    state.orderDomain.kdsTasks = []
    state.sopExecutions = []
    state.sopActionRecords = []
    state.reservationState!.reservations = [{
      ...state.reservationState!.reservations[0]!,
      id: 'reservation-beijing-time',
      customerName: '北京时间客人',
      status: 'requested',
      scheduledAt: '2026-07-20T04:30:00.000Z',
    }]

    expect(buildDutyManagerBriefing(state, now).risks).toContainEqual(expect.objectContaining({
      category: 'reservation',
      detail: expect.stringContaining('计划12:30到店'),
      targetObjectId: 'reservation-beijing-time',
      targetQuery: '北京时间客人',
      recommendation: expect.stringContaining('核对联系方式'),
    }))
  })

  it('raises a hardware risk for a real device that misses heartbeats', () => {
    const now = Date.parse('2026-07-20T12:06:00.000Z')
    const state = createSeedState(new Date('2026-07-20T12:00:00.000Z'))
    state.tasks = []
    state.orderDomain.kdsTasks = []
    state.sopExecutions = []
    state.sopActionRecords = []
    state.reservationState!.reservations = []
    state.hardwareState!.devices.forEach((device) => { device.enabled = false })
    const camera = state.hardwareState!.devices[0]!
    camera.enabled = true
    camera.adapter = 'rtsp'
    camera.connectionReference = 'secret:mbox-camera-lounge'
    camera.lastHeartbeatAt = '2026-07-20T12:00:00.000Z'

    expect(buildDutyManagerBriefing(state, now).risks).toContainEqual(expect.objectContaining({
      category: 'hardware', severity: 'high', recommendedCommand: '打开设备中心',
    }))
  })

  it('persists a risk incident and automatically closes it after the source clears', () => {
    const now = Date.parse('2026-07-20T12:06:00.000Z')
    const state = createSeedState(new Date(now))
    state.tasks = []
    state.orderDomain.kdsTasks = []
    state.sopExecutions = []
    state.sopActionRecords = []
    state.reservationState!.reservations = []
    state.hardwareState!.devices.forEach((device) => { device.enabled = false })
    const task = createServiceTask(state, { tableCode: 'L01', serviceTypeId: 'water', source: 'guest', note: '加水' })
    task.createdAt = new Date(now - 180_000).toISOString()
    state.tables = state.tables.map((table) => ({ ...table, status: 'available', primaryEmployeeId: null }))
    task.warningAt = new Date(now - 120_000).toISOString()
    task.escalateAt = new Date(now - 60_000).toISOString()
    task.managerAt = new Date(now - 30_000).toISOString()

    expect(reconcileDutyManagerIncidents(state, now)).toBe(true)
    expect(state.dutyManagerIncidents).toContainEqual(expect.objectContaining({
      category: 'service', status: 'open', cycle: 1, observationCount: 1,
    }))

    task.status = 'completed'
    expect(reconcileDutyManagerIncidents(state, now + 60_000)).toBe(true)
    expect(state.dutyManagerIncidents?.find((incident) => incident.category === 'service')).toMatchObject({
      status: 'resolved', resolution: 'source_cleared', resolvedBy: 'system',
    })
    expect(buildDutyManagerHandover(state, now + 60_000)).toMatchObject({ active: 0, resolved: 1 })
  })

  it('hides deferred incidents and reopens them after the review time expires', () => {
    const now = Date.parse('2026-07-20T12:06:00.000Z')
    const state = createSeedState(new Date(now))
    state.tasks = []
    state.orderDomain.kdsTasks = []
    state.sopExecutions = []
    state.sopActionRecords = []
    state.reservationState!.reservations = []
    const task = createServiceTask(state, { tableCode: 'L01', serviceTypeId: 'water', source: 'guest', note: '加水' })
    task.createdAt = new Date(now - 180_000).toISOString()
    task.warningAt = new Date(now - 120_000).toISOString()
    task.escalateAt = new Date(now - 60_000).toISOString()
    task.managerAt = new Date(now - 30_000).toISOString()

    reconcileDutyManagerIncidents(state, now)
    const incident = state.dutyManagerIncidents?.find((item) => item.category === 'service')
    expect(incident).toBeTruthy()
    incident!.status = 'deferred'
    incident!.deferredUntil = new Date(now + 5 * 60_000).toISOString()
    incident!.updatedAt = new Date(now).toISOString()

    expect(buildDutyManagerBriefing(state, now).risks.flatMap((risk) => risk.sourceRiskIds)).not.toContain(incident!.riskId)
    expect(reconcileDutyManagerIncidents(state, now + 6 * 60_000)).toBe(true)
    expect(incident).toMatchObject({ status: 'open', deferredUntil: null })
    expect(buildDutyManagerBriefing(state, now + 6 * 60_000).risks.flatMap((risk) => risk.sourceRiskIds)).toContain(incident!.riskId)
  })
})
