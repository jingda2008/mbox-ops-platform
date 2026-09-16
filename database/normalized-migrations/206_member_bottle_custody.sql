BEGIN;
-- Customer custody is separate from saleable inventory. No stock movement is
-- inferred from a customer's collection or archive decision.
CREATE TABLE mbox.bottle_custody_policies(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,enabled boolean NOT NULL DEFAULT false,
 default_days integer NOT NULL DEFAULT 20 CHECK(default_days BETWEEN 1 AND 3660),
 reminders_enabled boolean NOT NULL DEFAULT false,reminder_days integer[] NOT NULL DEFAULT ARRAY[30,15,7,3,2,1],
 send_minute integer NOT NULL DEFAULT 990 CHECK(send_minute BETWEEN 960 AND 1020),
 code_digits integer NOT NULL DEFAULT 4 CHECK(code_digits BETWEEN 4 AND 8),
 code_ttl_seconds integer NOT NULL DEFAULT 300 CHECK(code_ttl_seconds BETWEEN 60 AND 600),
 resend_seconds integer NOT NULL DEFAULT 60 CHECK(resend_seconds BETWEEN 30 AND 600),
 maximum_attempts integer NOT NULL DEFAULT 5 CHECK(maximum_attempts BETWEEN 1 AND 10),
 allow_partial boolean NOT NULL DEFAULT false,
 number_pattern text NOT NULL DEFAULT '{date}-{time}-{member}-{serial}',
 print_title text NOT NULL DEFAULT 'M-BOX 存酒凭证',
 reminder_text text NOT NULL DEFAULT '您的存酒将于{expiry}到期，请安排来店领取或饮用。',
 version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id),FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
 CHECK(cardinality(reminder_days) BETWEEN 1 AND 12 AND 0<ALL(reminder_days) AND 3660>=ALL(reminder_days)),
 CHECK(length(number_pattern) BETWEEN 10 AND 200),CHECK(length(print_title) BETWEEN 1 AND 100),CHECK(length(reminder_text) BETWEEN 1 AND 500)
);
CREATE TABLE mbox.bottle_custody_categories(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 code text NOT NULL,name text NOT NULL,default_days integer NOT NULL CHECK(default_days BETWEEN 1 AND 3660),
 active boolean NOT NULL DEFAULT true,sort_order integer NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,code),
 FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
 CHECK(length(code) BETWEEN 1 AND 40),CHECK(length(name) BETWEEN 1 AND 60)
);
CREATE TABLE mbox.bottle_custody_orders(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),serial bigint GENERATED ALWAYS AS IDENTITY,
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,public_id text NOT NULL,
 customer_id uuid NOT NULL,member_no text NOT NULL,category_id uuid NOT NULL,
 item_name text NOT NULL CHECK(length(item_name) BETWEEN 1 AND 120),unit text NOT NULL CHECK(length(unit) BETWEEN 1 AND 20),
 original_quantity numeric(18,6) NOT NULL CHECK(original_quantity>0),remaining_quantity numeric(18,6) NOT NULL CHECK(remaining_quantity>=0),
 source_order_id uuid,source_reference text,location text NOT NULL DEFAULT '',note text NOT NULL DEFAULT '',
 expires_at timestamptz NOT NULL,stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_by_employee_id uuid NOT NULL,status text NOT NULL DEFAULT 'stored' CHECK(status IN('stored','collected','archived','voided')),
 version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,public_id),UNIQUE(serial),
 FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,category_id) REFERENCES mbox.bottle_custody_categories(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,source_order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 CHECK(remaining_quantity<=original_quantity),CHECK(status NOT IN('collected','archived') OR remaining_quantity=0),
 CHECK(length(public_id) BETWEEN 6 AND 200),CHECK(length(location)<=120 AND length(note)<=1000)
);
CREATE INDEX bottle_custody_member ON mbox.bottle_custody_orders(tenant_id,store_id,customer_id,stored_at DESC,id);
CREATE INDEX bottle_custody_expiry ON mbox.bottle_custody_orders(tenant_id,store_id,status,expires_at,id);
CREATE TABLE mbox.bottle_custody_challenges(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,order_id uuid NOT NULL,
 customer_id uuid NOT NULL,quantity numeric(18,6) NOT NULL CHECK(quantity>0),order_version integer NOT NULL,
 code_hash text NOT NULL,encrypted_code bytea NOT NULL,key_id text NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),maximum_attempts integer NOT NULL CHECK(maximum_attempts BETWEEN 1 AND 10),
 delivery_status text NOT NULL DEFAULT 'pending' CHECK(delivery_status IN('pending','sending','accepted','rejected','unknown')),
 provider_reference text,error_code text,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 verified_at timestamptz,consumed_at timestamptz,invalidated_at timestamptz,created_by_employee_id uuid NOT NULL,
 UNIQUE(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.bottle_custody_orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE INDEX bottle_custody_challenge_order ON mbox.bottle_custody_challenges(tenant_id,store_id,order_id,created_at DESC);
CREATE TABLE mbox.bottle_custody_collections(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,order_id uuid NOT NULL,challenge_id uuid NOT NULL,
 quantity numeric(18,6) NOT NULL CHECK(quantity>0),returned_quantity numeric(18,6) NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'collected' CHECK(status IN('collected','restored','archived')),
 collected_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_by_employee_id uuid NOT NULL,
 CHECK(returned_quantity>=0 AND returned_quantity<=quantity),UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,challenge_id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.bottle_custody_orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,challenge_id) REFERENCES mbox.bottle_custody_challenges(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.bottle_custody_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,order_id uuid NOT NULL,
 event_type text NOT NULL CHECK(event_type IN('stored','code_requested','code_verified','code_rejected','collected','restored','archived','printed','expiry_changed')),
 quantity numeric(18,6),challenge_id uuid,collection_id uuid,employee_id uuid NOT NULL,
 reason text NOT NULL DEFAULT '',occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.bottle_custody_orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,challenge_id) REFERENCES mbox.bottle_custody_challenges(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,collection_id) REFERENCES mbox.bottle_custody_collections(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.bottle_custody_reminders(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,order_id uuid NOT NULL,
 expiry_snapshot timestamptz NOT NULL,days_before integer NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','sending','accepted','rejected','unknown','cancelled')),
 due_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),provider_reference text,error_code text,
 UNIQUE(tenant_id,store_id,order_id,expiry_snapshot,days_before),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.bottle_custody_orders(tenant_id,store_id,id)
);
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['bottle_custody_policies','bottle_custody_categories','bottle_custody_orders','bottle_custody_challenges','bottle_custody_collections','bottle_custody_events','bottle_custody_reminders'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',n);
  EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC,mbox_runtime',n);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON mbox.%I TO mbox_runtime',n);
 END LOOP;
END $$;
REVOKE UPDATE ON mbox.bottle_custody_events FROM mbox_runtime;
CREATE TRIGGER bottle_custody_events_append_only BEFORE UPDATE OR DELETE ON mbox.bottle_custody_events FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
GRANT USAGE,SELECT ON SEQUENCE mbox.bottle_custody_orders_serial_seq TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='206',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
