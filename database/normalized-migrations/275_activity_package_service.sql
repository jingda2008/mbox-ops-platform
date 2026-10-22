BEGIN;
ALTER TABLE mbox.community_activity_packages
 ADD COLUMN has_meal boolean NOT NULL DEFAULT false,
 ADD COLUMN max_participants integer CHECK(max_participants BETWEEN 1 AND 50),
 ADD COLUMN includes_admission boolean NOT NULL DEFAULT true,
 ADD COLUMN meal_only_fee_amount_minor bigint CHECK(meal_only_fee_amount_minor>0);
ALTER TABLE mbox.community_activities
 ADD COLUMN meal_service_starts_at timestamptz,
 ADD COLUMN meal_service_ends_at timestamptz,
 ADD COLUMN addon_ends_at timestamptz,
 ADD COLUMN addon_product_ids uuid[] NOT NULL DEFAULT '{}';
CREATE TABLE mbox.activity_package_products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 package_id uuid NOT NULL,product_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100),
 FOREIGN KEY(tenant_id,store_id,package_id) REFERENCES mbox.community_activity_packages(tenant_id,store_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,store_id,product_id) REFERENCES mbox.products(tenant_id,store_id,id),
 UNIQUE(tenant_id,store_id,package_id,product_id),UNIQUE(tenant_id,store_id,id)
);
ALTER TABLE mbox.community_activity_registrations
 ADD COLUMN service_has_meal boolean NOT NULL DEFAULT false,
 ADD COLUMN service_version integer NOT NULL DEFAULT 1 CHECK(service_version IN(1,3)),
 ADD COLUMN reserved_seats integer CHECK(reserved_seats BETWEEN 0 AND 50),
 ADD COLUMN max_participants integer CHECK(max_participants BETWEEN 1 AND 50),
 ADD COLUMN includes_admission boolean NOT NULL DEFAULT true,
 ADD COLUMN parent_registration_id uuid,
 ADD COLUMN purchase_kind text CHECK(purchase_kind IN('admission_package','meal_package','single_dish')),
 ADD COLUMN service_items_snapshot jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(service_items_snapshot)='array'),
 ADD COLUMN credential_token uuid NOT NULL DEFAULT gen_random_uuid(),
 ADD CONSTRAINT activity_service_parent_fk FOREIGN KEY(tenant_id,store_id,parent_registration_id) REFERENCES mbox.community_activity_registrations(tenant_id,store_id,id),
 ADD CONSTRAINT activity_service_shape CHECK(service_version=1 OR (reserved_seats IS NOT NULL AND max_participants IS NOT NULL AND purchase_kind IS NOT NULL AND party_size<=max_participants));
-- Keep the historical singleton contract; version 3 purchases each retain their own original payment and refund.
DO $$ DECLARE c record; BEGIN FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='mbox.community_activity_registrations'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (tenant_id, store_id, activity_id, customer_id)' LOOP
 EXECUTE format('ALTER TABLE mbox.community_activity_registrations DROP CONSTRAINT %I',c.conname);
END LOOP; END $$;
CREATE UNIQUE INDEX activity_legacy_registration_customer ON mbox.community_activity_registrations(tenant_id,store_id,activity_id,customer_id) WHERE service_version=1 AND status<>'refunded';
CREATE TABLE mbox.activity_admission_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,registration_id uuid NOT NULL,
 operation_key text NOT NULL,quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 50),employee_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,store_id,registration_id) REFERENCES mbox.community_activity_registrations(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 UNIQUE(tenant_id,store_id,registration_id,operation_key),UNIQUE(tenant_id,store_id,id)
);
CREATE TABLE mbox.activity_meals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,registration_id uuid NOT NULL,
 business_date date NOT NULL,number integer NOT NULL CHECK(number>0),number_active boolean NOT NULL DEFAULT true,
 plaque_state text NOT NULL DEFAULT 'pending' CHECK(plaque_state IN('pending','issued','returned')),
 location text CHECK(length(location)<=100),redeemed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 redeemed_by_employee_id uuid NOT NULL,closed_at timestamptz,
 FOREIGN KEY(tenant_id,store_id,registration_id) REFERENCES mbox.community_activity_registrations(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,redeemed_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 UNIQUE(tenant_id,store_id,registration_id),UNIQUE(tenant_id,store_id,business_date,number),UNIQUE(tenant_id,store_id,id)
);
CREATE UNIQUE INDEX activity_meal_active_number ON mbox.activity_meals(tenant_id,store_id,number) WHERE number_active;
CREATE TABLE mbox.activity_service_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 source_ref text NOT NULL DEFAULT 'original',meal_id uuid NOT NULL,registration_id uuid NOT NULL,product_id uuid NOT NULL,product_snapshot jsonb NOT NULL,
 station_code text NOT NULL CHECK(station_code IN('bar','kitchen')),quantity integer NOT NULL CHECK(quantity>0),
 started_quantity integer NOT NULL DEFAULT 0,ready_quantity integer NOT NULL DEFAULT 0,taken_quantity integer NOT NULL DEFAULT 0,
 version integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'active' CHECK(status IN('active','cancelled')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(0<=taken_quantity AND taken_quantity<=ready_quantity AND ready_quantity<=started_quantity AND started_quantity<=quantity),
 FOREIGN KEY(tenant_id,store_id,meal_id) REFERENCES mbox.activity_meals(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,registration_id) REFERENCES mbox.community_activity_registrations(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,product_id) REFERENCES mbox.products(tenant_id,store_id,id),
 UNIQUE(tenant_id,store_id,registration_id,product_id,source_ref),UNIQUE(tenant_id,store_id,id)
);
CREATE TABLE mbox.activity_service_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 operation_scope text NOT NULL,operation_key text NOT NULL,request_body jsonb NOT NULL,result jsonb NOT NULL,
 employee_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),undone_at timestamptz,
 FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
 FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 UNIQUE(tenant_id,store_id,operation_scope,operation_key),UNIQUE(tenant_id,store_id,id)
);
-- Material reservations belong to the original purchase, never a synthetic order.
CREATE TABLE mbox.activity_service_inventory (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 source_ref text NOT NULL DEFAULT 'original',registration_id uuid NOT NULL,product_id uuid NOT NULL,inventory_item_id uuid NOT NULL,quantity numeric(18,6) NOT NULL CHECK(quantity>0),consumed_quantity numeric(18,6) NOT NULL DEFAULT 0 CHECK(consumed_quantity>=0 AND consumed_quantity<=quantity),
 status text NOT NULL CHECK(status IN('reserved','consumed','released')),movement_id uuid,
 FOREIGN KEY(tenant_id,store_id,registration_id) REFERENCES mbox.community_activity_registrations(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,inventory_item_id) REFERENCES mbox.inventory_items(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,inventory_item_id,movement_id) REFERENCES mbox.inventory_movements(tenant_id,store_id,inventory_item_id,id),
 FOREIGN KEY(tenant_id,store_id,product_id) REFERENCES mbox.products(tenant_id,store_id,id),
 UNIQUE(tenant_id,store_id,registration_id,product_id,inventory_item_id,source_ref),UNIQUE(tenant_id,store_id,id)
);
ALTER TABLE mbox.kds_tasks ALTER COLUMN order_item_id DROP NOT NULL;
ALTER TABLE mbox.kds_tasks ADD COLUMN activity_service_line_id uuid,
 ADD CONSTRAINT kds_activity_line_fk FOREIGN KEY(tenant_id,store_id,activity_service_line_id) REFERENCES mbox.activity_service_lines(tenant_id,store_id,id),
 ADD CONSTRAINT kds_single_source CHECK((order_item_id IS NOT NULL)::integer+(activity_service_line_id IS NOT NULL)::integer=1);
CREATE UNIQUE INDEX kds_activity_line_unique ON mbox.kds_tasks(tenant_id,store_id,activity_service_line_id) WHERE activity_service_line_id IS NOT NULL;
DROP TRIGGER kds_tasks_paid_fulfillment_gate ON mbox.kds_tasks;
CREATE TRIGGER kds_tasks_paid_fulfillment_gate BEFORE INSERT ON mbox.kds_tasks FOR EACH ROW WHEN(NEW.order_item_id IS NOT NULL) EXECUTE FUNCTION mbox.enforce_kds_paid_fulfillment_gate();
DROP TRIGGER kds_tasks_closure_fact_write_lock ON mbox.kds_tasks;
CREATE TRIGGER kds_tasks_closure_fact_write_lock BEFORE INSERT OR UPDATE ON mbox.kds_tasks FOR EACH ROW WHEN(NEW.order_item_id IS NOT NULL) EXECUTE FUNCTION mbox.lock_kds_table_session_for_closure_fact_write();
CREATE FUNCTION mbox.guard_activity_kds_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND (NEW.activity_service_line_id IS DISTINCT FROM OLD.activity_service_line_id OR NEW.order_item_id IS DISTINCT FROM OLD.order_item_id) THEN RAISE EXCEPTION 'KDS source is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.activity_service_line_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mbox.activity_service_lines line JOIN mbox.community_activity_registrations registration ON (registration.tenant_id,registration.store_id,registration.id)=(line.tenant_id,line.store_id,line.registration_id) WHERE (line.tenant_id,line.store_id,line.id)=(NEW.tenant_id,NEW.store_id,NEW.activity_service_line_id) AND line.station_code=NEW.station_code AND line.quantity=NEW.quantity AND (NEW.status IN('cancelled','failed') OR ((registration.payment_status='paid' OR (registration.payment_status='not_required' AND registration.fee_amount_minor=0)) AND registration.status IN('confirmed','checked_in')))) THEN RAISE EXCEPTION 'activity KDS requires paid redeemed source' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER activity_kds_source BEFORE INSERT OR UPDATE ON mbox.kds_tasks FOR EACH ROW EXECUTE FUNCTION mbox.guard_activity_kds_source();
ALTER TABLE mbox.print_source_jobs DROP CONSTRAINT print_source_jobs_ticket_kind_check;
ALTER TABLE mbox.print_source_jobs ADD CONSTRAINT print_source_jobs_ticket_kind_check CHECK(ticket_kind IN('production','settlement','payment','activity_payment','refund','activity_refund','order_summary','delivery','table_settlement','daily_settlement','delivery_batch','production_notice','activity_production'));
CREATE FUNCTION mbox.enqueue_activity_meal_print() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.message_type='activity.meal.line.created.v1' THEN INSERT INTO mbox.print_source_jobs(tenant_id,store_id,source_outbox_message_id,aggregate_id,ticket_kind) VALUES(NEW.tenant_id,NEW.store_id,NEW.id,NEW.aggregate_id,'activity_production') ON CONFLICT(tenant_id,store_id,ticket_kind,aggregate_id) DO NOTHING; END IF; RETURN NEW; END $$;
CREATE TRIGGER enqueue_activity_meal_print AFTER INSERT ON mbox.outbox_messages FOR EACH ROW EXECUTE FUNCTION mbox.enqueue_activity_meal_print();
CREATE FUNCTION mbox.release_activity_service_inventory() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE held record; BEGIN
 IF NEW.service_version=3 AND NEW.status IN('cancelled','no_show','refunded') AND OLD.status IS DISTINCT FROM NEW.status THEN
 FOR held IN SELECT * FROM mbox.activity_service_inventory WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND registration_id=NEW.id AND status='reserved' ORDER BY inventory_item_id FOR UPDATE LOOP
 UPDATE mbox.inventory_balances SET reserved_quantity=reserved_quantity-(held.quantity-held.consumed_quantity),updated_at=clock_timestamp() WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND inventory_item_id=held.inventory_item_id AND reserved_quantity>=held.quantity-held.consumed_quantity;
 IF NOT FOUND THEN RAISE EXCEPTION 'activity material reservation mismatch' USING ERRCODE='23514'; END IF;
 UPDATE mbox.activity_service_inventory SET status='released' WHERE id=held.id;
 END LOOP;
 END IF; RETURN NEW; END $$;
CREATE TRIGGER release_activity_service_inventory AFTER UPDATE OF status ON mbox.community_activity_registrations FOR EACH ROW EXECUTE FUNCTION mbox.release_activity_service_inventory();
DO $$ DECLARE name text; BEGIN FOREACH name IN ARRAY ARRAY['activity_package_products','activity_admission_batches','activity_meals','activity_service_lines','activity_service_receipts','activity_service_inventory'] LOOP
 EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',name);
 EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',name);
 EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',name);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON mbox.%I TO mbox_runtime',name);
 END LOOP; END $$;
REVOKE ALL ON FUNCTION mbox.guard_activity_kds_source(),mbox.enqueue_activity_meal_print(),mbox.release_activity_service_inventory() FROM PUBLIC;
-- New service promises use the same draft/published boundary as existing commercial terms.
CREATE FUNCTION mbox.guard_activity_service_promises() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='community_activity_packages' AND OLD.status<>'draft' AND
   ROW(NEW.max_participants,NEW.includes_admission,NEW.meal_only_fee_amount_minor,NEW.has_meal)
   IS DISTINCT FROM ROW(OLD.max_participants,OLD.includes_admission,OLD.meal_only_fee_amount_minor,OLD.has_meal)
 THEN RAISE EXCEPTION 'published activity service promises are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER activity_service_package_promises BEFORE UPDATE ON mbox.community_activity_packages FOR EACH ROW EXECUTE FUNCTION mbox.guard_activity_service_promises();
CREATE FUNCTION mbox.guard_activity_service_products() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE state text; BEGIN
 SELECT status INTO state FROM mbox.community_activity_packages WHERE tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id) AND store_id=COALESCE(NEW.store_id,OLD.store_id) AND id=COALESCE(NEW.package_id,OLD.package_id);
 IF state IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'published activity recipe selection is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER activity_service_package_products BEFORE INSERT OR UPDATE OR DELETE ON mbox.activity_package_products FOR EACH ROW EXECUTE FUNCTION mbox.guard_activity_service_products();
ALTER TABLE mbox.community_activity_packages ADD CONSTRAINT activity_fixed_service_price CHECK(max_participants IS NULL OR (fee_basis='per_registration' AND payment_mode='full_required'));
ALTER TABLE mbox.community_activity_registrations ADD CONSTRAINT activity_service_admission_shape CHECK(service_version=1 OR ((includes_admission AND purchase_kind='admission_package' AND reserved_seats=max_participants) OR (NOT includes_admission AND purchase_kind IN('meal_package','single_dish') AND reserved_seats=0 AND parent_registration_id IS NOT NULL)));
ALTER TABLE mbox.community_activities ADD CONSTRAINT activity_meal_service_window CHECK(COALESCE(meal_service_starts_at,starts_at)<COALESCE(meal_service_ends_at,ends_at) AND COALESCE(meal_service_ends_at,ends_at)<=ends_at AND (addon_ends_at IS NULL OR addon_ends_at<=COALESCE(meal_service_ends_at,ends_at)));
CREATE FUNCTION mbox.seed_activity_service_permission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description,status) VALUES(NEW.tenant_id,NEW.id,'community.activity.verify','活动门口核销','community','查询套餐、登记实际到场、餐饮核销与发还号码牌','active') ON CONFLICT(tenant_id,store_id,code) DO NOTHING; RETURN NEW;
END $$;
CREATE TRIGGER stores_activity_service_permission AFTER INSERT ON mbox.stores FOR EACH ROW EXECUTE FUNCTION mbox.seed_activity_service_permission();
INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description,status) SELECT tenant_id,id,'community.activity.verify','活动门口核销','community','查询套餐、登记实际到场、餐饮核销与发还号码牌','active' FROM mbox.stores ON CONFLICT(tenant_id,store_id,code) DO NOTHING;
REVOKE ALL ON FUNCTION mbox.guard_activity_service_promises(),mbox.guard_activity_service_products(),mbox.seed_activity_service_permission() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='275',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
