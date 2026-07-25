import { z } from 'zod'
import type { AnalyticsResult } from './analytics-contracts.js'

export const assistantServerToolIds = [
  'analytics.query',
  'table.open',
  'service.task.create',
  'service.task.schedule',
  'service.task.accept',
  'service.task.arrive',
  'service.task.complete',
] as const

export type AssistantServerToolId = typeof assistantServerToolIds[number]

export const assistantHumanWorkflowIds = [
  'payment.refund.request',
  'payment.refund.approve',
  'payment.pos.report',
  'payment.cash.confirm',
  'business_day.close',
  'config.publish',
  'inventory.approve',
  'benefit.approve',
  'commerce.authorization.approve',
  'table.close',
  'table.transfer',
] as const

export type AssistantHumanWorkflowId = typeof assistantHumanWorkflowIds[number]

export const assistantCapabilityIds = [
  ...assistantServerToolIds,
  ...assistantHumanWorkflowIds,
] as const

export type AssistantCapabilityId = typeof assistantCapabilityIds[number]
export type AssistantCapabilityExecutionMode = 'server_execute' | 'human_workflow'

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const assistantToolCallSchema = z.object({
  toolId: z.enum(assistantServerToolIds),
  arguments: z.record(z.string(), scalar).default({}),
}).strict()

export type AssistantToolCall = z.infer<typeof assistantToolCallSchema>

export const assistantToolExecutionRequestSchema = z.object({
  executionId: z.string().uuid(),
  toolCall: assistantToolCallSchema,
}).strict()

export type AssistantToolExecutionRequest = z.infer<typeof assistantToolExecutionRequestSchema>

export interface AssistantToolDescriptor {
  id: AssistantCapabilityId
  name: string
  description: string
  domain: 'analytics' | 'table' | 'service' | 'payment' | 'business_day' | 'config' | 'inventory' | 'benefit' | 'commerce'
  executionMode: AssistantCapabilityExecutionMode
  risk: 'normal' | 'high'
  requiredPermission: string
  argumentGuide: Record<string, string>
  aliases: string[]
  humanWorkflow?: {
    navigationId: string
    instruction: string
    resultGuard: string
    requiredAuditEvents: string[]
    separationOfDuties: boolean
  }
}

export interface AssistantToolExecutionResponse {
  executionId: string
  toolId: AssistantServerToolId
  status: 'completed'
  message: string
  objectType: string
  objectId: string
  replayed: boolean
  stateRevision: number
  evidence: {
    verified: true
    outcome: 'executed' | 'scheduled' | 'queried'
    tableCode?: string
    tableStatus?: string
    guestCount?: number
    taskStatus?: string
    scheduledAt?: string
    assigneeEmployeeId?: string
    assigneeName?: string
    analytics?: AnalyticsResult
  }
}
