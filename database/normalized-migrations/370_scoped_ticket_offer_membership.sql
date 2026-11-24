BEGIN;
SET LOCAL lock_timeout='3s';

ALTER TABLE mbox.table_ticket_offers ADD CONSTRAINT table_ticket_offer_exact_area_key
  UNIQUE(tenant_id,store_id,id,area_id);

-- One sealed row per immutable offer revision; separate rows for each desk
-- would let a partially recorded set commit, or allow later additions.
-- No application role can write these snapshots in this candidate.
CREATE TABLE mbox.scoped_ticket_offer_membership (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  area_id uuid NOT NULL,
  table_ids uuid[] NOT NULL CHECK(
    cardinality(table_ids) BETWEEN 1 AND 200
    AND array_ndims(table_ids)=1 AND array_position(table_ids,NULL) IS NULL
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,store_id,offer_id),
  FOREIGN KEY(tenant_id,store_id,offer_id,area_id)
    REFERENCES mbox.table_ticket_offers(tenant_id,store_id,id,area_id)
);
ALTER TABLE mbox.scoped_ticket_offer_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.scoped_ticket_offer_membership FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON mbox.scoped_ticket_offer_membership
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

CREATE FUNCTION mbox.check_scoped_ticket_offer_membership()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
DECLARE eligible_count integer;
BEGIN
  SELECT count(*) INTO eligible_count FROM (
    SELECT d.id FROM mbox.tables d
      JOIN mbox.areas a ON (a.tenant_id,a.store_id,a.id)=(d.tenant_id,d.store_id,d.area_id)
      JOIN mbox.ticket_table_roster r ON (r.tenant_id,r.store_id,r.table_id)=(d.tenant_id,d.store_id,d.id)
    WHERE (d.tenant_id,d.store_id,d.area_id)=(NEW.tenant_id,NEW.store_id,NEW.area_id)
      AND d.id=ANY(NEW.table_ids) AND d.status='available' AND a.status='active'
    ORDER BY d.id FOR SHARE OF d,a,r
  ) AS eligible;
  -- Any duplicate, unknown, excluded, wrong-area or inactive desk makes the
  -- count smaller; never partially freeze nor silently widen the set.
  IF eligible_count <> cardinality(NEW.table_ids) THEN
    RAISE EXCEPTION USING MESSAGE='Scoped ticket offer contains ineligible or repeated desks', ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scoped_ticket_offer_membership_valid BEFORE INSERT ON mbox.scoped_ticket_offer_membership
  FOR EACH ROW EXECUTE FUNCTION mbox.check_scoped_ticket_offer_membership();
CREATE TRIGGER scoped_ticket_offer_membership_history BEFORE UPDATE OR DELETE ON mbox.scoped_ticket_offer_membership
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
GRANT SELECT ON mbox.scoped_ticket_offer_membership TO mbox_runtime;

-- The registry now requires exact offer membership, not just a desk somewhere
-- in the store roster. No existing order or earlier whole-area offer changes.
CREATE FUNCTION mbox.check_scoped_ticket_hold_offer_membership()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mbox.table_ticket_purchases p
      JOIN mbox.scoped_ticket_offer_membership m
        ON (m.tenant_id,m.store_id,m.offer_id)=(p.tenant_id,p.store_id,p.offer_id)
      JOIN mbox.reservation_table_locks l
        ON (l.tenant_id,l.store_id,l.id)=(p.tenant_id,p.store_id,NEW.reservation_lock_id)
    WHERE (p.tenant_id,p.store_id,p.registration_id)=(NEW.tenant_id,NEW.store_id,NEW.registration_id)
      AND l.table_id=ANY(m.table_ids)
  ) THEN
    RAISE EXCEPTION USING MESSAGE='Scoped ticket physical hold is outside frozen offer membership', ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scoped_ticket_hold_offer_membership_valid BEFORE INSERT ON mbox.scoped_ticket_hold_identity
  FOR EACH ROW EXECUTE FUNCTION mbox.check_scoped_ticket_hold_offer_membership();
UPDATE mbox.normalized_schema_metadata SET schema_version='370',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
