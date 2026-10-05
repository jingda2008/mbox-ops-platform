BEGIN;

-- A reception is a historical association after arrival. It is not a reservation
-- of a physical table and does not grant guest session/customer authentication.
CREATE TABLE mbox.reservation_seating_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL, store_id uuid NOT NULL,
  reservation_id uuid NOT NULL, customer_id uuid NOT NULL,
  reservation_version bigint NOT NULL CHECK(reservation_version > 0),
  reservation_guest_count integer NOT NULL CHECK(reservation_guest_count BETWEEN 1 AND 200),
  seated_guest_count integer NOT NULL CHECK(seated_guest_count BETWEEN 1 AND 4000),
  seated_by_employee_id uuid NOT NULL, business_date date NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 4 AND 1000),
  seated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,store_id,id),
  UNIQUE(tenant_id,store_id,reservation_id),
  FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY(tenant_id,store_id,reservation_id) REFERENCES mbox.reservations(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,seated_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.reservation_seating_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,batch_id uuid NOT NULL,
  table_session_id uuid NOT NULL,table_id_at_seating uuid NOT NULL,
  table_code_at_seating text NOT NULL,
  location_version_at_seating bigint NOT NULL CHECK(location_version_at_seating>=0),
  guest_count_at_seating integer NOT NULL CHECK(guest_count_at_seating BETWEEN 1 AND 200),
  UNIQUE(tenant_id,store_id,id),
  UNIQUE(tenant_id,store_id,table_session_id),
  FOREIGN KEY(tenant_id,store_id,batch_id) REFERENCES mbox.reservation_seating_batches(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,table_id_at_seating) REFERENCES mbox.tables(tenant_id,store_id,id)
);

CREATE INDEX reservation_seating_sessions_batch_idx ON mbox.reservation_seating_sessions(tenant_id,store_id,batch_id);

CREATE FUNCTION mbox.verify_reservation_seating_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch mbox.reservation_seating_batches%ROWTYPE; participant_count integer; participant_guests integer;
BEGIN
  IF TG_TABLE_NAME='reservation_seating_batches' THEN batch:=NEW;
  ELSE SELECT * INTO batch FROM mbox.reservation_seating_batches
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.batch_id; END IF;
  SELECT count(*),COALESCE(sum(guest_count_at_seating),0) INTO participant_count,participant_guests
    FROM mbox.reservation_seating_sessions
    WHERE tenant_id=batch.tenant_id AND store_id=batch.store_id AND batch_id=batch.id;
  IF participant_count NOT BETWEEN 1 AND 20 OR participant_guests<>batch.seated_guest_count THEN
    RAISE EXCEPTION 'Reservation reception must contain the complete confirmed session set' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM mbox.reservations r WHERE r.tenant_id=batch.tenant_id AND r.store_id=batch.store_id
    AND r.id=batch.reservation_id AND r.customer_id=batch.customer_id AND r.status IN('seated','completed')) THEN
    RAISE EXCEPTION 'Reservation reception customer or lifecycle does not match' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reservation_seating_complete AFTER INSERT ON mbox.reservation_seating_batches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.verify_reservation_seating_batch();
CREATE CONSTRAINT TRIGGER reservation_seating_sessions_complete AFTER INSERT ON mbox.reservation_seating_sessions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.verify_reservation_seating_batch();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['reservation_seating_batches','reservation_seating_sessions'] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',t||'_append_only',t);
    EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',t);
  END LOOP;
END $$;
-- New admission bookings cannot be completed through an older client without
-- the actual reception link. Historical unmarked bookings retain their rules.
CREATE FUNCTION mbox.guard_reservation_reception_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.reservation_snapshot->>'receptionProtocol'='1'
    AND NEW.reservation_snapshot->>'receptionProtocol' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Reservation reception protocol cannot be removed' USING ERRCODE='23514';
  END IF;
  IF NEW.reservation_snapshot->>'receptionProtocol'='1' AND NEW.status IN('seated','completed')
    AND NOT EXISTS(SELECT 1 FROM mbox.reservation_seating_batches b WHERE
      (b.tenant_id,b.store_id,b.reservation_id)=(NEW.tenant_id,NEW.store_id,NEW.id)) THEN
    RAISE EXCEPTION 'Reservation reception must be linked before completion' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reservation_reception_lifecycle BEFORE UPDATE ON mbox.reservations
  FOR EACH ROW EXECUTE FUNCTION mbox.guard_reservation_reception_lifecycle();

COMMIT;
