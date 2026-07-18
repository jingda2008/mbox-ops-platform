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
