BEGIN;
-- Existing projects keep their exact enrollment contract. Only new ordinary
-- interest projects explicitly created by the API use the simple flow.
ALTER TABLE mbox.member_card_projects
 ADD COLUMN flow_mode text NOT NULL DEFAULT 'legacy' CHECK(flow_mode IN('legacy','simple')),
 ALTER COLUMN available_until DROP NOT NULL,
 ADD CONSTRAINT member_card_simple_contract CHECK(
   (flow_mode='legacy' AND available_until IS NOT NULL) OR
   (flow_mode='simple' AND kind='interest' AND NOT require_social_conditions AND NOT social_configuration_required));
ALTER TABLE mbox.member_cards ALTER COLUMN valid_until DROP NOT NULL;

CREATE OR REPLACE FUNCTION mbox.freeze_member_card_project_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.code,NEW.name,NEW.kind,NEW.terms,NEW.available_from,NEW.cooperation_confirmed,NEW.cooperation_valid_until,NEW.cooperation_reference,NEW.created_by_employee_id,NEW.version,NEW.flow_mode)
   IS DISTINCT FROM ROW(OLD.code,OLD.name,OLD.kind,OLD.terms,OLD.available_from,OLD.cooperation_confirmed,OLD.cooperation_valid_until,OLD.cooperation_reference,OLD.created_by_employee_id,OLD.version,OLD.flow_mode)
   OR (OLD.flow_mode='legacy' AND NEW.available_until IS DISTINCT FROM OLD.available_until) THEN
   RAISE EXCEPTION 'Card project terms are immutable; create a new project' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

-- A finite card can expire without a destructive state rewrite. Serialize on
-- its project and retain non-overlapping expired issuance history on reapply.
DROP INDEX mbox.member_card_current_uq;
CREATE INDEX member_card_current_idx ON mbox.member_cards(tenant_id,store_id,project_id,customer_id) WHERE status IN('active','suspended');
CREATE FUNCTION mbox.guard_current_member_card() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mode text;
BEGIN
 SELECT flow_mode INTO mode FROM mbox.member_card_projects
  WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.project_id FOR UPDATE;
 IF NEW.valid_until IS NULL AND mode<>'simple' THEN
  RAISE EXCEPTION 'Legacy member card requires its original expiry' USING ERRCODE='23514';
 END IF;
 IF NEW.status IN('active','suspended') AND EXISTS(
  SELECT 1 FROM mbox.member_cards c WHERE c.tenant_id=NEW.tenant_id AND c.store_id=NEW.store_id
   AND c.project_id=NEW.project_id AND c.id<>NEW.id AND c.status IN('active','suspended')
   AND mbox.canonical_customer_id(c.tenant_id,c.store_id,c.customer_id)=mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,NEW.customer_id)
   AND (mode='legacy' OR tstzrange(c.valid_from,c.valid_until,'[)') && tstzrange(NEW.valid_from,NEW.valid_until,'[)'))
 ) THEN RAISE EXCEPTION 'Customer already holds a current member card' USING ERRCODE='23505'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_card_current_guard BEFORE INSERT OR UPDATE OF status ON mbox.member_cards
 FOR EACH ROW EXECUTE FUNCTION mbox.guard_current_member_card();

CREATE FUNCTION mbox.customer_has_usable_member_card(p_tenant uuid,p_store uuid,p_project uuid,p_customer uuid,p_for_menu boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT p_customer IS NOT NULL AND EXISTS(
  SELECT 1 FROM mbox.member_cards c JOIN mbox.member_card_projects p
   ON p.tenant_id=c.tenant_id AND p.store_id=c.store_id AND p.id=c.project_id
  WHERE c.tenant_id=p_tenant AND c.store_id=p_store AND c.project_id=p_project
   AND c.status='active' AND c.valid_from<=clock_timestamp() AND (c.valid_until IS NULL OR c.valid_until>clock_timestamp())
   AND (NOT p_for_menu OR p.flow_mode='simple' OR p.status='open')
   AND mbox.canonical_customer_id(c.tenant_id,c.store_id,c.customer_id)=mbox.canonical_customer_id(p_tenant,p_store,p_customer)
   AND mbox.card_social_conditions_met(c.tenant_id,c.store_id,c.project_id,c.customer_id)
 )
$$;
REVOKE ALL ON FUNCTION mbox.customer_has_usable_member_card(uuid,uuid,uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.customer_has_usable_member_card(uuid,uuid,uuid,uuid,boolean) TO mbox_runtime;

CREATE OR REPLACE FUNCTION mbox.customer_has_card_menu_item(p_tenant uuid,p_store uuid,p_product uuid,p_customer uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM mbox.member_card_menu_items mi
  WHERE mi.tenant_id=p_tenant AND mi.store_id=p_store AND mi.product_id=p_product AND mi.active AND mi.exclusive
   AND mbox.customer_has_usable_member_card(mi.tenant_id,mi.store_id,mi.project_id,p_customer,true))
$$;
CREATE OR REPLACE FUNCTION mbox.customer_card_price(p_tenant uuid,p_store uuid,p_product uuid,p_customer uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT min(mi.exclusive_price_minor) FROM mbox.member_card_menu_items mi
  WHERE mi.tenant_id=p_tenant AND mi.store_id=p_store AND mi.product_id=p_product AND mi.active
   AND mbox.customer_has_usable_member_card(mi.tenant_id,mi.store_id,mi.project_id,p_customer,true)
$$;
UPDATE mbox.normalized_schema_metadata SET schema_version='276',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
