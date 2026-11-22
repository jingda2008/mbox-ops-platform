import { z } from 'zod'
import type { ScopedTransaction } from './transaction-runner.js'

const timestamp = z.string().datetime({ offset: true })
const windowsJob = z.object({
  documentHash: z.string().regex(/^[0-9a-f]{64}$/),
  id: z.number().int().nonnegative(),
  status: z.string().max(180),
  submittedAt: timestamp.nullable(),
}).strict()
const observation = z.object({
  queue: z.string().min(1).max(180),
  checkedAt: timestamp,
  readable: z.boolean(),
  error: z.enum(['observer_unavailable', 'queue_read_failed', 'queue_missing']).nullable(),
  printerStatus: z.string().max(180).nullable(),
  driver: z.string().max(260).nullable(),
  port: z.string().max(260).nullable(),
  count: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  jobs: z.array(windowsJob).max(128),
}).strict().refine(row => row.readable
  ? row.error === null && row.count !== null && row.count >= row.jobs.length
  : row.error !== null && row.jobs.length === 0)

// Scope the probe to this bridge's active printer bindings, including devices that went offline.
export async function recordQueueObservations(tx: ScopedTransaction, bridgeId: string, input: unknown) {
  const scope = [tx.scope.tenantId, tx.scope.storeId, bridgeId]
  const devices = await tx.query<{ queue: string }>(`
    SELECT DISTINCT windows_queue_name AS queue FROM mbox.devices
    WHERE tenant_id=$1 AND store_id=$2 AND print_bridge_id=$3 AND status='active'
      AND device_type='printer' AND windows_queue_name IS NOT NULL ORDER BY queue LIMIT 8`, scope)
  const monitorQueues = devices.rows.map(device => device.queue)
  const parsed = z.array(observation).max(8).safeParse(input)
  // Malformed optional diagnostics must never interrupt the ordinary printing heartbeat.
  if (parsed.success) {
    const names = new Set<string>()
    const rows = parsed.data.filter(row => {
      if (!monitorQueues.includes(row.queue) || names.has(row.queue)) return false
      names.add(row.queue)
      return true
    })
    if (rows.length) await tx.query(`
      INSERT INTO mbox.print_queue_observations (tenant_id,store_id,bridge_id,queue_name,checked_at,observation)
      SELECT $1,$2,$3,entry->>'queue',(entry->>'checkedAt')::timestamptz,entry
      FROM jsonb_array_elements($4::jsonb) AS entry
      WHERE (entry->>'checkedAt')::timestamptz BETWEEN now()-interval '3 minutes' AND now()+interval '10 seconds'
      ON CONFLICT (tenant_id,store_id,bridge_id,queue_name) DO UPDATE
        SET observation=excluded.observation,checked_at=excluded.checked_at,received_at=clock_timestamp()
        WHERE mbox.print_queue_observations.checked_at<excluded.checked_at`, [...scope, JSON.stringify(rows)])
  }
  return monitorQueues
}
