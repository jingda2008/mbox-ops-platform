BEGIN;

CREATE TABLE mbox.guest_table_rescan_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 customer_id uuid NOT NULL,source_participation_id uuid NOT NULL,target_table_session_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,source_participation_id) REFERENCES mbox.table_session_customer_participations(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,target_table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id)
);
ALTER TABLE mbox.guest_table_rescan_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.guest_table_rescan_events FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_table_rescan_scope ON mbox.guest_table_rescan_events USING(
 tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid
);
GRANT SELECT ON mbox.guest_table_rescan_events TO mbox_runtime;
CREATE TRIGGER guest_table_rescan_append_only BEFORE UPDATE OR DELETE ON mbox.guest_table_rescan_events
 FOR EACH ROW EXECUTE FUNCTION mbox.protect_table_customer_movement_append_only();

-- Extend only the departure reason; retain all existing immutability rules.
DO $$ DECLARE c record; definition text;
BEGIN
 FOR c IN SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
  WHERE conrelid='mbox.table_session_customer_participations'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%legacy_departure_unknown%'
 LOOP
  definition:=replace(c.definition,$needle$'legacy_departure_unknown'::text$needle$,
    $replacement$'guest_rescan'::text, 'legacy_departure_unknown'::text$replacement$);
  EXECUTE format('ALTER TABLE mbox.table_session_customer_participations DROP CONSTRAINT %I',c.conname);
  EXECUTE format('ALTER TABLE mbox.table_session_customer_participations ADD CONSTRAINT %I %s',c.conname,definition);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION mbox.ensure_scanned_table_customer_position(
  requested_credential_hash char(64),
  requested_table_session_id uuid,
  requested_customer_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE
  tenant_id_value uuid:=NULLIF(current_setting('app.tenant_id',true),'')::uuid;
  store_id_value uuid:=NULLIF(current_setting('app.store_id',true),'')::uuid;
  current_table_id uuid;
  active_participation_id uuid;
  requested_canonical_customer_id uuid;
BEGIN
  SELECT session.table_id INTO current_table_id
  FROM mbox.table_sessions session
  JOIN mbox.tables venue_table ON venue_table.tenant_id=session.tenant_id
    AND venue_table.store_id=session.store_id AND venue_table.id=session.table_id
  JOIN mbox.table_qr_credentials credential ON credential.tenant_id=session.tenant_id
    AND credential.store_id=session.store_id AND credential.table_id=session.table_id
    AND credential.status='active' AND credential.qr_version=venue_table.qr_version
  WHERE session.tenant_id=tenant_id_value AND session.store_id=store_id_value
    AND session.id=requested_table_session_id AND session.status='open'
    AND credential.credential_hash=requested_credential_hash
  FOR KEY SHARE OF session,venue_table,credential;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scanned table credential no longer matches the open table session'
      USING ERRCODE='40001';
  END IF;
  requested_canonical_customer_id:=mbox.canonical_customer_id(
    tenant_id_value,store_id_value,requested_customer_id
  );
  IF requested_canonical_customer_id IS NULL THEN
    RAISE EXCEPTION 'customer identity is not active in this store' USING ERRCODE='40001';
  END IF;
  PERFORM customer.id FROM mbox.customers customer
  WHERE customer.tenant_id=tenant_id_value AND customer.store_id=store_id_value
    AND mbox.canonical_customer_id(customer.tenant_id,customer.store_id,customer.id)
      =requested_canonical_customer_id
  ORDER BY customer.id FOR UPDATE;
  SELECT participation.id INTO active_participation_id
  FROM mbox.table_session_customer_participations participation
  WHERE participation.tenant_id=tenant_id_value AND participation.store_id=store_id_value
    AND participation.left_at IS NULL
    AND mbox.canonical_customer_id(
      participation.tenant_id,participation.store_id,participation.customer_id
    )=requested_canonical_customer_id
  FOR UPDATE;
  IF FOUND THEN
    IF NOT EXISTS (
      SELECT 1 FROM mbox.table_session_customer_participations current_position
      WHERE current_position.tenant_id=tenant_id_value AND current_position.store_id=store_id_value
        AND current_position.id=active_participation_id
        AND current_position.table_session_id=requested_table_session_id
        AND current_position.table_id=current_table_id
    ) THEN
      -- Only the authenticated customer's current position changes. Historical
      -- table relationships and every order/fulfillment destination stay intact.
      UPDATE mbox.table_session_customer_participations
        SET left_at=clock_timestamp(),left_reason_code='guest_rescan'
        WHERE tenant_id=tenant_id_value AND store_id=store_id_value AND id=active_participation_id;
      INSERT INTO mbox.guest_table_rescan_events(tenant_id,store_id,customer_id,source_participation_id,target_table_session_id)
        VALUES(tenant_id_value,store_id_value,requested_canonical_customer_id,active_participation_id,requested_table_session_id);
      UPDATE mbox.guest_sessions SET revoked_at=clock_timestamp(),revoke_reason='customer_scanned_another_table'
        WHERE tenant_id=tenant_id_value AND store_id=store_id_value AND session_kind='table'
          AND table_session_id<>requested_table_session_id AND revoked_at IS NULL
          AND mbox.canonical_customer_id(tenant_id,store_id,customer_id)=requested_canonical_customer_id;
    ELSE
      RETURN active_participation_id;
    END IF;
    INSERT INTO mbox.table_session_customers(
      tenant_id,store_id,table_session_id,customer_id,relationship
    ) VALUES (
      tenant_id_value,store_id_value,requested_table_session_id,requested_customer_id,'guest'
    ) ON CONFLICT (tenant_id,store_id,table_session_id,customer_id) DO NOTHING;
  END IF;
  INSERT INTO mbox.table_session_customers(
    tenant_id,store_id,table_session_id,customer_id,relationship
  ) VALUES (
    tenant_id_value,store_id_value,requested_table_session_id,requested_customer_id,'guest'
  ) ON CONFLICT (tenant_id,store_id,table_session_id,customer_id) DO NOTHING;
  -- Returning to a previously visited table must create a new location segment
  -- even though its historical relationship row already exists.
  INSERT INTO mbox.table_session_customer_participations (
    tenant_id,store_id,public_id,table_session_id,table_id,customer_id,
    join_source,participation_role,confirmation_state,identity_level,source_reference,
    joined_at,location_started_at
  ) SELECT tenant_id_value,store_id_value,'participation-'||replace(gen_random_uuid()::text,'-',''),
    requested_table_session_id,current_table_id,requested_customer_id,'system_identified','companion','confirmed',
    CASE WHEN EXISTS(SELECT 1 FROM mbox.customer_memberships m WHERE m.tenant_id=tenant_id_value
      AND m.store_id=store_id_value AND m.customer_id=requested_customer_id AND m.status='active') THEN 'member'
      WHEN EXISTS(SELECT 1 FROM mbox.customer_identities i WHERE i.tenant_id=tenant_id_value
        AND i.store_id=store_id_value AND i.customer_id=requested_customer_id AND i.identity_kind='wechat' AND i.status='active')
      THEN 'wechat' ELSE 'anonymous' END,
    'guest_table_rescan',clock_timestamp(),clock_timestamp()
  WHERE NOT EXISTS(SELECT 1 FROM mbox.table_session_customer_participations p
    WHERE p.tenant_id=tenant_id_value AND p.store_id=store_id_value AND p.left_at IS NULL
      AND mbox.canonical_customer_id(p.tenant_id,p.store_id,p.customer_id)=requested_canonical_customer_id);
  SELECT participation.id INTO active_participation_id
  FROM mbox.table_session_customer_participations participation
  WHERE participation.tenant_id=tenant_id_value AND participation.store_id=store_id_value
    AND participation.table_session_id=requested_table_session_id
    AND participation.customer_id=requested_customer_id
    AND participation.table_id=current_table_id AND participation.left_at IS NULL
  FOR KEY SHARE;
  IF active_participation_id IS NULL THEN
    RAISE EXCEPTION 'customer position could not be established for the scanned table'
      USING ERRCODE='40001';
  END IF;
  RETURN active_participation_id;
END $$;

UPDATE mbox.normalized_schema_metadata SET schema_version='191',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
