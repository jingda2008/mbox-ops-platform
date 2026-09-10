BEGIN;
-- No project is opened, no card is issued and no role gains review permission.
CREATE TABLE mbox.member_card_projects(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  code text NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_]{1,39}$'),name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 60),
  kind text NOT NULL CHECK(kind IN('interest','cobrand')),
  terms text NOT NULL CHECK(length(btrim(terms)) BETWEEN 2 AND 6000),
  available_from timestamptz NOT NULL,available_until timestamptz NOT NULL,CHECK(available_until>available_from),
  cooperation_confirmed boolean NOT NULL DEFAULT false,cooperation_valid_until timestamptz,
  cooperation_reference text, CHECK(kind<>'cobrand' OR (cooperation_reference IS NOT NULL AND length(btrim(cooperation_reference)) BETWEEN 2 AND 500)),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','open','paused','closed')),
  created_by_employee_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),version integer NOT NULL DEFAULT 1 CHECK(version>0),
  UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,code),
  FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY(tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.member_card_applications(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  project_id uuid NOT NULL,customer_id uuid NOT NULL,accepted_project_version integer NOT NULL CHECK(accepted_project_version>0),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','withdrawn')),
  reviewed_by_employee_id uuid,review_reason text,requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),resolved_at timestamptz,
  CHECK((status='pending')=(resolved_at IS NULL)),
  CHECK(status NOT IN('approved','rejected') OR reviewed_by_employee_id IS NOT NULL),
  UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,project_id) REFERENCES mbox.member_card_projects(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,reviewed_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE UNIQUE INDEX member_card_pending_uq ON mbox.member_card_applications(tenant_id,store_id,project_id,customer_id) WHERE status='pending';
CREATE INDEX member_card_review_queue_idx ON mbox.member_card_applications(tenant_id,store_id,status,requested_at,id);
CREATE TABLE mbox.member_cards(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
  project_id uuid NOT NULL,customer_id uuid NOT NULL,application_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN('active','suspended','withdrawn','revoked')),
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),valid_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(valid_until>valid_from),UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,application_id),
  FOREIGN KEY(tenant_id,store_id,project_id) REFERENCES mbox.member_card_projects(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,application_id) REFERENCES mbox.member_card_applications(tenant_id,store_id,id)
);
CREATE UNIQUE INDEX member_card_current_uq ON mbox.member_cards(tenant_id,store_id,project_id,customer_id) WHERE status IN('active','suspended');
-- Business terms are not editable after insertion. A corrected program must be
-- explicit instead of rewriting what existing applicants agreed to.
CREATE FUNCTION mbox.freeze_member_card_project_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.code,NEW.name,NEW.kind,NEW.terms,NEW.available_from,NEW.available_until,NEW.cooperation_confirmed,NEW.cooperation_valid_until,NEW.cooperation_reference,NEW.created_by_employee_id,NEW.version)
    IS DISTINCT FROM ROW(OLD.code,OLD.name,OLD.kind,OLD.terms,OLD.available_from,OLD.available_until,OLD.cooperation_confirmed,OLD.cooperation_valid_until,OLD.cooperation_reference,OLD.created_by_employee_id,OLD.version) THEN
    RAISE EXCEPTION 'Card project terms are immutable; create a new project' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_card_project_terms_frozen BEFORE UPDATE ON mbox.member_card_projects FOR EACH ROW EXECUTE FUNCTION mbox.freeze_member_card_project_terms();
CREATE FUNCTION mbox.protect_member_card_application_facts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.tenant_id,NEW.store_id,NEW.project_id,NEW.customer_id,NEW.accepted_project_version,NEW.requested_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.store_id,OLD.project_id,OLD.customer_id,OLD.accepted_project_version,OLD.requested_at)
      OR (OLD.status<>'pending' AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'Member card application facts are immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM mbox.member_card_projects p WHERE p.tenant_id=NEW.tenant_id AND p.store_id=NEW.store_id AND p.id=NEW.project_id AND p.version=NEW.accepted_project_version) THEN
    RAISE EXCEPTION 'Application must accept its actual project version' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_card_application_facts BEFORE INSERT OR UPDATE ON mbox.member_card_applications FOR EACH ROW EXECUTE FUNCTION mbox.protect_member_card_application_facts();
CREATE FUNCTION mbox.freeze_member_card_issuance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.tenant_id,NEW.store_id,NEW.project_id,NEW.customer_id,NEW.application_id,NEW.valid_from,NEW.valid_until,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.store_id,OLD.project_id,OLD.customer_id,OLD.application_id,OLD.valid_from,OLD.valid_until,OLD.created_at) THEN
    RAISE EXCEPTION 'Member card issuance facts are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status='active' AND NEW.status IN('suspended','withdrawn','revoked')) OR
    (OLD.status='suspended' AND NEW.status IN('active','withdrawn','revoked'))
  ) THEN RAISE EXCEPTION 'Invalid member card state transition' USING ERRCODE='23514'; END IF;
  IF NEW.status='active' AND OLD.status='suspended' AND NEW.valid_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'Expired member card cannot resume' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_card_issuance_frozen BEFORE UPDATE ON mbox.member_cards FOR EACH ROW EXECUTE FUNCTION mbox.freeze_member_card_issuance();
CREATE FUNCTION mbox.check_member_card_approved_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM mbox.member_card_applications a WHERE a.tenant_id=NEW.tenant_id AND a.store_id=NEW.store_id
    AND a.id=NEW.application_id AND a.project_id=NEW.project_id AND a.status='approved'
    AND mbox.canonical_customer_id(a.tenant_id,a.store_id,a.customer_id)=mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,NEW.customer_id)) THEN
    RAISE EXCEPTION 'Member card requires its approved application' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER member_card_approval_required AFTER INSERT OR UPDATE ON mbox.member_cards
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.check_member_card_approved_application();
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['member_card_projects','member_card_applications','member_cards'] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',name);
    EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC,mbox_runtime',name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON mbox.%I TO mbox_runtime',name);
  END LOOP;
END $$;
INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name)
SELECT store.tenant_id,store.id,permission.code,permission.name FROM mbox.stores store CROSS JOIN(VALUES
  ('member.card.review','兴趣卡普通申请审核'),('member.card.manage','兴趣卡项目与持卡管理')) permission(code,name)
ON CONFLICT(tenant_id,store_id,code) DO NOTHING;
CREATE FUNCTION mbox.seed_member_card_permission_definitions() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES
    (NEW.tenant_id,NEW.id,'member.card.review','兴趣卡普通申请审核'),(NEW.tenant_id,NEW.id,'member.card.manage','兴趣卡项目与持卡管理')
  ON CONFLICT(tenant_id,store_id,code) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.seed_member_card_permission_definitions() FROM PUBLIC;
CREATE TRIGGER member_card_store_permissions AFTER INSERT ON mbox.stores FOR EACH ROW EXECUTE FUNCTION mbox.seed_member_card_permission_definitions();
UPDATE mbox.normalized_schema_metadata SET schema_version='166',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
