import { createHash, randomUUID } from 'node:crypto'
import type { JsonObject } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type PerformerSongStatus = 'active' | 'inactive'

export interface PerformerSong {
  id: string
  performerId: string
  code: string | null
  title: string
  aliases: string[]
  metadata: JsonObject
  status: PerformerSongStatus
  requestCount: number
  performedCount: number
  createdAt: string
  updatedAt: string
}

export interface PerformerSongInput {
  code?: string | null
  title: string
  aliases?: readonly string[]
  metadata?: JsonObject
  status?: PerformerSongStatus
}

export interface PerformerSongImportResult {
  batchId: string
  publicId: string
  performerId: string
  mode: 'upsert' | 'replace'
  rowCount: number
  importedCount: number
  rejectedCount: number
  sourceSha256: string
}

interface SongRow extends Record<string, unknown> {
  id: string
  performer_id: string
  code: string | null
  title: string
  aliases: unknown
  metadata: unknown
  status: PerformerSongStatus
  request_count: string | number
  performed_count: string | number
  created_at: string
  updated_at: string
}

interface ImportRow extends Record<string, unknown> {
  id: string
  public_id: string
}

const SONG_COLUMNS = `
  song.id, song.performer_id, song.code, song.title,
  COALESCE((
    SELECT jsonb_agg(alias.alias ORDER BY alias.alias)
    FROM mbox.performer_song_aliases alias
    WHERE alias.tenant_id=song.tenant_id AND alias.store_id=song.store_id AND alias.song_id= song.id
  ), '[]'::jsonb) AS aliases,
  song.metadata, song.status,
  (SELECT count(*)::text FROM mbox.song_requests request
    WHERE request.tenant_id=song.tenant_id AND request.store_id=song.store_id
      AND (request.song_id=song.id OR (request.song_id IS NULL
        AND request.performer_id=song.performer_id AND lower(btrim(request.song_title))=song.normalized_title))) AS request_count,
  (SELECT count(*)::text FROM mbox.song_requests request
    WHERE request.tenant_id=song.tenant_id AND request.store_id=song.store_id
      AND (request.song_id=song.id OR (request.song_id IS NULL
        AND request.performer_id=song.performer_id AND lower(btrim(request.song_title))=song.normalized_title))
      AND request.status='performed') AS performed_count,
  song.created_at::text, song.updated_at::text
`

export class PerformerSongNotFoundError extends Error {
  constructor(id: string) {
    super(`Song was not found: ${id}`)
    this.name = 'PerformerSongNotFoundError'
  }
}

export class PerformerSongRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async findById(songId: string, forUpdate = false): Promise<PerformerSong | null> {
    const lock = forUpdate ? 'FOR UPDATE OF song' : ''
    const result = await this.transaction.query<SongRow>(`
      SELECT ${SONG_COLUMNS}
      FROM mbox.performer_songs song
      WHERE song.tenant_id=$1::uuid AND song.store_id=$2::uuid AND song.id=$3::uuid
      ${lock}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, songId])
    return result.rows[0] === undefined ? null : mapSong(result.rows[0])
  }

  async list(performerId: string, search = '', limit = 200): Promise<PerformerSong[]> {
    const normalizedSearch = search.trim().toLocaleLowerCase('zh-CN')
    const result = await this.transaction.query<SongRow>(`
      SELECT ${SONG_COLUMNS}
      FROM mbox.performer_songs song
      WHERE song.tenant_id=$1::uuid AND song.store_id=$2::uuid AND song.performer_id=$3::uuid
        AND song.status='active'
        AND (
          $4::text=''
          OR song.normalized_title ILIKE '%' || $4::text || '%'
          OR lower(COALESCE(song.code, '')) ILIKE '%' || $4::text || '%'
          OR EXISTS (
            SELECT 1 FROM mbox.performer_song_aliases alias
            WHERE alias.tenant_id=song.tenant_id AND alias.store_id=song.store_id
              AND alias.song_id=song.id AND alias.normalized_alias ILIKE '%' || $4::text || '%'
          )
        )
      ORDER BY song.title, song.code NULLS LAST, song.id
      LIMIT $5::integer
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, performerId, normalizedSearch, Math.min(1000, Math.max(1, limit))])
    return result.rows.map(mapSong)
  }

  async findCanonical(performerId: string, query: string): Promise<{ id: string; title: string } | null> {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    if (normalized === '') return null
    const result = await this.transaction.query<{ id: string; title: string }>(`
      SELECT song.id, song.title
      FROM mbox.performer_songs song
      WHERE song.tenant_id=$1::uuid AND song.store_id=$2::uuid
        AND song.performer_id=$3::uuid AND song.status='active'
        AND (
          song.normalized_title=$4::text OR lower(COALESCE(song.code, ''))=$4::text
          OR EXISTS (
            SELECT 1 FROM mbox.performer_song_aliases alias
            WHERE alias.tenant_id=song.tenant_id AND alias.store_id=song.store_id
              AND alias.song_id=song.id AND alias.normalized_alias=$4::text
          )
        )
      ORDER BY CASE WHEN song.normalized_title=$4::text THEN 0 ELSE 1 END, song.id
      LIMIT 1
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, performerId, normalized])
    return result.rows[0] ?? null
  }

  async findCanonicalTitle(performerId: string, query: string): Promise<string | null> {
    return (await this.findCanonical(performerId, query))?.title ?? null
  }

  async import(input: {
    performerId: string
    employeeId?: string | null
    sourceName: string
    mode: 'upsert' | 'replace'
    songs: readonly PerformerSongInput[]
    publicId?: string
  }): Promise<PerformerSongImportResult> {
    const songs = normalizeSongs(input.songs)
    if (songs.length > 5000 || (songs.length === 0 && input.mode !== 'replace')) {
      throw new TypeError('Song import must contain 1 to 5000 rows; an empty replacement is allowed')
    }
    const sourceName = input.sourceName.trim()
    if (sourceName.length === 0 || sourceName.length > 256) throw new TypeError('Song import sourceName is invalid')
    const serialized = JSON.stringify(songs)
    const sourceSha256 = createHash('sha256').update(serialized).digest('hex')
    const publicId = input.publicId ?? `song-import-${randomUUID()}`
    await this.transaction.query(`
      SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text || ':' || $3::text, 0))
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.performerId])
    const batch = await this.transaction.query<ImportRow>(`
      INSERT INTO mbox.performer_song_import_batches (
        tenant_id, store_id, performer_id, public_id, source_name, source_sha256,
        import_mode, status, row_count, created_by_employee_id
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,'processing',$8::integer,$9::uuid)
      RETURNING id, public_id
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, input.performerId,
      publicId, sourceName, sourceSha256, input.mode, songs.length, input.employeeId ?? null,
    ])
    const batchRow = requireOne(batch, 'song import batch')
    if (input.mode === 'replace') {
      await this.transaction.query(`
        DELETE FROM mbox.performer_song_aliases alias
        USING mbox.performer_songs song
        WHERE alias.tenant_id=$1::uuid AND alias.store_id=$2::uuid
          AND alias.song_id=song.id AND song.performer_id=$3::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.performerId])
      await this.transaction.query(`
        UPDATE mbox.performer_songs SET status='inactive', updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND performer_id=$3::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.performerId])
    }
    await this.transaction.query(`
      DELETE FROM mbox.performer_song_aliases alias
      USING mbox.performer_songs song
      WHERE alias.tenant_id=$1::uuid AND alias.store_id=$2::uuid
        AND alias.song_id=song.id AND song.performer_id=$3::uuid AND song.status='inactive'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.performerId])
    if (songs.length > 0) await this.transaction.query(`
      WITH incoming AS (
        SELECT row.code, row.title, row.aliases, row.metadata, row.status
        FROM jsonb_to_recordset($5::jsonb) AS row(
          code text, title text, aliases jsonb, metadata jsonb, status text
        )
      )
      INSERT INTO mbox.performer_songs (
        tenant_id, store_id, performer_id, import_batch_id, code, title, metadata, status
      )
      SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,
        NULLIF(btrim(incoming.code), ''), btrim(incoming.title), incoming.metadata,
        incoming.status
      FROM incoming
      ON CONFLICT (tenant_id, store_id, performer_id, normalized_title) DO UPDATE SET
        code=EXCLUDED.code, metadata=EXCLUDED.metadata, status=EXCLUDED.status,
        import_batch_id=EXCLUDED.import_batch_id, updated_at=clock_timestamp()
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.performerId, batchRow.id, serialized])
    if (songs.length > 0) await this.transaction.query(`
      DELETE FROM mbox.performer_song_aliases alias
      USING mbox.performer_songs song
      WHERE alias.tenant_id=$1::uuid AND alias.store_id=$2::uuid
        AND alias.song_id=song.id AND song.performer_id=$3::uuid AND song.import_batch_id=$4::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.performerId, batchRow.id])
    if (songs.length > 0) await this.transaction.query(`
      WITH incoming AS (
        SELECT row.title, row.aliases
        FROM jsonb_to_recordset($4::jsonb) AS row(title text, aliases jsonb)
      )
      INSERT INTO mbox.performer_song_aliases (tenant_id, store_id, performer_id, song_id, alias)
      SELECT $1::uuid,$2::uuid,$3::uuid,song.id,btrim(alias.value)
      FROM incoming
      JOIN mbox.performer_songs song
        ON song.tenant_id=$1::uuid AND song.store_id=$2::uuid AND song.performer_id=$3::uuid
        AND song.normalized_title=lower(btrim(incoming.title))
      CROSS JOIN LATERAL jsonb_array_elements_text(incoming.aliases) alias(value)
      ON CONFLICT DO NOTHING
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.performerId, serialized])
    await this.transaction.query(`
      UPDATE mbox.performer_song_import_batches
      SET status='completed', imported_count=row_count, rejected_count=0, completed_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, batchRow.id])
    return {
      batchId: batchRow.id,
      publicId: batchRow.public_id,
      performerId: input.performerId,
      mode: input.mode,
      rowCount: songs.length,
      importedCount: songs.length,
      rejectedCount: 0,
      sourceSha256,
    }
  }

  async update(songId: string, input: Partial<Omit<PerformerSongInput, 'aliases'>> & { aliases?: readonly string[] }): Promise<PerformerSong> {
    const current = await this.transaction.query<{ performer_id: string }>(`
      SELECT performer_id FROM mbox.performer_songs
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, songId])
    const performerId = current.rows[0]?.performer_id
    if (performerId === undefined) throw new PerformerSongNotFoundError(songId)
    if (Object.keys(input).length === 0) throw new TypeError('Song update must contain at least one change')
    const title = input.title === undefined ? null : normalizedTitle(input.title)
    const code = input.code === undefined ? null : normalizedCode(input.code)
    await this.transaction.query<{ id: string }>(`
      UPDATE mbox.performer_songs song SET
        code=CASE WHEN $4::boolean THEN $5::text ELSE song.code END,
        title=CASE WHEN $6::boolean THEN $7::text ELSE song.title END,
        metadata=CASE WHEN $8::boolean THEN $9::jsonb ELSE song.metadata END,
        status=CASE WHEN $10::boolean THEN $11::text ELSE song.status END,
        updated_at=clock_timestamp()
      WHERE song.tenant_id=$1::uuid AND song.store_id=$2::uuid AND song.id=$3::uuid
      RETURNING song.id
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId, songId,
      input.code !== undefined, code,
      input.title !== undefined, title,
      input.metadata !== undefined, JSON.stringify(input.metadata ?? {}),
      input.status !== undefined, input.status ?? 'active',
    ])
    if (input.aliases !== undefined) {
      const aliases = normalizeAliases(input.aliases)
      await this.transaction.query(`DELETE FROM mbox.performer_song_aliases WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND song_id=$3::uuid`, [this.transaction.scope.tenantId, this.transaction.scope.storeId, songId])
      if (aliases.length > 0) await this.transaction.query(`
        INSERT INTO mbox.performer_song_aliases (tenant_id, store_id, performer_id, song_id, alias)
        SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,alias
        FROM unnest($5::text[]) alias
        ON CONFLICT DO NOTHING
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, performerId, songId, aliases])
    }
    const refreshed = await this.transaction.query<SongRow>(`
      SELECT ${SONG_COLUMNS} FROM mbox.performer_songs song
      WHERE song.tenant_id=$1::uuid AND song.store_id=$2::uuid AND song.id=$3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, songId])
    return mapSong(requireOne(refreshed, 'song update'))
  }
}

export function normalizeSongs(values: readonly PerformerSongInput[]): Array<{ code: string | null; title: string; aliases: string[]; metadata: JsonObject; status: PerformerSongStatus }> {
  if (!Array.isArray(values)) throw new TypeError('Song import rows are invalid')
  const normalizedRows = values.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError(`Song import row ${index} is invalid`)
    }
    return {
      code: normalizedCode(value.code ?? null),
      title: normalizedTitle(value.title),
      aliases: normalizeAliases(value.aliases ?? []),
      metadata: value.metadata ?? {},
      status: value.status ?? 'active',
      index,
    }
  })
  const titles = new Set<string>()
  for (const row of normalizedRows) {
    const titleKey = row.title.toLocaleLowerCase('zh-CN')
    if (titles.has(titleKey)) throw new TypeError(`Song import contains duplicate title: ${row.title}`)
    titles.add(titleKey)
  }
  const codes = new Set<string>()
  const aliases = new Set<string>()
  return normalizedRows.map((row) => {
    const { code, title, index } = row
    if (code !== null) {
      const codeKey = code.toLocaleLowerCase('zh-CN')
      if (codes.has(codeKey)) throw new TypeError(`Song import contains duplicate code: ${code}`)
      codes.add(codeKey)
    }
    const songAliases = row.aliases
    for (const alias of songAliases) {
      const key = alias.toLocaleLowerCase('zh-CN')
      if (aliases.has(key) || titles.has(key)) throw new TypeError(`Song import contains duplicate alias: ${alias}`)
      aliases.add(key)
    }
    if (row.status !== 'active' && row.status !== 'inactive') throw new TypeError(`Song import row ${index} status is invalid`)
    if (!isObject(row.metadata)) throw new TypeError(`Song import row ${index} metadata is invalid`)
    return { code, title, aliases: songAliases, metadata: row.metadata as JsonObject, status: row.status }
  })
}

function normalizedTitle(value: string): string {
  if (typeof value !== 'string') throw new TypeError('Song title is invalid')
  const title = value.trim()
  if (title.length < 1 || title.length > 240) throw new TypeError('Song title is invalid')
  return title
}

function normalizedCode(value: string | null): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new TypeError('Song code is invalid')
  const code = value.trim()
  if (code.length < 1 || code.length > 64) throw new TypeError('Song code is invalid')
  return code
}

function normalizeAliases(values: readonly string[]): string[] {
  if (!Array.isArray(values)) throw new TypeError('Song aliases are invalid')
  const aliases = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') throw new TypeError('Song alias is invalid')
    const alias = value.trim()
    if (alias.length < 1 || alias.length > 240) throw new TypeError('Song alias is invalid')
    aliases.add(alias)
  }
  return [...aliases]
}

function mapSong(row: SongRow): PerformerSong {
  return {
    id: row.id,
    performerId: row.performer_id,
    code: row.code,
    title: row.title,
    aliases: Array.isArray(row.aliases) ? row.aliases.filter((value): value is string => typeof value === 'string') : [],
    metadata: isObject(row.metadata) ? row.metadata as JsonObject : {},
    status: row.status,
    requestCount: Number(row.request_count),
    performedCount: Number(row.performed_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireOne<Row extends Record<string, unknown>>(result: { rows: Row[]; rowCount: number | null }, action: string): Row {
  const row = result.rows[0]
  if (row === undefined) throw new Error(`${action} did not return a row`)
  return row
}
