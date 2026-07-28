import { describe, expect, it } from 'vitest'
import type { ServiceTypeConfig } from '../shared/contracts'
import {
  changeWorkflowLevel,
  isWorkflowLevelOptionDisabled,
  normalizeWorkflowServiceType,
  serviceTypeDraftInput,
  type WorkflowServiceTypeConfig,
} from './MasterDataView'

describe('MasterDataView service workflow configuration', () => {
  it('assigns safe defaults to legacy service types', () => {
    expect(normalizeWorkflowServiceType(serviceType({ code: 'ADD_WATER' }))).toMatchObject({
      workflowLevel: 'L1',
      allowBackupDirectComplete: true,
      allowCrossAreaComplete: true,
      requiresCompletionNote: false,
      duplicateSeconds: 30,
    })
    expect(normalizeWorkflowServiceType(serviceType({ code: 'ORDER_HELP' }))).toMatchObject({
      workflowLevel: 'L2',
      allowBackupDirectComplete: false,
      allowCrossAreaComplete: false,
    })
  })

  it('locks high-risk services to L3 and prevents downgrade', () => {
    const complaint = normalizeWorkflowServiceType(serviceType({
      code: 'COMPLAINT',
      workflowLevel: 'L1',
      allowBackupDirectComplete: true,
      allowCrossAreaComplete: true,
      requiresCompletionNote: false,
    }))

    expect(complaint).toMatchObject({
      workflowLevel: 'L3',
      allowBackupDirectComplete: false,
      allowCrossAreaComplete: false,
      requiresCompletionNote: true,
    })
    expect(isWorkflowLevelOptionDisabled(complaint, 'L2')).toBe(true)
    expect(isWorkflowLevelOptionDisabled(complaint, 'L3')).toBe(false)
    expect(changeWorkflowLevel(complaint, 'L1')).toBe(complaint)

    const customHighRisk = normalizeWorkflowServiceType(serviceType({ workflowLevel: 'L3' }))
    expect(isWorkflowLevelOptionDisabled(customHighRisk, 'L2', true)).toBe(true)
    expect(changeWorkflowLevel(customHighRisk, 'L2', true)).toBe(customHighRisk)
  })

  it('applies workflow invariants when an operator changes levels', () => {
    const quickService = normalizeWorkflowServiceType(serviceType({
      code: 'ADD_WATER',
      workflowLevel: 'L1',
      allowBackupDirectComplete: true,
      allowCrossAreaComplete: true,
    }))

    expect(changeWorkflowLevel(quickService, 'L0')).toMatchObject({
      workflowLevel: 'L0',
      allowBackupDirectComplete: false,
      allowCrossAreaComplete: false,
      requiresCompletionNote: false,
    })
    expect(changeWorkflowLevel(quickService, 'L3')).toMatchObject({
      workflowLevel: 'L3',
      allowBackupDirectComplete: false,
      allowCrossAreaComplete: false,
      requiresCompletionNote: true,
    })
  })

  it('keeps every workflow field in the configuration draft payload', () => {
    const configured = normalizeWorkflowServiceType(serviceType({
      code: 'CUSTOM_REQUEST',
      workflowLevel: 'L2',
      allowBackupDirectComplete: true,
      allowCrossAreaComplete: true,
      requiresCompletionNote: true,
      duplicateSeconds: 75,
    }))

    expect(serviceTypeDraftInput(configured)).toMatchObject({
      id: 'service-1',
      workflowLevel: 'L2',
      allowBackupDirectComplete: true,
      allowCrossAreaComplete: true,
      requiresCompletionNote: true,
      duplicateSeconds: 75,
    })
  })

  it('clamps the same-service merge window to the supported range', () => {
    expect(normalizeWorkflowServiceType(serviceType({ duplicateSeconds: -2 })).duplicateSeconds).toBe(0)
    expect(normalizeWorkflowServiceType(serviceType({ duplicateSeconds: 9_999 })).duplicateSeconds).toBe(3600)
  })
})

function serviceType(
  update: Partial<WorkflowServiceTypeConfig> = {},
): ServiceTypeConfig {
  return {
    id: 'service-1',
    code: 'CUSTOM_REQUEST',
    name: '个性化需求',
    icon: 'order',
    enabled: true,
    guestVisible: true,
    priority: 'normal',
    dispatchRoleIds: ['server'],
    sla: { warningSeconds: 30, escalateSeconds: 60, managerSeconds: 120 },
    customerReply: '已经收到',
    actionScript: ['确认需求'],
    ...update,
  }
}
