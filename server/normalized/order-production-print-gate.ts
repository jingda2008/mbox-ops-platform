// Production snapshots can also belong to an independently authorized activity meal.
// Reprints preserve both the source outbox ID and the original ticket reference.
export const productionPrintClaimSql = `CASE
  WHEN job.print_snapshot->>'kind' IN ('bar_production','kitchen_production')
    AND job.print_snapshot->'test' IS DISTINCT FROM 'true'::jsonb THEN
      EXISTS (SELECT 1 FROM mbox.orders ord JOIN mbox.outbox_messages source
        ON (source.tenant_id,source.store_id,source.id,source.aggregate_id)=(ord.tenant_id,ord.store_id,job.source_outbox_message_id,ord.id)
          AND source.aggregate_type='order'
        WHERE (ord.tenant_id,ord.store_id,ord.public_id)=(job.tenant_id,job.store_id,job.print_snapshot->>'ticketReference')
          AND mbox.order_production_allowed(ord.tenant_id,ord.store_id,ord.id))
      OR EXISTS (SELECT 1 FROM mbox.print_source_jobs source
        WHERE (source.tenant_id,source.store_id,source.source_outbox_message_id)=(job.tenant_id,job.store_id,job.source_outbox_message_id)
          AND source.ticket_kind='activity_production' AND source.aggregate_id::text=job.print_snapshot->>'ticketReference')
  ELSE true END`
