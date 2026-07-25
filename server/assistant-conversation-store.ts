import { randomUUID } from 'node:crypto'
import type { AssistantConversationOutput } from '../src/shared/assistant-contracts.js'
import type { PostgresPool, PostgresPoolClient } from './postgres-repository.js'

const SESSION_RETENTION_MS = 7 * 24 * 60 * 60_000
const MAX_HISTORY_TURNS = 8

export interface AssistantStoredTurn {
  requestId: string
  userMessage: string
  output: AssistantConversationOutput
  model: string
  createdAt: string
}

export interface AssistantConversationSession {
  id: string
  actorId: string
  businessDate: string
  turns: AssistantStoredTurn[]
}

export interface AssistantConversationStore {
  init(): Promise<void>
  open(input: {
    sessionId?: string
    actorId: string
    businessDate: string
    now: number
  }): Promise<AssistantConversationSession>
  record(input: {
    sessionId: string
    actorId: string
    requestId: string
    userMessage: string
    output: AssistantConversationOutput
    model: string
    occurredAt: string
  }): Promise<AssistantStoredTurn>
}

function trimTurns(turns: readonly AssistantStoredTurn[]) {
  return structuredClone(turns.slice(-MAX_HISTORY_TURNS))
}

export class MemoryAssistantConversationStore implements AssistantConversationStore {
  readonly sessions = new Map<string, AssistantConversationSession & { expiresAt: number }>()

  async init() {}

  async open(input: { sessionId?: string; actorId: string; businessDate: string; now: number }) {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= input.now) this.sessions.delete(id)
    }
    if (input.sessionId) {
      const existing = this.sessions.get(input.sessionId)
      if (!existing || existing.actorId !== input.actorId || existing.businessDate !== input.businessDate) {
        throw new AssistantConversationSessionError('对话已过期，请重新开始', 404)
      }
      existing.expiresAt = input.now + SESSION_RETENTION_MS
      return { ...structuredClone(existing), turns: trimTurns(existing.turns) }
    }
    const session = {
      id: randomUUID(),
      actorId: input.actorId,
      businessDate: input.businessDate,
      turns: [],
      expiresAt: input.now + SESSION_RETENTION_MS,
    }
    this.sessions.set(session.id, session)
    return { ...structuredClone(session), turns: [] }
  }

  async record(input: {
    sessionId: string
    actorId: string
    requestId: string
    userMessage: string
    output: AssistantConversationOutput
    model: string
    occurredAt: string
  }) {
    const session = this.sessions.get(input.sessionId)
    if (!session || session.actorId !== input.actorId) {
      throw new AssistantConversationSessionError('对话已过期，请重新开始', 404)
    }
    const replay = session.turns.find((turn) => turn.requestId === input.requestId)
    if (replay) return structuredClone(replay)
    const turn = {
      requestId: input.requestId,
      userMessage: input.userMessage,
      output: structuredClone(input.output),
      model: input.model,
      createdAt: input.occurredAt,
    }
    session.turns.push(turn)
    session.expiresAt = Date.parse(input.occurredAt) + SESSION_RETENTION_MS
    return structuredClone(turn)
  }
}

const SET_CONTEXT_SQL = `
  SELECT
    set_config('app.tenant_id', $1, true) AS tenant_id,
    set_config('app.store_id', $2, true) AS store_id
`

interface PostgresAssistantConversationStoreOptions {
  pool: PostgresPool
  tenantId: string
  storeId: string
}

export class PostgresAssistantConversationStore implements AssistantConversationStore {
  constructor(private readonly options: PostgresAssistantConversationStoreOptions) {}

  async init() {
    await this.withTransaction(async (client) => {
      await client.query('SELECT session_id FROM mbox.assistant_conversation_sessions LIMIT 0')
      await client.query('SELECT request_id FROM mbox.assistant_conversation_turns LIMIT 0')
    })
  }

  async open(input: { sessionId?: string; actorId: string; businessDate: string; now: number }) {
    return this.withTransaction(async (client) => {
      await client.query(`DELETE FROM mbox.assistant_conversation_sessions WHERE expires_at <= $1::timestamptz`, [new Date(input.now).toISOString()])
      let sessionId = input.sessionId
      if (sessionId) {
        const existing = await client.query<{ session_id: string }>(`
          UPDATE mbox.assistant_conversation_sessions
          SET updated_at = $4::timestamptz, expires_at = $4::timestamptz + interval '7 days'
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND session_id = $3::uuid
            AND actor_id = $5 AND business_date = $6::date
          RETURNING session_id::text
        `, [this.options.tenantId, this.options.storeId, sessionId, new Date(input.now).toISOString(), input.actorId, input.businessDate])
        if (!existing.rows[0]) throw new AssistantConversationSessionError('对话已过期，请重新开始', 404)
      } else {
        sessionId = randomUUID()
        await client.query(`
          INSERT INTO mbox.assistant_conversation_sessions (
            tenant_id, store_id, session_id, actor_id, business_date, created_at, updated_at, expires_at
          ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '7 days')
        `, [this.options.tenantId, this.options.storeId, sessionId, input.actorId, input.businessDate, new Date(input.now).toISOString()])
      }
      const turns = await client.query<{
        request_id: string
        user_message: string
        output: AssistantConversationOutput
        model: string
        created_at: Date | string
      }>(`
        SELECT request_id::text, user_message, output, model, created_at
        FROM mbox.assistant_conversation_turns
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND session_id = $3::uuid
        ORDER BY created_at DESC LIMIT $4
      `, [this.options.tenantId, this.options.storeId, sessionId, MAX_HISTORY_TURNS])
      return {
        id: sessionId,
        actorId: input.actorId,
        businessDate: input.businessDate,
        turns: turns.rows.toReversed().map((row) => ({
          requestId: row.request_id,
          userMessage: row.user_message,
          output: row.output,
          model: row.model,
          createdAt: new Date(row.created_at).toISOString(),
        })),
      }
    })
  }

  async record(input: {
    sessionId: string
    actorId: string
    requestId: string
    userMessage: string
    output: AssistantConversationOutput
    model: string
    occurredAt: string
  }) {
    return this.withTransaction(async (client) => {
      const inserted = await client.query<{
        request_id: string
        user_message: string
        output: AssistantConversationOutput
        model: string
        created_at: Date | string
      }>(`
        INSERT INTO mbox.assistant_conversation_turns (
          tenant_id, store_id, session_id, request_id, actor_id,
          user_message, output, model, created_at
        ) SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::jsonb, $8, $9::timestamptz
        FROM mbox.assistant_conversation_sessions session
        WHERE session.tenant_id = $1::uuid AND session.store_id = $2::uuid
          AND session.session_id = $3::uuid AND session.actor_id = $5
        ON CONFLICT (tenant_id, store_id, session_id, request_id) DO NOTHING
        RETURNING request_id::text, user_message, output, model, created_at
      `, [
        this.options.tenantId, this.options.storeId, input.sessionId, input.requestId,
        input.actorId, input.userMessage, JSON.stringify(input.output), input.model, input.occurredAt,
      ])
      let row = inserted.rows[0]
      if (!row) {
        const replay = await client.query<typeof inserted.rows[number]>(`
          SELECT request_id::text, user_message, output, model, created_at
          FROM mbox.assistant_conversation_turns
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND session_id = $3::uuid AND request_id = $4::uuid AND actor_id = $5
        `, [this.options.tenantId, this.options.storeId, input.sessionId, input.requestId, input.actorId])
        row = replay.rows[0]
      }
      if (!row) throw new AssistantConversationSessionError('对话已过期，请重新开始', 404)
      return {
        requestId: row.request_id,
        userMessage: row.user_message,
        output: row.output,
        model: row.model,
        createdAt: new Date(row.created_at).toISOString(),
      }
    })
  }

  private async withTransaction<T>(operation: (client: PostgresPoolClient) => Promise<T>) {
    const client = await this.options.pool.connect()
    let transactionStarted = false
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      transactionStarted = true
      await client.query(SET_CONTEXT_SQL, [this.options.tenantId, this.options.storeId])
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

export class AssistantConversationSessionError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
    this.name = 'AssistantConversationSessionError'
  }
}
