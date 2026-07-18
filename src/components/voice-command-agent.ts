export const MAX_VOICE_COMMAND_STEPS = 5

export type VoiceCommandStepStatus = 'pending' | 'running' | 'completed' | 'blocked'
export type VoiceCommandPlanStatus = VoiceCommandStepStatus
export type VoiceCommandRisk = 'normal' | 'high'

export type VoiceCommandStepAction =
  | 'open_live'
  | 'select_table'
  | 'set_party_size'
  | 'assign_sales'
  | 'open_table_now'
  | 'execute_command'

export type VoiceCommandEntityValue = string | number | boolean

export interface VoiceCommandPlanStep {
  id: string
  position: number
  action: VoiceCommandStepAction
  label: string
  command: string
  entities: Readonly<Record<string, VoiceCommandEntityValue>>
  status: VoiceCommandStepStatus
  risk: VoiceCommandRisk
  riskTerms: readonly string[]
  blockedReason?: string
}

/**
 * A plan drives visible UI controls in order. It is not a server transaction:
 * completed steps are not rolled back when a later step fails or is blocked.
 */
export interface VoiceCommandPlan {
  source: string
  steps: readonly VoiceCommandPlanStep[]
  status: VoiceCommandPlanStatus
  risk: VoiceCommandRisk
  truncated: boolean
  omittedStepCount: number
  executionMode: 'sequential-ui'
  serverTransactionAtomic: false
  modelUsed: false
}

export interface VoiceCommandModelPlanningRequest {
  command: string
  maxSteps: number
}

export interface VoiceCommandModelSuggestedStep {
  label: string
  command: string
  action?: string
  entities?: Readonly<Record<string, VoiceCommandEntityValue>>
}

/**
 * Future model integrations may only suggest steps. Suggestions remain
 * untrusted and must still pass permission, risk, and live-state validation.
 */
export interface VoiceCommandModelAdapter {
  propose(request: VoiceCommandModelPlanningRequest): Promise<readonly VoiceCommandModelSuggestedStep[]>
}

export interface DeterministicVoiceCommandPlannerOptions {
  modelEnabled?: boolean
  modelAdapter?: VoiceCommandModelAdapter
  defaultOpenTablePartySize?: number
  defaultOpenTableSalesOwner?: string
}

const splitPattern = /[，,；;。！？!?\n]+|\s*(?:然后|接着|并且|同时|再(?!次))\s*/u
const terminalPunctuationPattern = /[，,；;。！？!?]+$/u
const compactOpenTablePattern = /^(?:请(?:帮我)?|帮我)?\s*([a-z]\d{1,4})\s*([0-9]{1,3}|[零〇一二两三四五六七八九十百]{1,6})\s*(?:位|人)(?:客人)?\s*(?:立即)?开台\s*(?:并(?:且)?|然后|接着|再|同时)\s*(?:销售)?归属(?:给|选择)?\s*([a-z][a-z0-9._'-]*(?:\s+[a-z][a-z0-9._'-]*)*|[\u3400-\u9fff·]{1,20})$/iu
const compactOpenTableWithoutSalesPattern = /^(?:请(?:帮我)?|帮我)?\s*([a-z]\d{1,4})\s*([0-9]{1,3}|[零〇一二两三四五六七八九十百]{1,6})\s*(?:位|人)(?:客人)?\s*(?:立即)?开台$/iu
const compactOpenTableWithDefaultsPattern = /^(?:请(?:帮我)?|帮我)?\s*([a-z]\d{1,4})\s*(?:立即)?开台$/iu

const highRiskTerms = [
  '支付',
  '付款',
  '收款',
  '退款',
  '权限',
  '授权',
  '删除',
  '发布',
  '作废',
  '撤销',
  '结台',
  '转桌',
  '换桌',
  '合台',
  '赠送',
  '折扣',
  '入库',
  '出库',
  '盘点',
  '报损',
  '改价',
  '审批',
  '清空',
  '重置',
  '密码',
  '密钥',
  'pin',
] as const

const chineseDigits: Readonly<Record<string, number>> = {
  '零': 0,
  '〇': 0,
  '一': 1,
  '二': 2,
  '两': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6,
  '七': 7,
  '八': 8,
  '九': 9,
}

const chineseUnits: Readonly<Record<string, number>> = {
  '十': 10,
  '百': 100,
}

interface CompactOpenTableCommand {
  tableCode: string
  partySize: number
  salesOwner: string
}

interface OpenTableDefaults {
  partySize?: number
  salesOwner?: string
}

function splitAll(command: string) {
  return command
    .trim()
    .split(splitPattern)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function parsePartySize(value: string) {
  if (/^\d+$/.test(value)) {
    const parsed = Number(value)
    return parsed >= 1 && parsed <= 999 ? parsed : null
  }

  let total = 0
  let digit = 0
  for (const character of value) {
    if (character in chineseDigits) {
      digit = chineseDigits[character]
      continue
    }

    const unit = chineseUnits[character]
    if (!unit) return null
    total += (digit || 1) * unit
    digit = 0
  }

  const parsed = total + digit
  return parsed >= 1 && parsed <= 999 ? parsed : null
}

function parseCompactOpenTableCommand(
  command: string,
  defaults: OpenTableDefaults = {},
): CompactOpenTableCommand | null {
  const normalized = command.trim().replace(terminalPunctuationPattern, '').trim()
  const completeMatch = normalized.match(compactOpenTablePattern)
  if (completeMatch) {
    const partySize = parsePartySize(completeMatch[2])
    if (partySize === null) return null

    return {
      tableCode: completeMatch[1].toUpperCase(),
      partySize,
      salesOwner: completeMatch[3].trim(),
    }
  }

  const withoutSalesMatch = normalized.match(compactOpenTableWithoutSalesPattern)
  if (withoutSalesMatch && defaults.salesOwner?.trim()) {
    const partySize = parsePartySize(withoutSalesMatch[2])
    if (partySize === null) return null
    return {
      tableCode: withoutSalesMatch[1].toUpperCase(),
      partySize,
      salesOwner: defaults.salesOwner.trim(),
    }
  }

  const withDefaultsMatch = normalized.match(compactOpenTableWithDefaultsPattern)
  const defaultPartySize = defaults.partySize
  if (
    withDefaultsMatch
    && Number.isInteger(defaultPartySize)
    && defaultPartySize !== undefined
    && defaultPartySize >= 1
    && defaultPartySize <= 999
    && defaults.salesOwner?.trim()
  ) {
    return {
      tableCode: withDefaultsMatch[1].toUpperCase(),
      partySize: defaultPartySize,
      salesOwner: defaults.salesOwner.trim(),
    }
  }

  return null
}

function matchingHighRiskTerms(command: string) {
  const normalized = command.toLocaleLowerCase('zh-CN')
  return highRiskTerms.filter((term) => normalized.includes(term))
}

export function classifyVoiceCommandRisk(command: string): VoiceCommandRisk {
  return matchingHighRiskTerms(command).length > 0 ? 'high' : 'normal'
}

function createStep(
  position: number,
  action: VoiceCommandStepAction,
  label: string,
  command: string,
  entities: Readonly<Record<string, VoiceCommandEntityValue>> = {},
): VoiceCommandPlanStep {
  const riskTerms = matchingHighRiskTerms(command)
  return {
    id: `voice-step-${position}`,
    position,
    action,
    label,
    command,
    entities,
    status: 'pending',
    risk: riskTerms.length > 0 ? 'high' : 'normal',
    riskTerms,
  }
}

function compactOpenTableSteps(command: CompactOpenTableCommand) {
  const { tableCode, partySize, salesOwner } = command
  return [
    createStep(1, 'open_live', '打开现场', '打开现场桌台'),
    createStep(2, 'select_table', `选择桌台 ${tableCode}`, `点击开台桌台${tableCode}`, { tableCode }),
    createStep(3, 'set_party_size', `填写人数 ${partySize}`, `客人人数输入${partySize}`, { partySize }),
    createStep(4, 'assign_sales', `销售归属 ${salesOwner}`, `销售归属选择 ${salesOwner}`, { salesOwner }),
    createStep(5, 'open_table_now', '立即开台', '点击立即开台'),
  ]
}

function derivePlanStatus(steps: readonly VoiceCommandPlanStep[]): VoiceCommandPlanStatus {
  if (steps.some((step) => step.status === 'blocked')) return 'blocked'
  if (steps.length > 0 && steps.every((step) => step.status === 'completed')) return 'completed'
  if (steps.some((step) => step.status === 'running' || step.status === 'completed')) return 'running'
  return 'pending'
}

function createPlan(
  source: string,
  steps: readonly VoiceCommandPlanStep[],
  omittedStepCount = 0,
): VoiceCommandPlan {
  return {
    source: source.trim(),
    steps,
    status: derivePlanStatus(steps),
    risk: steps.some((step) => step.risk === 'high') ? 'high' : 'normal',
    truncated: omittedStepCount > 0,
    omittedStepCount,
    executionMode: 'sequential-ui',
    serverTransactionAtomic: false,
    modelUsed: false,
  }
}

/**
 * Verification-stage planner. It is deliberately synchronous, deterministic,
 * and model-free even when an adapter is supplied with modelEnabled=false.
 */
export class DeterministicVoiceCommandPlanner {
  readonly modelEnabled = false
  private readonly openTableDefaults: OpenTableDefaults

  constructor(options: DeterministicVoiceCommandPlannerOptions = {}) {
    if (options.modelEnabled) {
      throw new Error('DeterministicVoiceCommandPlanner does not permit model calls')
    }
    this.openTableDefaults = {
      partySize: options.defaultOpenTablePartySize,
      salesOwner: options.defaultOpenTableSalesOwner?.trim(),
    }
  }

  split(command: string) {
    return splitAll(command).slice(0, MAX_VOICE_COMMAND_STEPS)
  }

  plan(command: string): VoiceCommandPlan {
    const compactCommand = parseCompactOpenTableCommand(command, this.openTableDefaults)
    if (compactCommand) return createPlan(command, compactOpenTableSteps(compactCommand))

    const segments = splitAll(command)
    const plannedSegments = segments.slice(0, MAX_VOICE_COMMAND_STEPS)
    const steps = plannedSegments.map((segment, index) => (
      createStep(index + 1, 'execute_command', segment, segment)
    ))
    return createPlan(command, steps, Math.max(0, segments.length - steps.length))
  }
}

export type VoiceCommandStepTransition = Exclude<VoiceCommandStepStatus, 'pending'>

/**
 * Advances one UI step without mutating the prior plan. Sequence checks do not
 * provide transaction atomicity; a later block intentionally preserves earlier
 * completed steps so the UI can report the real partial outcome.
 */
export function transitionVoiceCommandStep(
  plan: VoiceCommandPlan,
  stepIdOrPosition: string | number,
  nextStatus: VoiceCommandStepTransition,
  blockedReason?: string,
): VoiceCommandPlan {
  const stepIndex = plan.steps.findIndex((step) => (
    typeof stepIdOrPosition === 'number'
      ? step.position === stepIdOrPosition
      : step.id === stepIdOrPosition
  ))
  if (stepIndex < 0) throw new Error(`Unknown voice command step: ${stepIdOrPosition}`)

  const currentStep = plan.steps[stepIndex]
  const previousStepsComplete = plan.steps.slice(0, stepIndex).every((step) => step.status === 'completed')

  if (nextStatus === 'running') {
    if (currentStep.status !== 'pending') {
      throw new Error(`Step ${currentStep.id} must be pending before it can run`)
    }
    if (!previousStepsComplete || plan.steps.some((step) => step.status === 'running')) {
      throw new Error(`Step ${currentStep.id} cannot run before prior steps complete`)
    }
  }

  if (nextStatus === 'completed' && currentStep.status !== 'running') {
    throw new Error(`Step ${currentStep.id} must be running before it can complete`)
  }

  if (nextStatus === 'blocked') {
    if (currentStep.status !== 'pending' && currentStep.status !== 'running') {
      throw new Error(`Step ${currentStep.id} cannot be blocked from ${currentStep.status}`)
    }
    if (!previousStepsComplete) {
      throw new Error(`Step ${currentStep.id} cannot be blocked before prior steps complete`)
    }
  }

  const steps = plan.steps.map((step, index) => {
    if (index !== stepIndex) return step
    if (nextStatus === 'blocked') {
      return {
        ...step,
        status: nextStatus,
        blockedReason: blockedReason?.trim() || 'UI step could not continue',
      }
    }
    return { ...step, status: nextStatus, blockedReason: undefined }
  })

  return {
    ...plan,
    steps,
    status: derivePlanStatus(steps),
  }
}
