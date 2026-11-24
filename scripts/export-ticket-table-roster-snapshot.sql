-- psql -X -qAt -v tenant_id=<uuid> -v store_id=<uuid> -f <this-file>
-- Run with a separately authorized read-only scoped account. Not an importer.
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL TIME ZONE 'UTC';

-- Suppress both setup return values: stdout is exactly one JSON document.
SELECT set_config('app.tenant_id', (:'tenant_id'::uuid)::text, true) AS scoped_tenant,
       set_config('app.store_id', (:'store_id'::uuid)::text, true) AS scoped_store
\gset

SELECT EXISTS (
  SELECT 1 FROM mbox.stores
  WHERE (tenant_id, id) = (mbox.current_tenant_id(), mbox.current_store_id())
) AS store_found
\gset
\if :store_found
SELECT jsonb_build_object(
  'tenantId', mbox.current_tenant_id(),
  'storeId', mbox.current_store_id(),
  'capturedAt', to_char(statement_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'tables', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', t.id, 'code', t.code, 'areaCode', a.code,
      'status', t.status, 'areaStatus', a.status
    ) ORDER BY t.id)
    FROM mbox.tables t
    LEFT JOIN mbox.areas a
      ON (a.tenant_id, a.store_id, a.id) = (t.tenant_id, t.store_id, t.area_id)
    WHERE (t.tenant_id, t.store_id) = (mbox.current_tenant_id(), mbox.current_store_id())
  ), '[]'::jsonb),
  'existingTicketTableIds', COALESCE((
    SELECT jsonb_agg(r.table_id ORDER BY r.table_id)
    FROM mbox.ticket_table_roster r
    WHERE (r.tenant_id, r.store_id) = (mbox.current_tenant_id(), mbox.current_store_id())
  ), '[]'::jsonb)
);
\else
-- Deliberate SQL error under ON_ERROR_STOP: missing scope must not look empty.
DO $$ BEGIN RAISE EXCEPTION 'Ticket table snapshot: store not visible in requested tenant scope'; END $$;
\endif
ROLLBACK;
