BEGIN;
-- Extend original activity sources and stock reservations, without another order/payment ledger.
ALTER TABLE mbox.activity_service_lines
 ADD COLUMN held boolean NOT NULL DEFAULT false,
 ADD COLUMN stopped_quantity integer NOT NULL DEFAULT 0 CHECK(stopped_quantity>=0),
 ADD COLUMN discarded_ready_quantity integer NOT NULL DEFAULT 0 CHECK(discarded_ready_quantity>=0),
 ADD COLUMN remade_taken_quantity integer NOT NULL DEFAULT 0 CHECK(remade_taken_quantity>=0),
 ADD CONSTRAINT activity_service_remaining CHECK(started_quantity+stopped_quantity<=quantity AND taken_quantity+discarded_ready_quantity<=ready_quantity AND remade_taken_quantity<=taken_quantity);
ALTER TABLE mbox.activity_service_inventory
 ADD COLUMN released_quantity numeric(18,6) NOT NULL DEFAULT 0 CHECK(released_quantity>=0),
 ADD CONSTRAINT activity_service_inventory_remaining CHECK(consumed_quantity+released_quantity<=quantity);

CREATE OR REPLACE FUNCTION mbox.release_activity_service_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE held record;
BEGIN
 IF NEW.service_version=3 AND NEW.status IN('cancelled','no_show','refunded') AND OLD.status IS DISTINCT FROM NEW.status THEN
  FOR held IN SELECT * FROM mbox.activity_service_inventory WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND registration_id=NEW.id AND status='reserved' ORDER BY inventory_item_id FOR UPDATE LOOP
   UPDATE mbox.inventory_balances SET reserved_quantity=reserved_quantity-(held.quantity-held.consumed_quantity-held.released_quantity),updated_at=clock_timestamp()
   WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND inventory_item_id=held.inventory_item_id AND reserved_quantity>=held.quantity-held.consumed_quantity-held.released_quantity;
   IF NOT FOUND THEN RAISE EXCEPTION 'activity material reservation mismatch' USING ERRCODE='23514'; END IF;
   UPDATE mbox.activity_service_inventory SET released_quantity=quantity-consumed_quantity,status='released' WHERE id=held.id;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='279',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
