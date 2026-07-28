BEGIN;

ALTER TABLE mbox.operational_service_tasks
  ADD COLUMN workflow_level text,
  ADD COLUMN request_count integer,
  ADD COLUMN last_requested_at timestamptz,
  ADD COLUMN completed_by text;

UPDATE mbox.operational_service_tasks
SET workflow_level = COALESCE(payload->>'workflowLevel', 'L3'),
    request_count = GREATEST(1, COALESCE((payload->>'requestCount')::integer, 1)),
    last_requested_at = COALESCE((payload->>'lastRequestedAt')::timestamptz, created_at),
    completed_by = NULLIF(payload->>'completedBy', '');

ALTER TABLE mbox.operational_service_tasks
  ALTER COLUMN workflow_level SET NOT NULL,
  ALTER COLUMN request_count SET NOT NULL,
  ALTER COLUMN last_requested_at SET NOT NULL,
  ADD CONSTRAINT operational_service_tasks_workflow_level_check
    CHECK (workflow_level IN ('L0', 'L1', 'L2', 'L3')),
  ADD CONSTRAINT operational_service_tasks_request_count_check
    CHECK (request_count >= 1);

CREATE INDEX operational_service_tasks_workflow_idx
  ON mbox.operational_service_tasks
    (tenant_id, store_id, workflow_level, status, last_requested_at DESC)
  WHERE archived_at IS NULL;

ALTER TABLE mbox.operational_order_items
  ADD COLUMN fulfillment_type text;

UPDATE mbox.operational_order_items
SET fulfillment_type = COALESCE(
  payload->>'fulfillmentType',
  CASE WHEN COALESCE((payload->>'requiresFulfillment')::boolean, true)
    THEN 'made_to_order'
    ELSE 'no_fulfillment'
  END
);

ALTER TABLE mbox.operational_order_items
  ALTER COLUMN fulfillment_type SET NOT NULL,
  ADD CONSTRAINT operational_order_items_fulfillment_type_check
    CHECK (fulfillment_type IN ('ready_to_serve', 'made_to_order', 'service_only', 'no_fulfillment'));

CREATE INDEX operational_order_items_fulfillment_type_idx
  ON mbox.operational_order_items
    (tenant_id, store_id, fulfillment_type, fulfillment_status, added_at);

COMMIT;
