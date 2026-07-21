import { describe, expect, it } from 'vitest'
import { sopRuleSchema, type SopRule, type SopStep } from './sop-contracts.js'

function step(id: string, dependsOnStepIds: string[] = []): SopStep {
  return {
    id, name: id, timing: 'after_trigger', delaySeconds: 0,
    action: {
      type: 'create_service_task', serviceTypeId: 'water', dispatchRoleIds: ['server'],
      noteTemplate: '{table}执行服务。',
    },
    routing: {
      dependsOnStepIds, dependencyMode: 'all', conditions: [], conditionMode: 'all',
      onConditionFalse: 'skip', onFailure: 'stop', compensationStepId: null, compensationOnly: false,
    },
  }
}

function rule(steps: SopStep[]): SopRule {
  return {
    id: 'advanced-sop', name: '高级SOP', description: '', enabled: true,
    trigger: { event: 'table_opened', serviceTypeIds: [], productCategoryIds: [], workstationIds: [] },
    scope: { areaIds: [], tableIds: [] }, conditions: [], stopConditions: ['table_closed'], steps,
  }
}

describe('advanced SOP contracts', () => {
  it('accepts a directed acyclic dependency graph', () => {
    expect(sopRuleSchema.safeParse(rule([
      step('arrive'), step('drinks', ['arrive']), step('table-care', ['arrive']), step('follow-up', ['drinks', 'table-care']),
    ])).success).toBe(true)
  })

  it('rejects circular step dependencies', () => {
    const parsed = sopRuleSchema.safeParse(rule([step('one', ['two']), step('two', ['one'])]))
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.message.includes('循环'))).toBe(true)
  })

  it('requires a compensation target to be a dormant compensation step', () => {
    const source = step('source')
    source.routing = { ...source.routing!, onFailure: 'run_compensation', compensationStepId: 'fallback' }
    const parsed = sopRuleSchema.safeParse(rule([source, step('fallback')]))
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.message.includes('仅失败时执行'))).toBe(true)
  })
})
