BEGIN;
ALTER TABLE mbox.table_tickets ADD COLUMN door_code text NOT NULL DEFAULT upper(substr(replace(gen_random_uuid()::text,'-',''),1,12));
CREATE UNIQUE INDEX ticket_door_code ON mbox.table_tickets(tenant_id,store_id,door_code);
CREATE TABLE mbox.ticket_reception_tasks(
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,registration_id uuid NOT NULL,owner_employee_id uuid,
  status text NOT NULL DEFAULT 'waiting' CHECK(status IN('waiting','claimed','called','unreachable','onsite')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,store_id,registration_id),
  FOREIGN KEY(tenant_id,store_id,registration_id) REFERENCES mbox.table_ticket_purchases(tenant_id,store_id,registration_id),
  FOREIGN KEY(tenant_id,store_id,owner_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.ticket_admission_batches(
  tenant_id uuid NOT NULL,store_id uuid NOT NULL,ticket_id uuid NOT NULL,request_key text NOT NULL,
  quantity integer NOT NULL CHECK(quantity>0),employee_id uuid NOT NULL,arrived_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,store_id,ticket_id,request_key),
  FOREIGN KEY(tenant_id,store_id,ticket_id) REFERENCES mbox.table_tickets(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
DO $$ DECLARE tbl text;BEGIN
 FOREACH tbl IN ARRAY ARRAY['ticket_reception_tasks','ticket_admission_batches'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY scoped ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',tbl);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',tbl);
 END LOOP;
END $$;
GRANT UPDATE(owner_employee_id,status,updated_at) ON mbox.ticket_reception_tasks TO mbox_runtime;
CREATE FUNCTION mbox.open_ticket_reception() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO mbox.ticket_reception_tasks(tenant_id,store_id,registration_id) VALUES(NEW.tenant_id,NEW.store_id,NEW.registration_id)
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER open_ticket_reception AFTER INSERT ON mbox.table_tickets FOR EACH ROW WHEN(NEW.ordinal=1) EXECUTE FUNCTION mbox.open_ticket_reception();
INSERT INTO mbox.ticket_reception_tasks(tenant_id,store_id,registration_id)
 SELECT tenant_id,store_id,registration_id FROM mbox.table_tickets WHERE ordinal=1 ON CONFLICT DO NOTHING;
UPDATE mbox.normalized_schema_metadata SET schema_version='338',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
