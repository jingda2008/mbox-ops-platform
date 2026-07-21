import { describe, expect, it } from 'vitest'
import { AssistantConversationSessionError, MemoryAssistantConversationStore } from './assistant-conversation-store.js'

const output = {
  kind: 'answer' as const,
  reply: '当前没有待处理服务任务。',
  steps: [],
  choices: [],
}

describe('assistant conversation store', () => {
  it('isolates sessions by employee and replays the same request idempotently', async () => {
    const store = new MemoryAssistantConversationStore()
    const session = await store.open({ actorId: 'emp-lin', businessDate: '2026-07-18', now: 1_000 })
    const first = await store.record({
      sessionId: session.id,
      actorId: 'emp-lin',
      requestId: '00000000-0000-4000-8000-000000000001',
      userMessage: '我有什么任务',
      output,
      model: 'gemini-3.5-flash',
      occurredAt: new Date(1_000).toISOString(),
    })
    const replay = await store.record({
      sessionId: session.id,
      actorId: 'emp-lin',
      requestId: first.requestId,
      userMessage: '我有什么任务',
      output,
      model: 'gemini-3.5-flash',
      occurredAt: new Date(2_000).toISOString(),
    })

    expect(replay).toEqual(first)
    await expect(store.open({ sessionId: session.id, actorId: 'emp-wu', businessDate: '2026-07-18', now: 3_000 }))
      .rejects.toBeInstanceOf(AssistantConversationSessionError)
  })

  it('expires conversations after the bounded retention period', async () => {
    const store = new MemoryAssistantConversationStore()
    const session = await store.open({ actorId: 'emp-lin', businessDate: '2026-07-18', now: 0 })

    await expect(store.open({
      sessionId: session.id,
      actorId: 'emp-lin',
      businessDate: '2026-07-18',
      now: 8 * 24 * 60 * 60_000,
    })).rejects.toBeInstanceOf(AssistantConversationSessionError)
  })
})
