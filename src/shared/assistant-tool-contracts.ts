import { z } from 'zod'

export const assistantServerToolIds = [
  'table.open',
  'service.task.create',
  'service.task.schedule',
  'service.task.accept',
  'service.task.arrive',
  'service.task.complete',
] as const

export type AssistantServerToolId = typeof assistantServerToolIds[number]

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
  id: AssistantServerToolId
  name: string
  description: string
  risk: 'normal' | 'high'
  requiredPermission: string
  argumentGuide: Record<string, string>
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
    outcome: 'executed' | 'scheduled'
    tableCode?: string
    tableStatus?: string
    guestCount?: number
    taskStatus?: string
    scheduledAt?: string
    assigneeEmployeeId?: string
    assigneeName?: string
  }
}
