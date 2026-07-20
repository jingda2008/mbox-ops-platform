import { z } from 'zod'

export const assistantCapabilitySchema = z.object({
  id: z.string().trim().min(1).max(160),
  label: z.string().trim().min(1).max(100),
  command: z.string().trim().min(1).max(180),
  description: z.string().trim().max(180).default(''),
  risk: z.enum(['normal', 'high']),
  disabled: z.boolean().default(false),
})

export type AssistantCapability = z.infer<typeof assistantCapabilitySchema>

export const assistantTurnRequestSchema = z.object({
  requestId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(600),
  page: z.object({
    heading: z.string().trim().min(1).max(120),
    capabilities: z.array(assistantCapabilitySchema).max(120),
  }),
})

export type AssistantTurnRequest = z.infer<typeof assistantTurnRequestSchema>

export const assistantSuggestedStepSchema = z.object({
  label: z.string().trim().min(1).max(100),
  command: z.string().trim().min(1).max(180),
})

export type AssistantSuggestedStep = z.infer<typeof assistantSuggestedStepSchema>

export const assistantModelOutputSchema = z.object({
  kind: z.enum(['answer', 'clarification', 'plan']),
  reply: z.string().trim().min(1).max(800),
  steps: z.array(assistantSuggestedStepSchema).max(5).default([]),
  choices: z.array(z.string().trim().min(1).max(100)).max(6).default([]),
}).superRefine((output, context) => {
  if (output.kind === 'plan' && output.steps.length === 0) {
    context.addIssue({ code: 'custom', path: ['steps'], message: '执行计划至少需要一个步骤' })
  }
  if (output.kind !== 'plan' && output.steps.length > 0) {
    context.addIssue({ code: 'custom', path: ['steps'], message: '非计划响应不能包含执行步骤' })
  }
  if (output.kind === 'clarification' && output.choices.length === 0) {
    context.addIssue({ code: 'custom', path: ['choices'], message: '追问响应至少需要一个候选' })
  }
})

export type AssistantModelOutput = z.infer<typeof assistantModelOutputSchema>

export interface AssistantTurnResponse extends AssistantModelOutput {
  sessionId: string
  model: string
  modelUsed: boolean
  replayed: boolean
}

export interface AssistantConversationMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export type DutyManagerRiskSeverity = 'critical' | 'high' | 'medium' | 'info'
export type DutyManagerRiskCategory = 'system' | 'service' | 'fulfillment' | 'staffing' | 'sop' | 'approval' | 'reservation' | 'hardware'
export type DutyManagerIncidentStatus = 'open' | 'acknowledged' | 'deferred' | 'dismissed' | 'resolved'

export interface DutyManagerIncident {
  id: string
  riskId: string
  cycle: number
  businessDate: string
  severity: DutyManagerRiskSeverity
  category: DutyManagerRiskCategory
  title: string
  detail: string
  tableCode: string | null
  recommendedCommand: string
  status: DutyManagerIncidentStatus
  firstDetectedAt: string
  lastDetectedAt: string
  observationCount: number
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  deferredAt: string | null
  deferredBy: string | null
  deferredUntil: string | null
  dismissedAt: string | null
  dismissedBy: string | null
  dismissedReason: string | null
  resolvedAt: string | null
  resolvedBy: string | null
  resolution: 'source_cleared' | 'dismissed_false_positive' | null
}

export interface DutyManagerRisk {
  id: string
  severity: DutyManagerRiskSeverity
  category: DutyManagerRiskCategory
  title: string
  detail: string
  tableCode: string | null
  ownerName: string | null
  recommendedCommand: string
  detectedAt: string
  occurrences: number
  sourceRiskIds: string[]
  incidentIds: string[]
  incidentStatus: Exclude<DutyManagerIncidentStatus, 'dismissed' | 'resolved'>
  handledByName: string | null
}

export interface DutyManagerBriefing {
  generatedAt: string
  businessDate: string
  health: 'critical' | 'attention' | 'stable'
  headline: string
  counts: {
    critical: number
    high: number
    medium: number
    openServiceTasks: number
    overdueFulfillmentTasks: number
    blockedSopExecutions: number
    pendingApprovals: number
    activeIncidents: number
    unacknowledgedIncidents: number
    acknowledgedIncidents: number
    deferredIncidents: number
  }
  actions: {
    canAcknowledge: boolean
    canManage: boolean
  }
  risks: DutyManagerRisk[]
}

export const dutyManagerActionSchema = z.object({
  idempotencyKey: z.string().uuid(),
  action: z.enum(['acknowledge', 'defer', 'dismiss_false_positive']),
  riskIds: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
  deferMinutes: z.number().int().min(5).max(120).optional(),
  note: z.string().trim().max(240).optional(),
}).superRefine((input, context) => {
  if (input.action === 'defer' && input.deferMinutes === undefined) {
    context.addIssue({ code: 'custom', path: ['deferMinutes'], message: '延后处理必须填写分钟数' })
  }
  if (input.action === 'dismiss_false_positive' && (!input.note || input.note.length < 2)) {
    context.addIssue({ code: 'custom', path: ['note'], message: '标记误报必须记录复核原因' })
  }
})

export type DutyManagerActionInput = z.infer<typeof dutyManagerActionSchema>

export interface DutyManagerActionResponse {
  message: string
  replayed: boolean
  briefing: DutyManagerBriefing
}

export interface DutyManagerHandover {
  generatedAt: string
  businessDate: string
  summary: string
  detected: number
  active: number
  acknowledged: number
  deferred: number
  dismissed: number
  resolved: number
  averageAcknowledgeMinutes: number | null
  oldestActiveMinutes: number | null
}
