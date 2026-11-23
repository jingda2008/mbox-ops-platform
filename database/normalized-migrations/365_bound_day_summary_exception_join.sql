BEGIN;

-- Under mixed store statistics PostgreSQL can execute a correlated EXISTS
-- inside the paid-order projection once for each order. Deduplicate exception
-- keys once and join them as a relation. Keep the schema-364 money formulas.
DO $migration$
DECLARE
  definition text := pg_get_functiondef('mbox.operating_day_summaries(uuid,uuid,date,date)'::regprocedure);
  updated text;
BEGIN
  updated := replace(definition,'), exceptional_orders AS (','), exception_sources AS (');
  updated := replace(updated,'), classified AS MATERIALIZED (',
    '), exceptional_orders AS MATERIALIZED (
       SELECT DISTINCT order_id FROM exception_sources
     ), classified AS MATERIALIZED (');
  updated := replace(updated,'AND NOT EXISTS(SELECT 1 FROM exceptional_orders e WHERE e.order_id=o.id) AS ordinary_paid',
    'AND e.order_id IS NULL AS ordinary_paid');
  updated := replace(updated,'FROM window_orders o LEFT JOIN receipts p ON p.order_id=o.id',
    'FROM window_orders o LEFT JOIN receipts p ON p.order_id=o.id
     LEFT JOIN exceptional_orders e ON e.order_id=o.id');
  IF position('SELECT DISTINCT order_id FROM exception_sources' IN updated)=0
    OR position('exception_sources AS (' IN updated)=0
    OR position('AND e.order_id IS NULL AS ordinary_paid' IN updated)=0
    OR position('LEFT JOIN exceptional_orders e ON e.order_id=o.id' IN updated)=0 THEN
    RAISE EXCEPTION 'Unexpected operating_day_summaries definition';
  END IF;
  EXECUTE updated;
END $migration$;

UPDATE mbox.normalized_schema_metadata SET schema_version='365',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
