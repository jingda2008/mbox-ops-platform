import type { JsonObject } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type PerformerStatus = 'active' | 'inactive'

export interface Performer {
  id: string
  code: string
  stageName: string
  profileSnapshot: JsonObject
  songCatalog: JsonObject[]
  status: PerformerStatus
  createdAt: string
  updatedAt: string
}

export interface CreatePerformerInput {
  code: string
  stageName: string
  profileSnapshot?: JsonObject
  songCatalog?: readonly JsonObject[]
  status?: PerformerStatus
}

export interface UpdatePerformerInput {
  performerId: string
  stageName?: string
  profileSnapshot?: JsonObject
  songCatalog?: readonly JsonObject[]
  status?: PerformerStatus
}

interface PerformerRow extends Record<string, unknown> {
  id: string
  code: string
  stage_name: string
  profile_snapshot: unknown
  song_catalog: unknown
  status: PerformerStatus
  created_at: string
  updated_at: string
}

const PERFORMER_COLUMNS = `
  id, code, stage_name, profile_snapshot, song_catalog, status,
  created_at::text, updated_at::text
`

export class PerformerNotFoundError extends Error {
  constructor(id: string) {
    super(`Performer was not found: ${id}`)
    this.name = 'PerformerNotFoundError'
  }
}

export class PerformerRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async findById(id: string, forUpdate = false): Promise<Performer | null> {
    const lock = forUpdate ? 'FOR UPDATE' : ''
    const result = await this.transaction.query<PerformerRow>(`
      SELECT ${PERFORMER_COLUMNS}
      FROM mbox.performers
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      ${lock}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
    return result.rows[0] === undefined ? null : mapPerformer(result.rows[0])
  }

  async listActive(): Promise<Performer[]> {
    const result = await this.transaction.query<PerformerRow>(`
      SELECT ${PERFORMER_COLUMNS}
      FROM mbox.performers
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND status = 'active'
      ORDER BY stage_name, code, id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    return result.rows.map(mapPerformer)
  }

  async create(input: Readonly<CreatePerformerInput>): Promise<Performer> {
    validateCreate(input)
    const inserted = await this.transaction.query<PerformerRow>(`
      INSERT INTO mbox.performers (
        tenant_id, store_id, code, stage_name, profile_snapshot, song_catalog, status
      ) VALUES (
        $1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7
      )
      RETURNING ${PERFORMER_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.code.trim(),
      input.stageName.trim(),
      JSON.stringify(input.profileSnapshot ?? {}),
      JSON.stringify(input.songCatalog ?? []),
      input.status ?? 'active',
    ])
    return mapPerformer(requireOne(inserted, 'performer insert'))
  }

  async update(input: Readonly<UpdatePerformerInput>): Promise<Performer> {
    validateUpdate(input)
    const current = await this.findById(input.performerId, true)
    if (current === null) throw new PerformerNotFoundError(input.performerId)

    const updated = await this.transaction.query<PerformerRow>(`
      UPDATE mbox.performers
      SET stage_name = CASE WHEN $4::boolean THEN $5 ELSE stage_name END,
          profile_snapshot = CASE WHEN $6::boolean THEN $7::jsonb ELSE profile_snapshot END,
          song_catalog = CASE WHEN $8::boolean THEN $9::jsonb ELSE song_catalog END,
          status = COALESCE($10, status)
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      RETURNING ${PERFORMER_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.performerId,
      input.stageName !== undefined,
      input.stageName?.trim() ?? null,
      input.profileSnapshot !== undefined,
      JSON.stringify(input.profileSnapshot ?? {}),
      input.songCatalog !== undefined,
      JSON.stringify(input.songCatalog ?? []),
      input.status ?? null,
    ])
    return mapPerformer(requireOne(updated, 'performer update'))
  }
}

function validateCreate(input: Readonly<CreatePerformerInput>): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(input.code.trim())) {
    throw new TypeError('Performer code is invalid')
  }
  if (input.stageName.trim().length === 0) throw new TypeError('Performer stageName must not be blank')
  validateSongCatalog(input.songCatalog ?? [])
}

function validateUpdate(input: Readonly<UpdatePerformerInput>): void {
  if (input.performerId.trim().length === 0) throw new TypeError('performerId must not be blank')
  if (input.stageName !== undefined && input.stageName.trim().length === 0) {
    throw new TypeError('Performer stageName must not be blank')
  }
  if (input.songCatalog !== undefined) validateSongCatalog(input.songCatalog)
  if (
    input.stageName === undefined
    && input.profileSnapshot === undefined
    && input.songCatalog === undefined
    && input.status === undefined
  ) {
    throw new TypeError('Performer update must contain at least one change')
  }
}

export function validateSongCatalog(catalog: readonly JsonObject[]): void {
  const keys = new Set<string>()
  for (const [index, song] of catalog.entries()) {
    const title = song.title
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new TypeError(`Song catalog item ${index} must have a title`)
    }
    const code = song.code
    if (code !== undefined && (typeof code !== 'string' || code.trim().length === 0)) {
      throw new TypeError(`Song catalog item ${index} code is invalid`)
    }
    const key = `${typeof code === 'string' ? code : ''}:${title}`.toLocaleLowerCase('zh-CN')
    if (keys.has(key)) throw new TypeError(`Song catalog contains a duplicate item: ${title}`)
    keys.add(key)
    if (song.aliases !== undefined && (
      !Array.isArray(song.aliases)
      || song.aliases.some((alias) => typeof alias !== 'string' || alias.trim().length === 0)
    )) {
      throw new TypeError(`Song catalog item ${index} aliases are invalid`)
    }
  }
}

function mapPerformer(row: PerformerRow): Performer {
  return {
    id: row.id,
    code: row.code,
    stageName: row.stage_name,
    profileSnapshot: asJsonObject(row.profile_snapshot),
    songCatalog: asJsonObjectArray(row.song_catalog),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function asJsonObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as JsonObject
}

function asJsonObjectArray(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is JsonObject => (
    typeof item === 'object' && item !== null && !Array.isArray(item)
  ))
}

function requireOne<Row extends Record<string, unknown>>(
  result: { rows: Row[]; rowCount: number | null },
  action: string,
): Row {
  const row = result.rows[0]
  if (result.rowCount !== 1 || row === undefined) throw new Error(`${action} did not affect exactly one row`)
  return row
}
