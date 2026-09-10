BEGIN;
CREATE TABLE mbox.delivery_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 table_session_id uuid NOT NULL,station_code text NOT NULL CHECK(station_code IN ('bar','kitchen')),
 created_by_employee_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 UNIQUE(tenant_id,store_id,id)
);
CREATE TABLE mbox.delivery_batch_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,batch_id uuid NOT NULL,
 kds_task_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity>0),
 FOREIGN KEY(tenant_id,store_id,batch_id) REFERENCES mbox.delivery_batches(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,kds_task_id) REFERENCES mbox.kds_tasks(tenant_id,store_id,id),
 UNIQUE(tenant_id,store_id,batch_id,kds_task_id)
);
CREATE INDEX delivery_batch_items_task_idx ON mbox.delivery_batch_items(tenant_id,store_id,kds_task_id);
CREATE TABLE mbox.order_stock_returns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,order_item_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity>0),disposition text NOT NULL CHECK(disposition IN ('unmade','returned_unopened')),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),created_by_employee_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,store_id,order_item_id) REFERENCES mbox.order_items(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 UNIQUE(tenant_id,store_id,id)
);
CREATE TABLE mbox.order_stock_return_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,return_id uuid NOT NULL,
 reservation_id uuid NOT NULL,movement_id uuid NOT NULL,quantity numeric(18,6) NOT NULL CHECK(quantity>0),
 FOREIGN KEY(tenant_id,store_id,return_id) REFERENCES mbox.order_stock_returns(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,reservation_id) REFERENCES mbox.inventory_order_reservations(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,movement_id) REFERENCES mbox.inventory_movements(tenant_id,store_id,id),
 UNIQUE(tenant_id,store_id,return_id,reservation_id),UNIQUE(tenant_id,store_id,movement_id)
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['delivery_batches','delivery_batch_items','order_stock_returns','order_stock_return_movements'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY scope_guard ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',relation);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',relation);
  EXECUTE format('CREATE TRIGGER immutable_records BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',relation);
 END LOOP;
END $$;
ALTER TABLE mbox.print_source_jobs DROP CONSTRAINT print_source_jobs_ticket_kind_check;
ALTER TABLE mbox.print_source_jobs ADD CHECK(ticket_kind IN ('production','settlement','payment','activity_payment','refund','activity_refund','order_summary','delivery','table_settlement','daily_settlement','delivery_batch'));
CREATE OR REPLACE FUNCTION mbox.enqueue_additional_print_sources() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text;
BEGIN
 IF NEW.aggregate_type='order' AND (
   (NEW.message_type IN ('order.submitted.v1','benefit.gift.fulfillment-dispatched.v1')
     AND jsonb_typeof(NEW.payload->'kdsTaskIds')='array' AND NEW.payload->'kdsTaskIds'<>'[]'::jsonb)
   OR (NEW.message_type='order.fulfillment_activated_after_payment.v1' AND NEW.payload->>'kdsTaskCount' ~ '^[1-9][0-9]*$')
 ) THEN kind:='order_summary';
 ELSIF NEW.aggregate_type='delivery_batch' AND NEW.message_type='delivery.batch.ready.v1' THEN kind:='delivery_batch';
 ELSIF NEW.aggregate_type='table_session' AND NEW.payload->>'status'='closed' THEN kind:='table_settlement';
 END IF;
 IF kind IS NOT NULL THEN
  INSERT INTO mbox.print_source_jobs(tenant_id,store_id,source_outbox_message_id,aggregate_id,ticket_kind)
  VALUES(NEW.tenant_id,NEW.store_id,NEW.id,NEW.aggregate_id,kind)
  ON CONFLICT(tenant_id,store_id,ticket_kind,aggregate_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='188',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
