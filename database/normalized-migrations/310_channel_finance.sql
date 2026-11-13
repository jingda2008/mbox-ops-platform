BEGIN;
ALTER TABLE mbox.channel_ledger ADD COLUMN sequence bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX channel_ledger_sequence_uq ON mbox.channel_ledger(sequence);
CREATE TABLE mbox.channel_financial_positions(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,visit_id uuid NOT NULL,batch_id uuid NOT NULL,
 net_basis_minor bigint NOT NULL DEFAULT 0 CHECK(net_basis_minor>=0),commission_minor bigint NOT NULL DEFAULT 0,
 fingerprint text NOT NULL,revision bigint NOT NULL DEFAULT 1, frozen boolean NOT NULL DEFAULT true,reasons jsonb NOT NULL DEFAULT '[]',
 matures_at timestamptz,checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),evidence jsonb NOT NULL,
 PRIMARY KEY(tenant_id,store_id,visit_id),
 FOREIGN KEY(tenant_id,store_id,visit_id) REFERENCES mbox.channel_visits(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,batch_id) REFERENCES mbox.channel_batches(tenant_id,store_id,id)
);
CREATE TABLE mbox.channel_settlement_accounts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,partner_id uuid NOT NULL,
 subject text NOT NULL,account_reference text NOT NULL CHECK(length(btrim(account_reference)) BETWEEN 4 AND 300),
 requested_by uuid NOT NULL,verified_by uuid,verified_at timestamptz,revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,store_id,id),
 CHECK(verified_by IS NULL OR verified_by<>requested_by),CHECK((verified_by IS NULL)=(verified_at IS NULL)),
 FOREIGN KEY(tenant_id,store_id,partner_id) REFERENCES mbox.channel_partners(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,requested_by) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,verified_by) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.channel_statements(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,promoter_id uuid NOT NULL,
 account_id uuid NOT NULL,amount_minor bigint NOT NULL,cutoff_at timestamptz NOT NULL,created_by uuid NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','confirmed','disputed','approved','cancelled')),
 confirmed_by uuid,approved_by uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),approved_at timestamptz,
 UNIQUE(tenant_id,store_id,id),CHECK(approved_by IS NULL OR approved_by<>created_by),
 FOREIGN KEY(tenant_id,store_id,promoter_id) REFERENCES mbox.channel_promoters(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,account_id) REFERENCES mbox.channel_settlement_accounts(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,created_by) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,approved_by) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,confirmed_by) REFERENCES mbox.customers(tenant_id,store_id,id)
);
CREATE TABLE mbox.channel_statement_lines(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,statement_id uuid NOT NULL,ledger_id uuid NOT NULL,
 amount_minor bigint NOT NULL,released_at timestamptz,
 PRIMARY KEY(tenant_id,store_id,statement_id,ledger_id),
 FOREIGN KEY(tenant_id,store_id,statement_id) REFERENCES mbox.channel_statements(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,ledger_id) REFERENCES mbox.channel_ledger(tenant_id,store_id,id)
);
CREATE UNIQUE INDEX channel_ledger_occupied_uq ON mbox.channel_statement_lines(tenant_id,store_id,ledger_id) WHERE released_at IS NULL;
CREATE TABLE mbox.channel_payouts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,statement_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),status text NOT NULL DEFAULT 'unknown' CHECK(status IN('unknown','succeeded','failed')),
 attempt_reference text NOT NULL CHECK(length(btrim(attempt_reference)) BETWEEN 4 AND 200),receipt_reference text,
 requested_by uuid NOT NULL,confirmed_by uuid,confirmed_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,attempt_reference),UNIQUE(tenant_id,store_id,receipt_reference),
 CHECK(confirmed_by IS NULL OR confirmed_by<>requested_by),CHECK((status='unknown')=(confirmed_at IS NULL)),
 FOREIGN KEY(tenant_id,store_id,statement_id) REFERENCES mbox.channel_statements(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,requested_by) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,confirmed_by) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.channel_payout_returns(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,payout_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),receipt_reference text NOT NULL CHECK(length(btrim(receipt_reference)) BETWEEN 4 AND 200),
 recorded_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,receipt_reference),
 FOREIGN KEY(tenant_id,store_id,payout_id) REFERENCES mbox.channel_payouts(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,recorded_by) REFERENCES mbox.employees(tenant_id,store_id,id)
);
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['channel_financial_positions','channel_settlement_accounts','channel_statements','channel_statement_lines','channel_payouts','channel_payout_returns'] LOOP
 EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',n);EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('CREATE POLICY scoped ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',n);
 EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',n);
 IF n<>'channel_payout_returns' THEN EXECUTE format('GRANT UPDATE ON mbox.%I TO mbox_runtime',n);END IF;
 END LOOP;
END $$;
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON mbox.channel_payout_returns FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE FUNCTION mbox.guard_channel_finance_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='channel_statement_lines' THEN
  IF (to_jsonb(NEW)-'released_at') IS DISTINCT FROM (to_jsonb(OLD)-'released_at') OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN RAISE EXCEPTION 'Statement line immutable';END IF;
 ELSIF TG_TABLE_NAME='channel_statements' THEN
  IF (to_jsonb(NEW)-ARRAY['status','confirmed_by','approved_by','approved_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','confirmed_by','approved_by','approved_at'])
  OR NOT ((OLD.status='pending' AND NEW.status IN('confirmed','disputed','cancelled')) OR (OLD.status='confirmed' AND NEW.status IN('approved','disputed','cancelled')) OR (OLD.status='disputed' AND NEW.status='cancelled') OR (OLD.status='approved' AND NEW.status='cancelled')) THEN RAISE EXCEPTION 'Invalid statement transition';END IF;
 ELSIF TG_TABLE_NAME='channel_payouts' THEN
  IF OLD.status<>'unknown' OR NEW.status='unknown' OR (to_jsonb(NEW)-ARRAY['status','receipt_reference','confirmed_by','confirmed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','receipt_reference','confirmed_by','confirmed_at']) THEN RAISE EXCEPTION 'Payout facts immutable';END IF;
 ELSIF TG_TABLE_NAME='channel_settlement_accounts' THEN
  IF (to_jsonb(NEW)-ARRAY['verified_by','verified_at','revoked_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['verified_by','verified_at','revoked_at']) OR OLD.revoked_at IS NOT NULL OR (OLD.verified_at IS NOT NULL AND (NEW.verified_at,NEW.verified_by) IS DISTINCT FROM (OLD.verified_at,OLD.verified_by)) THEN RAISE EXCEPTION 'Account version immutable';END IF;
 END IF;RETURN NEW;END $$;
DO $$ DECLARE n text;BEGIN FOREACH n IN ARRAY ARRAY['channel_statement_lines','channel_statements','channel_payouts','channel_settlement_accounts'] LOOP
 EXECUTE format('CREATE TRIGGER guarded_update BEFORE UPDATE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.guard_channel_finance_update()',n);
 END LOOP;END $$;
REVOKE ALL ON FUNCTION mbox.guard_channel_finance_update() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='310',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
