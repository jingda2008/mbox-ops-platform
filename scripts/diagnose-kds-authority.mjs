import { writeFile } from 'node:fs/promises'
import process from 'node:process'
import pg from 'pg'

const { Client } = pg
const databaseUrl = process.env.DATABASE_URL
const tenantId = process.env.MBOX_TENANT_ID
const storeId = process.env.MBOX_STORE_UUID
const outputPath = process.env.MBOX_KDS_AUTHORITY_DIAGNOSTICS_PATH

if (!databaseUrl || !tenantId || !storeId) {
  throw new Error('DATABASE_URL, MBOX_TENANT_ID and MBOX_STORE_UUID are required')
}

function differences(authority, mirror, path = '') {
  if (Object.is(authority, mirror)) return []
  if (authority === null || mirror === null || typeof authority !== 'object' || typeof mirror !== 'object') {
    return [{ field: path || '$', authority, mirror }]
  }
  if (Array.isArray(authority) || Array.isArray(mirror)) {
    if (!Array.isArray(authority) || !Array.isArray(mirror)) {
      return [{ field: path || '$', authority, mirror }]
    }
    const keys = Array.from({ length: Math.max(authority.length, mirror.length) }, (_, index) => index)
    return keys.flatMap((key) => differences(authority[key], mirror[key], `${path}[${key}]`))
  }
  const keys = [...new Set([...Object.keys(authority), ...Object.keys(mirror)])].sort()
  return keys.flatMap((key) => differences(authority[key], mirror[key], path ? `${path}.${key}` : key))
}

const client = new Client({ connectionString: databaseUrl })
await client.connect()
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.store_id', $2, true)", [tenantId, storeId])
  const runtimeResult = await client.query(`
    SELECT revision, state #> '{orderDomain,kdsTasks}' AS kds_tasks
    FROM mbox.runtime_states
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
  `, [tenantId, storeId])
  const authorityResult = await client.query(`
    SELECT source_id, status, payload, snapshot_revision
    FROM mbox.operational_kds_tasks
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid
    ORDER BY source_id
  `, [tenantId, storeId])
  await client.query('COMMIT')

  const runtimeRow = runtimeResult.rows[0]
  if (!runtimeRow) throw new Error('runtime state is missing')
  const mirrorTasks = typeof runtimeRow.kds_tasks === 'string' ? JSON.parse(runtimeRow.kds_tasks) : runtimeRow.kds_tasks
  const mirrorById = new Map((mirrorTasks ?? []).map((task) => [task.id, task]))
  const authorityById = new Map(authorityResult.rows.map((row) => [row.source_id, row]))
  const taskIds = [...new Set([...mirrorById.keys(), ...authorityById.keys()])].sort()
  const mismatches = taskIds.flatMap((taskId) => {
    const authorityRow = authorityById.get(taskId)
    const mirror = mirrorById.get(taskId)
    if (!authorityRow) return [{ taskId, kind: 'missing_authority_row', fields: [] }]
    if (!mirror) return [{ taskId, kind: 'missing_runtime_mirror', fields: [] }]
    const authority = typeof authorityRow.payload === 'string' ? JSON.parse(authorityRow.payload) : authorityRow.payload
    const fields = differences(authority, mirror)
    const columnFields = [
      ['source_id', authorityRow.source_id, authority.id],
      ['status', authorityRow.status, authority.status],
      ['order_id', authorityRow.order_id, authority.orderId],
      ['order_item_id', authorityRow.order_item_id, authority.orderItemId],
      ['table_session_id', authorityRow.table_session_id, authority.tableSessionId],
      ['station_id', authorityRow.station_id, authority.stationId],
    ].filter(([, left, right]) => left !== undefined && left !== right)
      .map(([field, authorityValue, payloadValue]) => ({ field, authority: authorityValue, mirror: payloadValue }))
    if (fields.length === 0 && columnFields.length === 0) return []
    return [{
      taskId,
      kind: 'payload_mismatch',
      authoritySnapshotRevision: Number(authorityRow.snapshot_revision),
      runtimeRevision: Number(runtimeRow.revision),
      fields: [...columnFields, ...fields],
    }]
  })
  const report = {
    runtimeRevision: Number(runtimeRow.revision),
    authorityTaskCount: authorityResult.rowCount,
    mirrorTaskCount: mirrorTasks?.length ?? 0,
    mismatchCount: mismatches.length,
    mismatches,
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (outputPath) await writeFile(outputPath, serialized)
  process.stdout.write(serialized)
} finally {
  await client.end()
}
