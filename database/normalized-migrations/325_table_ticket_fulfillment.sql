BEGIN;
SET LOCAL lock_timeout='3s';
CREATE FUNCTION mbox.issue_paid_table_tickets() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE purchase record; receipt record;
BEGIN
  SELECT p.*,o.price_minor,o.activity_id INTO purchase
    FROM mbox.table_ticket_purchases p JOIN mbox.table_ticket_offers o
      ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id)
    WHERE (p.tenant_id,p.store_id,p.registration_id)=(NEW.tenant_id,NEW.store_id,NEW.id);
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO receipt FROM mbox.payments
    WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.payment_id)
      AND activity_registration_id=NEW.id AND activity_registration_cycle=NEW.registration_cycle
      AND payable_kind='activity_registration' AND status='succeeded' AND succeeded_at IS NOT NULL
      AND currency=NEW.currency AND amount_minor=purchase.price_minor::bigint*purchase.quantity;
  IF FOUND AND NEW.paid_amount_minor=receipt.amount_minor AND NEW.membership_id=purchase.membership_id
      AND NEW.activity_id=purchase.activity_id THEN
    INSERT INTO mbox.table_tickets(tenant_id,store_id,registration_id,ordinal,payment_id,paid_at)
      SELECT NEW.tenant_id,NEW.store_id,NEW.id,n,receipt.id,receipt.succeeded_at
      FROM generate_series(1,purchase.quantity) n
      ON CONFLICT(tenant_id,store_id,registration_id,ordinal) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER issue_paid_table_tickets AFTER UPDATE OF payment_status ON mbox.community_activity_registrations
  FOR EACH ROW WHEN(NEW.payment_status='paid' AND NEW.status='confirmed' AND OLD.payment_status IS DISTINCT FROM 'paid')
  EXECUTE FUNCTION mbox.issue_paid_table_tickets();
UPDATE mbox.normalized_schema_metadata SET schema_version='325',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
