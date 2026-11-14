import type { ScopedTransaction } from './transaction-runner.js'
import { StaffAccessRepository, StaffAccessDeniedError } from './staff-access-repository.js'
import { printAlertStations, type PrintAlertSnapshot, type PrintAlertStation } from '../../src/shared/print-alerts.js'

/** A read-only live alarm. A missing heartbeat is not proof of a missing paper. */
export async function readPrintAlerts(tx: ScopedTransaction, employeeId: string): Promise<PrintAlertSnapshot> {
  const access = await new StaffAccessRepository(tx).resolve(employeeId)
  const stations = printAlertStations(access.permissions)
  if (!stations.length) throw new StaffAccessDeniedError('当前岗位无打印提醒查看权限')
  const manager = access.permissions.some(p => ['printer.manage', 'hardware.manage', 'print.view_all'].includes(p))
  const rows = await tx.query<{
    station: PrintAlertStation; failed: string; stalled: string; oldest_at: string;
    newest_key: string; escalated: boolean; as_of: string
  }>(`
    WITH attention AS (
      SELECT job.station_code AS station, job.id::text AS alert_key,
        job.status IN ('failed','dead') AS failed,
        CASE WHEN job.status IN ('failed','dead') THEN
          COALESCE((SELECT min(event.occurred_at) FROM mbox.print_job_events event
            WHERE (event.tenant_id,event.store_id,event.print_job_id)=(job.tenant_id,job.store_id,job.id)
              AND event.to_status IN ('failed','dead')),job.dead_at,job.updated_at)
          ELSE COALESCE(job.locked_at,GREATEST(job.available_at,job.created_at)) + interval '90 seconds' END AS since
      FROM mbox.print_jobs job
      WHERE job.tenant_id=$1 AND job.store_id=$2 AND job.station_code=ANY($3::text[])
        AND (job.status IN ('failed','dead') OR
          (job.status IN ('pending','printing') AND
            COALESCE(job.locked_at,GREATEST(job.available_at,job.created_at))<=CURRENT_TIMESTAMP-interval '90 seconds'))
        AND NOT EXISTS (SELECT 1 FROM mbox.print_jobs replacement
          WHERE (replacement.tenant_id,replacement.store_id,replacement.reprint_of_job_id)=(job.tenant_id,job.store_id,job.id)
            AND replacement.status='printed')
        AND NOT EXISTS (SELECT 1 FROM mbox.print_incidents verified
          WHERE (verified.tenant_id,verified.store_id,verified.job_id)=(job.tenant_id,job.store_id,job.id)
            AND verified.status='resolved' AND verified.resolution='paper_confirmed')
      UNION ALL
      SELECT 'generation',source.id::text,source.status IN ('retry','dead'),
        CASE WHEN source.status='pending' THEN GREATEST(source.next_attempt_at,source.created_at)+interval '90 seconds'
          ELSE source.created_at END
      FROM mbox.print_source_jobs source
      WHERE source.tenant_id=$1 AND source.store_id=$2 AND 'generation'=ANY($3::text[])
        AND (source.status IN ('retry','dead') OR
          (source.status='pending' AND GREATEST(source.next_attempt_at,source.created_at)<=CURRENT_TIMESTAMP-interval '90 seconds'))
      UNION ALL
      SELECT 'diagnostics',incident.id::text || ':' || (extract(epoch FROM incident.episode_started_at)*1000)::bigint::text,
        true,incident.episode_started_at
      FROM mbox.print_incidents incident
      WHERE incident.tenant_id=$1 AND incident.store_id=$2 AND 'diagnostics'=ANY($3::text[])
        AND incident.status IN ('open','claimed')
    )
    SELECT station,count(*) FILTER(WHERE failed)::text AS failed,
      count(*) FILTER(WHERE NOT failed)::text AS stalled,min(since)::text AS oldest_at,
      (array_agg(alert_key ORDER BY since DESC,alert_key DESC))[1] AS newest_key,
      -- Source creation time is not the first failure time. Without a durable
      -- failure timestamp, show the source alarm without claiming its duration.
      station<>'generation' AND min(since)<=CURRENT_TIMESTAMP-interval '3 minutes' AS escalated,
      CURRENT_TIMESTAMP::text AS as_of
    FROM attention GROUP BY station ORDER BY station
  `, [tx.scope.tenantId, tx.scope.storeId, stations])
  return {
    asOf: rows.rows[0] ? new Date(rows.rows[0].as_of).toISOString() : new Date().toISOString(), manager,
    alerts: rows.rows.map(row => ({station: row.station, failed: Number(row.failed), stalled: Number(row.stalled),
      oldestAt: new Date(row.oldest_at).toISOString(), newestKey: row.newest_key, escalated: row.escalated})),
  }
}
