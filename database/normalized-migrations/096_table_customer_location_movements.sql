BEGIN;

CREATE TABLE mbox.table_customer_movement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  movement_kind text NOT NULL CHECK (movement_kind IN (
    'whole_table_transfer', 'participant_split', 'participant_merge'
  )),
  source_table_session_id uuid NOT NULL,
  source_table_id uuid NOT NULL,
  source_table_code_snapshot text NOT NULL CHECK (length(btrim(source_table_code_snapshot)) BETWEEN 1 AND 32),
  target_table_session_id uuid NOT NULL,
  target_table_id uuid NOT NULL,
  target_table_code_snapshot text NOT NULL CHECK (length(btrim(target_table_code_snapshot)) BETWEEN 1 AND 32),
  moved_guest_count integer NOT NULL CHECK (moved_guest_count BETWEEN 1 AND 200),
  moved_participant_count integer NOT NULL CHECK (
    moved_participant_count BETWEEN 0 AND moved_guest_count
  ),
  revoked_guest_session_count integer NOT NULL DEFAULT 0 CHECK (revoked_guest_session_count>=0),
  target_capacity_at_movement integer NOT NULL CHECK (target_capacity_at_movement>0),
  target_guest_count_before integer NOT NULL CHECK (target_guest_count_before>=0),
  target_guest_count_after integer NOT NULL CHECK (
    target_guest_count_after=target_guest_count_before+moved_guest_count
  ),
  capacity_override_reason text,
  moved_by_employee_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 1000),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  location_version bigint,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, source_table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, target_table_session_id)
    REFERENCES mbox.table_sessions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, source_table_id)
    REFERENCES mbox.tables(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, target_table_id)
    REFERENCES mbox.tables(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, moved_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (source_table_id <> target_table_id),
  CHECK (
    (target_guest_count_after>target_capacity_at_movement
      AND length(btrim(capacity_override_reason)) BETWEEN 2 AND 1000)
    OR (target_guest_count_after<=target_capacity_at_movement
      AND capacity_override_reason IS NULL)
  ),
  CHECK ((movement_kind='whole_table_transfer')=(location_version IS NOT NULL)),
  CHECK (location_version IS NULL OR location_version>0),
  CHECK (
    (movement_kind='whole_table_transfer' AND source_table_session_id=target_table_session_id)
    OR
    (movement_kind='participant_split'
      AND source_table_session_id<>target_table_session_id
      AND moved_participant_count>0)
    OR
    (movement_kind='participant_merge'
      AND source_table_session_id<>target_table_session_id)
  ),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, idempotency_key),
  UNIQUE (tenant_id, store_id, id)
);
CREATE UNIQUE INDEX table_customer_movement_events_location_version_uq
  ON mbox.table_customer_movement_events(
    tenant_id,store_id,source_table_session_id,location_version
  ) WHERE location_version IS NOT NULL;

ALTER TABLE mbox.table_sessions
  ADD COLUMN current_location_movement_event_id uuid,
  ADD COLUMN location_version bigint NOT NULL DEFAULT 0 CHECK (location_version>=0),
  ADD CONSTRAINT table_sessions_current_location_movement_fk
    FOREIGN KEY (tenant_id,store_id,current_location_movement_event_id)
    REFERENCES mbox.table_customer_movement_events(tenant_id,store_id,id);

ALTER TABLE mbox.table_session_customer_participations
  ADD COLUMN table_id uuid,
  ADD COLUMN location_started_at timestamptz,
  ADD COLUMN joined_movement_event_id uuid,
  ADD COLUMN left_movement_event_id uuid,
  ADD COLUMN joined_legacy_transfer_event_id uuid,
  ADD COLUMN left_legacy_transfer_event_id uuid,
  ADD COLUMN left_by_employee_id uuid,
  ADD COLUMN left_reason_code text CHECK (left_reason_code IN (
    'session_closed', 'relationship_corrected', 'whole_table_transfer',
    'participant_split', 'participant_merge', 'identity_merged','legacy_transfer',
    'legacy_departure_unknown'
  ));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM mbox.table_session_transfer_events transfer
    GROUP BY transfer.tenant_id,transfer.store_id,transfer.table_session_id,transfer.occurred_at
    HAVING count(*)>1
  ) THEN
    RAISE EXCEPTION 'migration 096 requires correction: one table session has ambiguous same-time legacy transfers';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM mbox.table_session_customer_participations participation
    JOIN mbox.table_session_transfer_events transfer
      ON transfer.tenant_id=participation.tenant_id
     AND transfer.store_id=participation.store_id
     AND transfer.table_session_id=participation.table_session_id
     AND (transfer.occurred_at=participation.joined_at
       OR transfer.occurred_at=participation.left_at)
  ) THEN
    RAISE EXCEPTION 'migration 096 requires correction: a participation boundary has the same timestamp as a legacy transfer';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM mbox.table_session_customer_participations participation
    JOIN mbox.table_sessions session
      ON session.tenant_id=participation.tenant_id AND session.store_id=participation.store_id
     AND session.id=participation.table_session_id
    WHERE participation.left_at IS NULL AND session.status IN ('closed','cancelled')
      AND (session.closed_at IS NULL OR session.closed_at<participation.joined_at)
  ) THEN
    RAISE EXCEPTION 'migration 096 requires correction: a closed table session lacks a reliable close time for an active legacy participation';
  END IF;
END $$;

UPDATE mbox.table_session_customer_participations participation
SET left_at=session.closed_at,left_reason_code='session_closed',
  left_by_employee_id=session.closed_by_employee_id
FROM mbox.table_sessions session
WHERE session.tenant_id=participation.tenant_id
  AND session.store_id=participation.store_id
  AND session.id=participation.table_session_id
  AND participation.left_at IS NULL AND session.status IN ('closed','cancelled');

DROP INDEX mbox.table_session_customer_participations_active_uq;

INSERT INTO mbox.table_session_customer_participations(
  tenant_id,store_id,public_id,table_session_id,customer_id,join_source,
  participation_role,confirmation_state,identity_level,seat_label,source_reference,
  joined_at,left_at,recorded_by_employee_id,created_at,table_id,location_started_at,
  joined_legacy_transfer_event_id,left_legacy_transfer_event_id,left_by_employee_id,left_reason_code
)
SELECT participation.tenant_id,participation.store_id,
  'legacy-location-'||replace(participation.id::text,'-','')||'-'||replace(transfer.id::text,'-',''),
  participation.table_session_id,participation.customer_id,'migration',
  participation.participation_role,participation.confirmation_state,participation.identity_level,
  participation.seat_label,participation.source_reference,transfer.occurred_at,
  COALESCE(next_transfer.occurred_at,participation.left_at),
  participation.recorded_by_employee_id,participation.created_at,transfer.target_table_id,
  transfer.occurred_at,transfer.id,next_transfer.id,
  CASE WHEN next_transfer.id IS NOT NULL THEN next_transfer.transferred_by_employee_id
    WHEN participation.left_at IS NOT NULL THEN participation.left_by_employee_id
    ELSE NULL END,
  CASE WHEN next_transfer.id IS NOT NULL THEN 'legacy_transfer'
    WHEN participation.left_at IS NOT NULL THEN COALESCE(participation.left_reason_code,'legacy_departure_unknown')
    ELSE NULL END
FROM mbox.table_session_customer_participations participation
JOIN mbox.table_session_transfer_events transfer
  ON transfer.tenant_id=participation.tenant_id AND transfer.store_id=participation.store_id
 AND transfer.table_session_id=participation.table_session_id
 AND transfer.occurred_at>participation.joined_at
 AND (participation.left_at IS NULL OR transfer.occurred_at<participation.left_at)
LEFT JOIN LATERAL (
  SELECT following.id,following.occurred_at,following.transferred_by_employee_id
  FROM mbox.table_session_transfer_events following
  WHERE following.tenant_id=transfer.tenant_id AND following.store_id=transfer.store_id
    AND following.table_session_id=transfer.table_session_id
    AND following.occurred_at>transfer.occurred_at
    AND (participation.left_at IS NULL OR following.occurred_at<participation.left_at)
  ORDER BY following.occurred_at LIMIT 1
) next_transfer ON true;

UPDATE mbox.table_session_customer_participations participation
SET table_id=COALESCE((
      SELECT transfer.target_table_id
      FROM mbox.table_session_transfer_events transfer
      WHERE transfer.tenant_id=participation.tenant_id
        AND transfer.store_id=participation.store_id
        AND transfer.table_session_id=participation.table_session_id
        AND transfer.occurred_at<participation.joined_at
      ORDER BY transfer.occurred_at DESC LIMIT 1
    ),(
      SELECT transfer.source_table_id
      FROM mbox.table_session_transfer_events transfer
      WHERE transfer.tenant_id=participation.tenant_id
        AND transfer.store_id=participation.store_id
        AND transfer.table_session_id=participation.table_session_id
        AND transfer.occurred_at>participation.joined_at
        AND (participation.left_at IS NULL OR transfer.occurred_at<participation.left_at)
      ORDER BY transfer.occurred_at LIMIT 1
    ),(
      SELECT transfer.target_table_id
      FROM mbox.table_session_transfer_events transfer
      WHERE transfer.tenant_id=participation.tenant_id
        AND transfer.store_id=participation.store_id
        AND transfer.table_session_id=participation.table_session_id
        AND transfer.occurred_at<participation.joined_at
      ORDER BY transfer.occurred_at DESC,transfer.id DESC LIMIT 1
    ),(
      SELECT transfer.source_table_id
      FROM mbox.table_session_transfer_events transfer
      WHERE transfer.tenant_id=participation.tenant_id
        AND transfer.store_id=participation.store_id
        AND transfer.table_session_id=participation.table_session_id
        AND participation.left_at IS NOT NULL AND transfer.occurred_at>participation.left_at
      ORDER BY transfer.occurred_at,transfer.id LIMIT 1
    ),session.table_id),
    location_started_at=participation.joined_at,
    left_at=COALESCE((
      SELECT transfer.occurred_at
      FROM mbox.table_session_transfer_events transfer
      WHERE transfer.tenant_id=participation.tenant_id
        AND transfer.store_id=participation.store_id
        AND transfer.table_session_id=participation.table_session_id
        AND transfer.occurred_at>participation.joined_at
        AND (participation.left_at IS NULL OR transfer.occurred_at<participation.left_at)
      ORDER BY transfer.occurred_at LIMIT 1
    ),participation.left_at),
    left_legacy_transfer_event_id=(
      SELECT transfer.id FROM mbox.table_session_transfer_events transfer
      WHERE transfer.tenant_id=participation.tenant_id AND transfer.store_id=participation.store_id
        AND transfer.table_session_id=participation.table_session_id
        AND transfer.occurred_at>participation.joined_at
        AND (participation.left_at IS NULL OR transfer.occurred_at<participation.left_at)
      ORDER BY transfer.occurred_at LIMIT 1
    ),
    left_by_employee_id=COALESCE((
      SELECT transfer.transferred_by_employee_id
      FROM mbox.table_session_transfer_events transfer
      WHERE transfer.tenant_id=participation.tenant_id
        AND transfer.store_id=participation.store_id
        AND transfer.table_session_id=participation.table_session_id
        AND transfer.occurred_at>participation.joined_at
        AND (participation.left_at IS NULL OR transfer.occurred_at<participation.left_at)
      ORDER BY transfer.occurred_at LIMIT 1
    ),participation.left_by_employee_id),
    left_reason_code=CASE WHEN EXISTS (
      SELECT 1 FROM mbox.table_session_transfer_events transfer
      WHERE transfer.tenant_id=participation.tenant_id AND transfer.store_id=participation.store_id
        AND transfer.table_session_id=participation.table_session_id
        AND transfer.occurred_at>participation.joined_at
        AND (participation.left_at IS NULL OR transfer.occurred_at<participation.left_at)
    ) THEN 'legacy_transfer' WHEN participation.left_at IS NOT NULL
      THEN COALESCE(participation.left_reason_code,'legacy_departure_unknown') ELSE NULL END
FROM mbox.table_sessions session
WHERE session.tenant_id=participation.tenant_id
  AND session.store_id=participation.store_id
  AND session.id=participation.table_session_id
  AND participation.joined_legacy_transfer_event_id IS NULL;

WITH revoked AS (
  UPDATE mbox.guest_sessions guest_session
  SET revoked_at=clock_timestamp(),revoke_reason='table_location_changed'
  FROM mbox.table_sessions session
  WHERE guest_session.tenant_id=session.tenant_id
    AND guest_session.store_id=session.store_id
    AND guest_session.table_session_id=session.id
    AND guest_session.session_kind='table' AND guest_session.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM mbox.guest_session_events issued
      WHERE issued.tenant_id=guest_session.tenant_id AND issued.store_id=guest_session.store_id
        AND issued.guest_session_id=guest_session.id
        AND issued.event_type='guest_session.issued' AND issued.outcome='succeeded'
        AND issued.table_id=session.table_id
        AND NOT EXISTS (
          SELECT 1 FROM mbox.table_session_transfer_events transfer
          WHERE transfer.tenant_id=session.tenant_id AND transfer.store_id=session.store_id
            AND transfer.table_session_id=session.id AND transfer.occurred_at>=issued.occurred_at
        )
    )
  RETURNING guest_session.tenant_id,guest_session.store_id,guest_session.id,
    guest_session.table_session_id
)
INSERT INTO mbox.guest_session_events(
  tenant_id,store_id,guest_session_id,table_id,table_session_id,
  event_type,outcome,reason_code,metadata
)
SELECT revoked.tenant_id,revoked.store_id,revoked.id,session.table_id,revoked.table_session_id,
  'guest_session.revoked','revoked','TABLE_LOCATION_CHANGED','{}'
FROM revoked
JOIN mbox.table_sessions session ON session.tenant_id=revoked.tenant_id
  AND session.store_id=revoked.store_id AND session.id=revoked.table_session_id;

ALTER TABLE mbox.table_session_customer_participations
  ALTER COLUMN table_id SET NOT NULL,
  ALTER COLUMN location_started_at SET NOT NULL,
  ADD CONSTRAINT table_session_customer_participations_location_time_ck CHECK (
    location_started_at>=joined_at AND (left_at IS NULL OR location_started_at<=left_at)
  ),
  ADD CONSTRAINT table_session_customer_participations_table_fk
    FOREIGN KEY (tenant_id, store_id, table_id)
    REFERENCES mbox.tables(tenant_id, store_id, id),
  ADD CONSTRAINT table_session_customer_participations_join_movement_fk
    FOREIGN KEY (tenant_id, store_id, joined_movement_event_id)
    REFERENCES mbox.table_customer_movement_events(tenant_id, store_id, id),
  ADD CONSTRAINT table_session_customer_participations_left_movement_fk
    FOREIGN KEY (tenant_id, store_id, left_movement_event_id)
    REFERENCES mbox.table_customer_movement_events(tenant_id, store_id, id),
  ADD CONSTRAINT table_session_customer_participations_join_legacy_transfer_fk
    FOREIGN KEY (tenant_id,store_id,joined_legacy_transfer_event_id)
    REFERENCES mbox.table_session_transfer_events(tenant_id,store_id,id),
  ADD CONSTRAINT table_session_customer_participations_left_legacy_transfer_fk
    FOREIGN KEY (tenant_id,store_id,left_legacy_transfer_event_id)
    REFERENCES mbox.table_session_transfer_events(tenant_id,store_id,id),
  ADD CONSTRAINT table_session_customer_participations_left_employee_fk
    FOREIGN KEY (tenant_id, store_id, left_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  ADD CONSTRAINT table_session_customer_participations_exit_consistency_ck CHECK (
    (left_at IS NULL AND left_movement_event_id IS NULL AND left_legacy_transfer_event_id IS NULL
      AND left_by_employee_id IS NULL AND left_reason_code IS NULL)
    OR (left_at IS NOT NULL
      AND left_reason_code IN (
        'session_closed','relationship_corrected','identity_merged','legacy_departure_unknown'
      )
      AND left_movement_event_id IS NULL AND left_legacy_transfer_event_id IS NULL)
    OR (left_at IS NOT NULL AND left_reason_code='legacy_transfer'
      AND left_legacy_transfer_event_id IS NOT NULL AND left_movement_event_id IS NULL
      AND left_by_employee_id IS NOT NULL)
    OR (left_at IS NOT NULL
      AND left_reason_code IN ('whole_table_transfer','participant_split','participant_merge')
      AND left_movement_event_id IS NOT NULL
      AND left_by_employee_id IS NOT NULL)
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mbox.table_session_customer_participations
    WHERE left_at IS NULL AND participation_role='organizer'
    GROUP BY tenant_id,store_id,table_session_id HAVING count(*)>1
  ) THEN
    RAISE EXCEPTION 'migration 096 requires correction: one table session has multiple active organizers';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mbox.table_session_customer_participations
    WHERE left_at IS NULL
    GROUP BY tenant_id,store_id,customer_id HAVING count(*)>1
  ) THEN
    RAISE EXCEPTION 'migration 096 requires correction: one customer has multiple active table locations';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mbox.table_session_customer_participations participation
    WHERE participation.left_at IS NULL
    GROUP BY participation.tenant_id,participation.store_id,
      mbox.canonical_customer_id(
        participation.tenant_id,participation.store_id,participation.customer_id
      )
    HAVING count(*)>1
  ) THEN
    RAISE EXCEPTION 'migration 096 requires correction: one canonical customer family has multiple active position rows';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM mbox.table_sessions session
    JOIN mbox.table_session_customer_participations participation
      ON participation.tenant_id=session.tenant_id AND participation.store_id=session.store_id
     AND participation.table_session_id=session.id AND participation.left_at IS NULL
    WHERE session.status IN ('open','closing')
    GROUP BY session.tenant_id,session.store_id,session.id,session.guest_count
    HAVING count(*)>session.guest_count
  ) THEN
    RAISE EXCEPTION 'migration 096 requires correction: active participant rows exceed the declared table-session guest count';
  END IF;
END $$;

CREATE INDEX table_session_customer_participations_location_timeline_idx
  ON mbox.table_session_customer_participations (
    tenant_id, store_id, table_id, table_session_id, location_started_at, id
  );
CREATE UNIQUE INDEX table_session_customer_participations_active_organizer_uq
  ON mbox.table_session_customer_participations (tenant_id, store_id, table_session_id)
  WHERE left_at IS NULL AND participation_role='organizer';
CREATE UNIQUE INDEX table_session_customer_participations_one_active_location_uq
  ON mbox.table_session_customer_participations (tenant_id, store_id, customer_id)
  WHERE left_at IS NULL;

CREATE TABLE mbox.table_customer_movement_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  movement_event_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  source_participation_id uuid NOT NULL,
  target_participation_id uuid NOT NULL,
  source_role text NOT NULL CHECK (source_role IN (
    'reservation_owner','organizer','payer','companion','unknown'
  )),
  target_role text NOT NULL CHECK (target_role IN (
    'reservation_owner','organizer','payer','companion','unknown'
  )),
  source_confirmation_state text NOT NULL CHECK (
    source_confirmation_state IN ('unconfirmed','confirmed','corrected')
  ),
  target_confirmation_state text NOT NULL CHECK (
    target_confirmation_state IN ('unconfirmed','confirmed','corrected')
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, movement_event_id)
    REFERENCES mbox.table_customer_movement_events(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, source_participation_id)
    REFERENCES mbox.table_session_customer_participations(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, target_participation_id)
    REFERENCES mbox.table_session_customer_participations(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, movement_event_id, customer_id),
  UNIQUE (tenant_id, store_id, source_participation_id, movement_event_id),
  UNIQUE (tenant_id, store_id, target_participation_id, movement_event_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE OR REPLACE FUNCTION mbox.protect_table_customer_movement_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table customer movement evidence is append-only' USING ERRCODE='55000';
END $$;

CREATE TRIGGER table_customer_movement_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.table_customer_movement_events
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_table_customer_movement_append_only();
CREATE TRIGGER table_customer_movement_members_append_only
  BEFORE UPDATE OR DELETE ON mbox.table_customer_movement_members
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_table_customer_movement_append_only();

CREATE OR REPLACE FUNCTION mbox.protect_table_customer_participation_segment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.left_at IS NULL AND NEW.left_at IS NOT NULL
    AND ROW(
      NEW.tenant_id,NEW.store_id,NEW.public_id,NEW.table_session_id,NEW.table_id,
      NEW.customer_id,NEW.join_source,NEW.participation_role,NEW.confirmation_state,
      NEW.identity_level,NEW.seat_label,NEW.source_reference,NEW.joined_at,
      NEW.location_started_at,NEW.recorded_by_employee_id,NEW.joined_movement_event_id,NEW.created_at
      ,NEW.joined_legacy_transfer_event_id
    ) IS NOT DISTINCT FROM ROW(
      OLD.tenant_id,OLD.store_id,OLD.public_id,OLD.table_session_id,OLD.table_id,
      OLD.customer_id,OLD.join_source,OLD.participation_role,OLD.confirmation_state,
      OLD.identity_level,OLD.seat_label,OLD.source_reference,OLD.joined_at,
      OLD.location_started_at,OLD.recorded_by_employee_id,OLD.joined_movement_event_id,OLD.created_at
      ,OLD.joined_legacy_transfer_event_id
    )
  THEN
    IF NEW.left_reason_code IN ('whole_table_transfer','participant_split','participant_merge')
      AND NOT EXISTS (
        SELECT 1 FROM mbox.table_customer_movement_events event
        WHERE event.tenant_id=NEW.tenant_id AND event.store_id=NEW.store_id
          AND event.id=NEW.left_movement_event_id
          AND event.movement_kind=NEW.left_reason_code
          AND event.source_table_session_id=NEW.table_session_id
          AND event.source_table_id=NEW.table_id
          AND event.moved_by_employee_id=NEW.left_by_employee_id
      )
    THEN
      RAISE EXCEPTION 'participation exit does not match its movement evidence'
        USING ERRCODE='23514';
    END IF;
    IF NEW.left_reason_code='legacy_transfer' AND NOT EXISTS (
      SELECT 1 FROM mbox.table_session_transfer_events transfer
      WHERE transfer.tenant_id=NEW.tenant_id AND transfer.store_id=NEW.store_id
        AND transfer.id=NEW.left_legacy_transfer_event_id
        AND transfer.table_session_id=NEW.table_session_id
        AND transfer.source_table_id=NEW.table_id AND transfer.occurred_at=NEW.left_at
        AND transfer.transferred_by_employee_id=NEW.left_by_employee_id
    ) THEN
      RAISE EXCEPTION 'participation exit does not match its legacy transfer evidence'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'customer participation segments cannot be overwritten' USING ERRCODE='55000';
END $$;

CREATE TRIGGER table_session_customer_participations_segment_guard
  BEFORE UPDATE OR DELETE ON mbox.table_session_customer_participations
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_table_customer_participation_segment();

CREATE OR REPLACE FUNCTION mbox.capture_table_session_customer_participation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE resolved_identity_level text; resolved_table_id uuid;
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND NEW.relationship IS DISTINCT FROM OLD.relationship) THEN
    UPDATE mbox.table_session_customer_participations
    SET left_at=clock_timestamp(), left_reason_code='relationship_corrected'
    WHERE tenant_id=OLD.tenant_id AND store_id=OLD.store_id
      AND table_session_id=OLD.table_session_id AND customer_id=OLD.customer_id
      AND left_at IS NULL;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  ELSIF TG_OP='UPDATE' THEN
    RETURN NEW;
  END IF;

  SELECT table_id INTO resolved_table_id FROM mbox.table_sessions
  WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.table_session_id;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM mbox.customer_memberships membership
      WHERE membership.tenant_id=NEW.tenant_id AND membership.store_id=NEW.store_id
        AND membership.customer_id=NEW.customer_id AND membership.status='active'
    ) THEN 'member'
    WHEN EXISTS (
      SELECT 1 FROM mbox.customer_identities identity
      WHERE identity.tenant_id=NEW.tenant_id AND identity.store_id=NEW.store_id
        AND identity.customer_id=NEW.customer_id
        AND identity.identity_kind='wechat' AND identity.status='active'
    ) THEN 'wechat'
    ELSE 'anonymous'
  END INTO resolved_identity_level;

  IF NOT EXISTS (
    SELECT 1 FROM mbox.table_session_customer_participations active_position
    WHERE active_position.tenant_id=NEW.tenant_id AND active_position.store_id=NEW.store_id
      AND active_position.table_session_id=NEW.table_session_id
      AND active_position.table_id=resolved_table_id AND active_position.left_at IS NULL
      AND mbox.canonical_customer_id(
        active_position.tenant_id,active_position.store_id,active_position.customer_id
      )=mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,NEW.customer_id)
  ) THEN
    INSERT INTO mbox.table_session_customer_participations (
      tenant_id, store_id, public_id, table_session_id, table_id, customer_id,
      join_source, participation_role, confirmation_state, identity_level,
      source_reference, joined_at, location_started_at, recorded_by_employee_id
    ) VALUES (
      NEW.tenant_id, NEW.store_id,
      'participation-' || replace(gen_random_uuid()::text, '-', ''),
      NEW.table_session_id, resolved_table_id, NEW.customer_id,
      CASE WHEN NEW.linked_by_employee_id IS NULL THEN 'system_identified' ELSE 'employee_assisted' END,
      CASE NEW.relationship WHEN 'primary' THEN 'organizer' ELSE 'companion' END,
      'confirmed', resolved_identity_level, NEW.id::text, NEW.linked_at,
      NEW.linked_at,NEW.linked_by_employee_id
    )
    ON CONFLICT (tenant_id, store_id, customer_id)
      WHERE left_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mbox.close_table_session_customer_participations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
BEGIN
  IF NEW.status IN ('closed', 'cancelled') AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.closed_at IS NULL OR NEW.closed_at<NEW.opened_at THEN
      RAISE EXCEPTION 'terminal table sessions require an authoritative close time'
        USING ERRCODE='23514';
    END IF;
    UPDATE mbox.table_session_customer_participations
    SET left_at=NEW.closed_at, left_reason_code='session_closed',
      left_by_employee_id=NEW.closed_by_employee_id
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
      AND table_session_id=NEW.id AND left_at IS NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mbox.apply_table_customer_movement_member(
  requested_event_id uuid,
  requested_source_participation_id uuid,
  requested_target_role text,
  requested_target_confirmation_state text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE
  movement mbox.table_customer_movement_events%ROWTYPE;
  source_segment mbox.table_session_customer_participations%ROWTYPE;
  target_participation_id uuid;
  expected_join_source text;
BEGIN
  IF requested_target_role NOT IN ('reservation_owner','organizer','payer','companion','unknown')
    OR requested_target_confirmation_state NOT IN ('unconfirmed','confirmed','corrected')
  THEN
    RAISE EXCEPTION 'invalid target participation facts' USING ERRCODE='22023';
  END IF;
  SELECT * INTO movement FROM mbox.table_customer_movement_events event
  WHERE event.tenant_id=mbox.current_tenant_id() AND event.store_id=mbox.current_store_id()
    AND event.id=requested_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'movement event was not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO source_segment FROM mbox.table_session_customer_participations participation
  WHERE participation.tenant_id=movement.tenant_id AND participation.store_id=movement.store_id
    AND participation.id=requested_source_participation_id
  FOR UPDATE;
  IF NOT FOUND OR source_segment.left_at IS NOT NULL
    OR source_segment.table_session_id<>movement.source_table_session_id
    OR source_segment.table_id<>movement.source_table_id
  THEN
    RAISE EXCEPTION 'source participation is no longer movable' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM mbox.table_sessions session
    WHERE session.tenant_id=movement.tenant_id AND session.store_id=movement.store_id
      AND session.id=movement.target_table_session_id AND session.table_id=movement.target_table_id
      AND session.status='open'
  ) THEN
    RAISE EXCEPTION 'target table session is no longer open at the target table' USING ERRCODE='40001';
  END IF;
  expected_join_source := CASE movement.movement_kind
    WHEN 'whole_table_transfer' THEN 'system_identified'
    ELSE 'employee_assisted'
  END;
  UPDATE mbox.table_session_customer_participations
  SET left_at=movement.occurred_at,left_movement_event_id=movement.id,
    left_by_employee_id=movement.moved_by_employee_id,left_reason_code=movement.movement_kind
  WHERE tenant_id=movement.tenant_id AND store_id=movement.store_id
    AND id=source_segment.id AND left_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'source participation changed concurrently' USING ERRCODE='40001'; END IF;
  INSERT INTO mbox.table_session_customer_participations(
    tenant_id,store_id,public_id,table_session_id,table_id,customer_id,
    join_source,participation_role,confirmation_state,identity_level,seat_label,
    source_reference,joined_at,location_started_at,recorded_by_employee_id,joined_movement_event_id
  ) VALUES (
    movement.tenant_id,movement.store_id,
    'participation-'||replace(gen_random_uuid()::text,'-',''),movement.target_table_session_id,
    movement.target_table_id,source_segment.customer_id,expected_join_source,
    requested_target_role,requested_target_confirmation_state,source_segment.identity_level,
    source_segment.seat_label,movement.public_id,movement.occurred_at,
    movement.occurred_at,movement.moved_by_employee_id,movement.id
  ) RETURNING id INTO target_participation_id;
  INSERT INTO mbox.table_session_customers(
    tenant_id,store_id,table_session_id,customer_id,relationship,linked_by_employee_id,linked_at
  ) VALUES (
    movement.tenant_id,movement.store_id,movement.target_table_session_id,source_segment.customer_id,
    CASE requested_target_role WHEN 'organizer' THEN 'primary' ELSE 'guest' END,
    movement.moved_by_employee_id,movement.occurred_at
  ) ON CONFLICT (tenant_id,store_id,table_session_id,customer_id) DO NOTHING;
  INSERT INTO mbox.table_customer_movement_members(
    tenant_id,store_id,movement_event_id,customer_id,source_participation_id,
    target_participation_id,source_role,target_role,source_confirmation_state,
    target_confirmation_state
  ) VALUES (
    movement.tenant_id,movement.store_id,movement.id,source_segment.customer_id,
    source_segment.id,target_participation_id,source_segment.participation_role,
    requested_target_role,source_segment.confirmation_state,requested_target_confirmation_state
  );
  RETURN target_participation_id;
END $$;

CREATE OR REPLACE FUNCTION mbox.lock_active_table_customer_position(
  requested_table_session_id uuid,
  requested_customer_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE active_participation_id uuid;
BEGIN
  SELECT participation.id INTO active_participation_id
  FROM mbox.table_sessions session
  JOIN mbox.table_session_customer_participations participation
    ON participation.tenant_id=session.tenant_id AND participation.store_id=session.store_id
   AND participation.table_session_id=session.id
   AND participation.table_id=session.table_id AND participation.left_at IS NULL
  WHERE session.tenant_id=mbox.current_tenant_id() AND session.store_id=mbox.current_store_id()
    AND session.id=requested_table_session_id AND session.status='open'
    AND mbox.canonical_customer_id(
      participation.tenant_id,participation.store_id,participation.customer_id
    )=mbox.canonical_customer_id(
      session.tenant_id,session.store_id,requested_customer_id
    )
  FOR KEY SHARE OF session
  FOR UPDATE OF participation;
  RETURN active_participation_id;
END $$;

CREATE OR REPLACE FUNCTION mbox.lock_active_table_guest_session_position(
  requested_table_session_id uuid,
  requested_customer_id uuid,
  requested_guest_session_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE
  tenant_id_value uuid:=NULLIF(current_setting('app.tenant_id',true),'')::uuid;
  store_id_value uuid:=NULLIF(current_setting('app.store_id',true),'')::uuid;
  active_participation_id uuid;
  current_table_id uuid;
  location_started_at_value timestamptz;
BEGIN
  SELECT session.table_id INTO current_table_id
  FROM mbox.table_sessions session
  WHERE session.tenant_id=tenant_id_value AND session.store_id=store_id_value
    AND session.id=requested_table_session_id AND session.status='open'
  FOR KEY SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT participation.id,participation.location_started_at
  INTO active_participation_id,location_started_at_value
  FROM mbox.table_session_customer_participations participation
  WHERE participation.tenant_id=tenant_id_value AND participation.store_id=store_id_value
    AND participation.table_session_id=requested_table_session_id
    AND participation.table_id=current_table_id AND participation.left_at IS NULL
    AND mbox.canonical_customer_id(
      participation.tenant_id,participation.store_id,participation.customer_id
    )=mbox.canonical_customer_id(tenant_id_value,store_id_value,requested_customer_id)
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  PERFORM guest_session.id
  FROM mbox.guest_sessions guest_session
  WHERE guest_session.tenant_id=tenant_id_value AND guest_session.store_id=store_id_value
    AND guest_session.id=requested_guest_session_id
    AND guest_session.session_kind='table'
    AND guest_session.table_session_id=requested_table_session_id
    AND guest_session.revoked_at IS NULL AND guest_session.expires_at>clock_timestamp()
    AND mbox.canonical_customer_id(
      guest_session.tenant_id,guest_session.store_id,guest_session.customer_id
    )=mbox.canonical_customer_id(tenant_id_value,store_id_value,requested_customer_id)
    AND EXISTS (
      SELECT 1 FROM mbox.guest_session_events issued
      WHERE issued.tenant_id=guest_session.tenant_id AND issued.store_id=guest_session.store_id
        AND issued.guest_session_id=guest_session.id
        AND issued.event_type='guest_session.issued' AND issued.outcome='succeeded'
        AND issued.table_session_id=requested_table_session_id
        AND issued.table_id=current_table_id
        AND issued.occurred_at>=location_started_at_value
    )
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN active_participation_id;
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
      RAISE EXCEPTION 'customer already has another active table position; an employee movement is required'
        USING ERRCODE='55000';
    END IF;
    INSERT INTO mbox.table_session_customers(
      tenant_id,store_id,table_session_id,customer_id,relationship
    ) VALUES (
      tenant_id_value,store_id_value,requested_table_session_id,requested_customer_id,'guest'
    ) ON CONFLICT (tenant_id,store_id,table_session_id,customer_id) DO NOTHING;
    RETURN active_participation_id;
  END IF;
  INSERT INTO mbox.table_session_customers(
    tenant_id,store_id,table_session_id,customer_id,relationship
  ) VALUES (
    tenant_id_value,store_id_value,requested_table_session_id,requested_customer_id,'guest'
  ) ON CONFLICT (tenant_id,store_id,table_session_id,customer_id) DO NOTHING;
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

CREATE OR REPLACE FUNCTION mbox.prevent_customer_family_double_table_position()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE
  source_canonical uuid;
  target_canonical uuid;
  active_location_count integer;
  active_distinct_location_count integer;
BEGIN
  IF NEW.merged_into_customer_id IS NOT DISTINCT FROM OLD.merged_into_customer_id
    OR NEW.merged_into_customer_id IS NULL THEN
    RETURN NEW;
  END IF;
  source_canonical:=mbox.canonical_customer_id(OLD.tenant_id,OLD.store_id,OLD.id);
  target_canonical:=mbox.canonical_customer_id(
    OLD.tenant_id,OLD.store_id,NEW.merged_into_customer_id
  );
  SELECT count(*),count(DISTINCT (participation.table_session_id,participation.table_id))
    INTO active_location_count,active_distinct_location_count
  FROM mbox.table_session_customer_participations participation
  WHERE participation.tenant_id=OLD.tenant_id AND participation.store_id=OLD.store_id
    AND participation.left_at IS NULL
    AND mbox.canonical_customer_id(
      participation.tenant_id,participation.store_id,participation.customer_id
    ) IN (source_canonical,target_canonical);
  IF active_distinct_location_count>1 THEN
    RAISE EXCEPTION 'customer families at different active table positions cannot be merged'
      USING ERRCODE='55000';
  END IF;
  IF active_location_count>1 THEN
    UPDATE mbox.table_session_customer_participations participation
    SET left_at=clock_timestamp(),left_reason_code='identity_merged'
    WHERE participation.tenant_id=OLD.tenant_id AND participation.store_id=OLD.store_id
      AND participation.left_at IS NULL
      AND mbox.canonical_customer_id(
        participation.tenant_id,participation.store_id,participation.customer_id
      )=source_canonical;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer identity merge could not consolidate the duplicate table position'
        USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER customers_prevent_family_double_table_position
  BEFORE UPDATE OF merged_into_customer_id ON mbox.customers
  FOR EACH ROW EXECUTE FUNCTION mbox.prevent_customer_family_double_table_position();

-- Canonical-family identity rewrites and table-location commands use the same
-- store-scoped lock.  The DB trigger protects direct/internal UPDATE paths;
-- CustomerRepository takes this lock before customer row locks to keep the
-- normal application lock order deterministic.
CREATE OR REPLACE FUNCTION mbox.serialize_customer_merge_with_table_movements()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
BEGIN
  IF NEW.merged_into_customer_id IS DISTINCT FROM OLD.merged_into_customer_id THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'table-customer-movement:'||NEW.tenant_id::text||':'||NEW.store_id::text,0
    ));
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER a_customers_serialize_table_customer_movement
  BEFORE UPDATE OF merged_into_customer_id ON mbox.customers
  FOR EACH ROW EXECUTE FUNCTION mbox.serialize_customer_merge_with_table_movements();

CREATE OR REPLACE FUNCTION mbox.execute_table_customer_movement(
  requested_kind text,
  requested_source_table_session_id uuid,
  requested_target_table_session_id uuid,
  requested_target_table_id uuid,
  requested_moved_guest_count integer,
  requested_source_participation_ids uuid[],
  requested_target_roles text[],
  requested_target_confirmation_states text[],
  requested_actor_employee_id uuid,
  requested_reason text,
  requested_idempotency_key text,
  requested_fingerprint char(64),
  requested_split_public_id text,
  requested_capacity_override_reason text,
  requested_ownership_snapshot jsonb
) RETURNS TABLE (
  movement_event_id uuid,
  target_table_session_id uuid,
  moved_participant_count integer,
  revoked_guest_session_count integer,
  occurred_at timestamptz,
  target_capacity_at_movement integer,
  target_guest_count_before integer,
  target_guest_count_after integer,
  capacity_override_reason text,
  replayed boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE
  tenant_id_value uuid:=NULLIF(current_setting('app.tenant_id',true),'')::uuid;
  store_id_value uuid:=NULLIF(current_setting('app.store_id',true),'')::uuid;
  source_session mbox.table_sessions%ROWTYPE;
  target_session mbox.table_sessions%ROWTYPE;
  source_table mbox.tables%ROWTYPE;
  target_table mbox.tables%ROWTYPE;
  existing_event mbox.table_customer_movement_events%ROWTYPE;
  new_event mbox.table_customer_movement_events%ROWTYPE;
  source_segment mbox.table_session_customer_participations%ROWTYPE;
  selected_count integer;
  revoked_count integer:=0;
  expected_revoked_count integer:=0;
  participant_index integer;
  effective_target_role text;
  required_permission text;
  normalized_override_reason text:=NULLIF(btrim(requested_capacity_override_reason),'');
  target_guest_count integer;
  target_capacity_at_movement_value integer;
  target_guest_count_before_value integer;
  target_guest_count_after_value integer;
  selected_canonical_customer_ids uuid[];
  all_active_participant_count integer;
  closes_source_session boolean:=false;
BEGIN
  IF tenant_id_value IS NULL OR store_id_value IS NULL THEN
    RAISE EXCEPTION 'tenant and store scope are required' USING ERRCODE='42501';
  END IF;
  IF requested_kind NOT IN ('whole_table_transfer','participant_split','participant_merge')
    OR requested_moved_guest_count NOT BETWEEN 1 AND 200
    OR length(btrim(requested_reason)) NOT BETWEEN 2 AND 1000
    OR requested_fingerprint !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid table customer movement command' USING ERRCODE='22023';
  END IF;
  required_permission:=CASE WHEN requested_kind='whole_table_transfer'
    THEN 'table.transfer' ELSE 'table.participation.manage' END;
  IF NOT mbox.employee_has_effective_permission(
    tenant_id_value,store_id_value,requested_actor_employee_id,required_permission
  ) THEN
    RAISE EXCEPTION 'employee is not authorized for table customer movement'
      USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'table-customer-movement:'||tenant_id_value::text||':'||store_id_value::text,0
  ));

  SELECT * INTO existing_event FROM mbox.table_customer_movement_events event
  WHERE event.tenant_id=tenant_id_value AND event.store_id=store_id_value
    AND event.idempotency_key=requested_idempotency_key;
  IF FOUND THEN
    IF existing_event.request_fingerprint<>requested_fingerprint THEN
      RAISE EXCEPTION 'idempotency key was reused with another movement request'
        USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing_event.id,existing_event.target_table_session_id,
      existing_event.moved_participant_count,existing_event.revoked_guest_session_count,
      existing_event.occurred_at,existing_event.target_capacity_at_movement,
      existing_event.target_guest_count_before,existing_event.target_guest_count_after,
      existing_event.capacity_override_reason,true;
    RETURN;
  END IF;

  IF requested_kind='participant_merge' THEN
    IF requested_target_table_session_id IS NULL THEN
      RAISE EXCEPTION 'merge requires an existing target session' USING ERRCODE='22023';
    END IF;
    PERFORM session.id FROM mbox.table_sessions session
    WHERE session.tenant_id=tenant_id_value AND session.store_id=store_id_value
      AND session.id=ANY(ARRAY[requested_source_table_session_id,requested_target_table_session_id])
    ORDER BY session.id FOR UPDATE;
  ELSE
    PERFORM session.id FROM mbox.table_sessions session
    WHERE session.tenant_id=tenant_id_value AND session.store_id=store_id_value
      AND session.id=requested_source_table_session_id
    FOR UPDATE;
  END IF;
  SELECT * INTO source_session FROM mbox.table_sessions session
  WHERE session.tenant_id=tenant_id_value AND session.store_id=store_id_value
    AND session.id=requested_source_table_session_id;
  IF NOT FOUND OR source_session.status<>'open' THEN
    RAISE EXCEPTION 'source table session is not open' USING ERRCODE='40001';
  END IF;

  PERFORM 1 FROM mbox.tables venue_table
  WHERE venue_table.tenant_id=tenant_id_value AND venue_table.store_id=store_id_value
    AND venue_table.id=ANY(ARRAY[source_session.table_id,requested_target_table_id])
  ORDER BY venue_table.id FOR UPDATE;
  SELECT * INTO source_table FROM mbox.tables venue_table
  WHERE venue_table.tenant_id=tenant_id_value AND venue_table.store_id=store_id_value
    AND venue_table.id=source_session.table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source table is unavailable' USING ERRCODE='40001';
  END IF;
  SELECT venue_table.* INTO target_table FROM mbox.tables venue_table
  JOIN mbox.areas area ON area.tenant_id=venue_table.tenant_id
    AND area.store_id=venue_table.store_id AND area.id=venue_table.area_id
  WHERE venue_table.tenant_id=tenant_id_value AND venue_table.store_id=store_id_value
    AND venue_table.id=requested_target_table_id
    AND venue_table.status='available' AND area.status='active';
  IF NOT FOUND OR target_table.id=source_session.table_id THEN
    RAISE EXCEPTION 'target table is unavailable' USING ERRCODE='40001';
  END IF;

  IF requested_kind='whole_table_transfer' THEN
    IF requested_target_table_session_id IS NOT NULL
      AND requested_target_table_session_id<>source_session.id THEN
      RAISE EXCEPTION 'whole transfer keeps the same table session' USING ERRCODE='22023';
    END IF;
    IF requested_moved_guest_count<>source_session.guest_count THEN
      RAISE EXCEPTION 'whole transfer guest count changed concurrently' USING ERRCODE='40001';
    END IF;
    IF EXISTS (
      SELECT 1 FROM mbox.table_sessions session
      WHERE session.tenant_id=tenant_id_value AND session.store_id=store_id_value
        AND session.table_id=requested_target_table_id AND session.status IN ('open','closing')
      FOR UPDATE
    ) THEN
      RAISE EXCEPTION 'target table already has an active session' USING ERRCODE='40001';
    END IF;
    IF source_session.guest_count>target_table.capacity AND normalized_override_reason IS NULL THEN
      RAISE EXCEPTION 'capacity override reason is required' USING ERRCODE='23514';
    ELSIF source_session.guest_count<=target_table.capacity AND normalized_override_reason IS NOT NULL THEN
      RAISE EXCEPTION 'capacity override reason is not allowed within capacity' USING ERRCODE='23514';
    END IF;
    SELECT count(*)::integer INTO selected_count
    FROM mbox.table_session_customer_participations participation
    WHERE participation.tenant_id=tenant_id_value AND participation.store_id=store_id_value
      AND participation.table_session_id=source_session.id
      AND participation.table_id=source_session.table_id AND participation.left_at IS NULL;
    SELECT count(*)::integer INTO expected_revoked_count
    FROM mbox.guest_sessions guest_session
    WHERE guest_session.tenant_id=tenant_id_value AND guest_session.store_id=store_id_value
      AND guest_session.table_session_id=source_session.id AND guest_session.revoked_at IS NULL;

    INSERT INTO mbox.table_customer_movement_events(
      tenant_id,store_id,public_id,movement_kind,source_table_session_id,source_table_id,
      source_table_code_snapshot,target_table_session_id,target_table_id,target_table_code_snapshot,
      moved_guest_count,moved_participant_count,
      revoked_guest_session_count,target_capacity_at_movement,target_guest_count_before,target_guest_count_after,
      capacity_override_reason,moved_by_employee_id,reason,idempotency_key,request_fingerprint,
      location_version
    ) VALUES (
      tenant_id_value,store_id_value,'movement-'||replace(gen_random_uuid()::text,'-',''),
      requested_kind,source_session.id,source_session.table_id,source_table.code,source_session.id,
      target_table.id,target_table.code,source_session.guest_count,selected_count,expected_revoked_count,
      target_table.capacity,0,
      source_session.guest_count,normalized_override_reason,requested_actor_employee_id,
      btrim(requested_reason),requested_idempotency_key,requested_fingerprint,
      source_session.location_version+1
    ) RETURNING * INTO new_event;
    UPDATE mbox.table_sessions
    SET table_id=target_table.id,current_location_movement_event_id=new_event.id,
      location_version=new_event.location_version,
      capacity_at_open=target_table.capacity,
      capacity_override_reason=normalized_override_reason,
      capacity_overridden_by_employee_id=CASE WHEN source_session.guest_count>target_table.capacity
        THEN requested_actor_employee_id ELSE NULL END
    WHERE tenant_id=tenant_id_value AND store_id=store_id_value AND id=source_session.id;
    FOR source_segment IN
      SELECT * FROM mbox.table_session_customer_participations participation
      WHERE participation.tenant_id=tenant_id_value AND participation.store_id=store_id_value
        AND participation.table_session_id=source_session.id
        AND participation.table_id=source_session.table_id AND participation.left_at IS NULL
      ORDER BY participation.id FOR UPDATE
    LOOP
      PERFORM mbox.apply_table_customer_movement_member(
        new_event.id,source_segment.id,source_segment.participation_role,
        source_segment.confirmation_state
      );
    END LOOP;
    INSERT INTO mbox.table_session_transfer_events(
      tenant_id,store_id,table_session_id,source_table_id,target_table_id,
      transferred_by_employee_id,reason,ownership_snapshot,occurred_at
    ) VALUES (
      tenant_id_value,store_id_value,source_session.id,source_session.table_id,target_table.id,
      requested_actor_employee_id,btrim(requested_reason),COALESCE(requested_ownership_snapshot,'{}'),
      new_event.occurred_at
    );
    target_session:=source_session;
    target_session.table_id:=target_table.id;
  ELSE
    IF requested_source_participation_ids IS NULL
      OR cardinality(requested_source_participation_ids)<>cardinality(requested_target_roles)
      OR cardinality(requested_source_participation_ids)<>cardinality(requested_target_confirmation_states)
      OR requested_moved_guest_count>source_session.guest_count
      OR (requested_kind='participant_split'
        AND requested_moved_guest_count>=source_session.guest_count)
    THEN
      RAISE EXCEPTION 'partial movement requires explicit participants and leaves the source open'
        USING ERRCODE='22023';
    END IF;
    IF cardinality(requested_source_participation_ids)=0
      AND NOT (requested_kind='participant_merge'
        AND requested_moved_guest_count=source_session.guest_count) THEN
      RAISE EXCEPTION 'partial movement requires at least one explicit participant'
        USING ERRCODE='22023';
    END IF;
    PERFORM 1
    FROM mbox.table_session_customer_participations participation
    WHERE participation.tenant_id=tenant_id_value AND participation.store_id=store_id_value
      AND participation.id=ANY(requested_source_participation_ids)
      AND participation.table_session_id=source_session.id
      AND participation.table_id=source_session.table_id AND participation.left_at IS NULL
    ORDER BY participation.id
    FOR UPDATE;
    SELECT count(DISTINCT participation.id)::integer INTO selected_count
    FROM mbox.table_session_customer_participations participation
    WHERE participation.tenant_id=tenant_id_value AND participation.store_id=store_id_value
      AND participation.id=ANY(requested_source_participation_ids)
      AND participation.table_session_id=source_session.id
      AND participation.table_id=source_session.table_id AND participation.left_at IS NULL;
    IF selected_count<>cardinality(requested_source_participation_ids)
      OR selected_count>requested_moved_guest_count THEN
      RAISE EXCEPTION 'one or more participants are no longer at the source table'
        USING ERRCODE='40001';
    END IF;
    SELECT array_agg(DISTINCT mbox.canonical_customer_id(
      participation.tenant_id,participation.store_id,participation.customer_id
    )) INTO selected_canonical_customer_ids
    FROM mbox.table_session_customer_participations participation
    WHERE participation.tenant_id=tenant_id_value AND participation.store_id=store_id_value
      AND participation.id=ANY(requested_source_participation_ids);
    SELECT count(*)::integer INTO all_active_participant_count
    FROM mbox.table_session_customer_participations participation
    WHERE participation.tenant_id=tenant_id_value AND participation.store_id=store_id_value
      AND participation.table_session_id=source_session.id
      AND participation.table_id=source_session.table_id AND participation.left_at IS NULL;
    closes_source_session:=requested_kind='participant_merge'
      AND requested_moved_guest_count=source_session.guest_count;
    IF requested_kind='participant_merge'
      AND requested_moved_guest_count=source_session.guest_count
      AND selected_count<>all_active_participant_count THEN
      RAISE EXCEPTION 'full merge must move every active participant from the source table'
        USING ERRCODE='22023';
    END IF;
    IF EXISTS (SELECT 1 FROM mbox.orders order_row
      WHERE order_row.tenant_id=tenant_id_value AND order_row.store_id=store_id_value
        AND order_row.table_session_id=source_session.id
        AND NOT (
          (order_row.status='completed'
            AND order_row.payment_status IN ('paid','partially_refunded','refunded'))
          OR (order_row.status='cancelled' AND order_row.payment_status IN ('unpaid','refunded'))
        )
        AND (closes_source_session OR order_row.created_by_customer_id IS NULL
          OR mbox.canonical_customer_id(
            order_row.tenant_id,order_row.store_id,order_row.created_by_customer_id
          )=ANY(selected_canonical_customer_ids)))
      OR EXISTS (SELECT 1 FROM mbox.service_tasks task
        WHERE task.tenant_id=tenant_id_value AND task.store_id=store_id_value
          AND task.table_session_id=source_session.id
          AND task.status IN ('pending','acknowledged','in_progress'))
      OR EXISTS (SELECT 1 FROM mbox.pricing_authorizations pricing_auth
        WHERE pricing_auth.tenant_id=tenant_id_value AND pricing_auth.store_id=store_id_value
          AND pricing_auth.table_session_id=source_session.id AND pricing_auth.status='reserved')
      OR EXISTS (SELECT 1 FROM mbox.song_requests song
        WHERE song.tenant_id=tenant_id_value AND song.store_id=store_id_value
          AND song.table_session_id=source_session.id
          AND song.status IN ('requested','confirming','accepted','paid')
          AND (closes_source_session OR song.customer_id IS NULL OR mbox.canonical_customer_id(
            song.tenant_id,song.store_id,song.customer_id
          )=ANY(selected_canonical_customer_ids)))
      OR EXISTS (SELECT 1 FROM mbox.benefit_reservations reservation
        WHERE reservation.tenant_id=tenant_id_value AND reservation.store_id=store_id_value
          AND reservation.table_session_id=source_session.id AND reservation.status='reserved'
          AND (closes_source_session OR mbox.canonical_customer_id(
            reservation.tenant_id,reservation.store_id,reservation.customer_id
          )=ANY(selected_canonical_customer_ids)))
      OR EXISTS (SELECT 1 FROM mbox.customer_experience_plans plan
        WHERE plan.tenant_id=tenant_id_value AND plan.store_id=store_id_value
          AND plan.table_session_id=source_session.id
          AND plan.plan_state IN ('planned','active','paused')
          AND (closes_source_session OR mbox.canonical_customer_id(
            plan.tenant_id,plan.store_id,plan.customer_id
          )=ANY(selected_canonical_customer_ids)))
      OR EXISTS (SELECT 1 FROM mbox.member_redemptions redemption
        WHERE redemption.tenant_id=tenant_id_value AND redemption.store_id=store_id_value
          AND redemption.table_session_id=source_session.id
          AND redemption.status IN ('authorizing','awaiting_fulfillment')
          AND (closes_source_session OR mbox.canonical_customer_id(
            redemption.tenant_id,redemption.store_id,redemption.customer_id
          )=ANY(selected_canonical_customer_ids)))
      OR EXISTS (SELECT 1 FROM mbox.checkout_upgrade_offers offer
        WHERE offer.tenant_id=tenant_id_value AND offer.store_id=store_id_value
          AND offer.table_session_id=source_session.id AND offer.status IN ('offered','selected')
          AND (closes_source_session OR mbox.canonical_customer_id(
            offer.tenant_id,offer.store_id,offer.customer_id
          )=ANY(selected_canonical_customer_ids)))
      OR EXISTS (SELECT 1
        FROM mbox.order_items item
        JOIN mbox.orders order_row ON order_row.tenant_id=item.tenant_id
          AND order_row.store_id=item.store_id AND order_row.id=item.order_id
        WHERE order_row.tenant_id=tenant_id_value AND order_row.store_id=store_id_value
          AND order_row.table_session_id=source_session.id
          AND item.status NOT IN ('delivered','cancelled')
          AND (closes_source_session OR order_row.created_by_customer_id IS NULL
            OR mbox.canonical_customer_id(
              order_row.tenant_id,order_row.store_id,order_row.created_by_customer_id
            )=ANY(selected_canonical_customer_ids)))
      OR EXISTS (SELECT 1
        FROM mbox.kds_tasks task
        JOIN mbox.order_items item ON item.tenant_id=task.tenant_id
          AND item.store_id=task.store_id AND item.id=task.order_item_id
        JOIN mbox.orders order_row ON order_row.tenant_id=item.tenant_id
          AND order_row.store_id=item.store_id AND order_row.id=item.order_id
        WHERE order_row.tenant_id=tenant_id_value AND order_row.store_id=store_id_value
          AND order_row.table_session_id=source_session.id
          AND (task.status IN ('pending','accepted','preparing')
            OR (task.status='ready' AND item.status<>'delivered')
            OR (task.status='failed' AND item.status<>'cancelled'))
          AND (closes_source_session OR order_row.created_by_customer_id IS NULL
            OR mbox.canonical_customer_id(
              order_row.tenant_id,order_row.store_id,order_row.created_by_customer_id
            )=ANY(selected_canonical_customer_ids)))
      OR EXISTS (SELECT 1
        FROM mbox.payments payment
        JOIN mbox.orders order_row ON order_row.tenant_id=payment.tenant_id
          AND order_row.store_id=payment.store_id AND order_row.id=payment.order_id
        WHERE order_row.tenant_id=tenant_id_value AND order_row.store_id=store_id_value
          AND order_row.table_session_id=source_session.id
          AND payment.status IN ('created','pending')
          AND (closes_source_session OR order_row.created_by_customer_id IS NULL
            OR mbox.canonical_customer_id(
              order_row.tenant_id,order_row.store_id,order_row.created_by_customer_id
            )=ANY(selected_canonical_customer_ids)))
      OR EXISTS (SELECT 1
        FROM mbox.refunds refund
        JOIN mbox.payments payment ON payment.tenant_id=refund.tenant_id
          AND payment.store_id=refund.store_id AND payment.id=refund.payment_id
        JOIN mbox.orders order_row ON order_row.tenant_id=payment.tenant_id
          AND order_row.store_id=payment.store_id AND order_row.id=payment.order_id
        WHERE order_row.tenant_id=tenant_id_value AND order_row.store_id=store_id_value
          AND order_row.table_session_id=source_session.id
          AND refund.status IN ('requested','approved','processing')
          AND (closes_source_session OR order_row.created_by_customer_id IS NULL
            OR mbox.canonical_customer_id(
              order_row.tenant_id,order_row.store_id,order_row.created_by_customer_id
            )=ANY(selected_canonical_customer_ids)))
    THEN
      RAISE EXCEPTION 'partial movement is blocked by unresolved source-table business objects'
        USING ERRCODE='55000';
    END IF;

    IF requested_kind='participant_split' THEN
      IF requested_target_table_session_id IS NOT NULL
        OR requested_split_public_id IS NULL OR length(requested_split_public_id) NOT BETWEEN 8 AND 128
        OR EXISTS (SELECT 1 FROM mbox.table_sessions session
          WHERE session.tenant_id=tenant_id_value AND session.store_id=store_id_value
            AND session.table_id=target_table.id AND session.status IN ('open','closing') FOR UPDATE)
      THEN
        RAISE EXCEPTION 'split target must be an available table without an existing session'
          USING ERRCODE='40001';
      END IF;
      IF requested_moved_guest_count>target_table.capacity AND normalized_override_reason IS NULL THEN
        RAISE EXCEPTION 'capacity override reason is required' USING ERRCODE='23514';
      ELSIF requested_moved_guest_count<=target_table.capacity AND normalized_override_reason IS NOT NULL THEN
        RAISE EXCEPTION 'capacity override reason is not allowed within capacity' USING ERRCODE='23514';
      END IF;
      INSERT INTO mbox.table_sessions(
        tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,
        capacity_override_reason,capacity_overridden_by_employee_id,guest_profile_snapshot,
        status,opened_by_employee_id
      ) VALUES (
        tenant_id_value,store_id_value,target_table.id,requested_split_public_id,
        source_session.business_date,requested_moved_guest_count,target_table.capacity,
        normalized_override_reason,CASE WHEN requested_moved_guest_count>target_table.capacity
          THEN requested_actor_employee_id ELSE NULL END,'{}','open',requested_actor_employee_id
      ) RETURNING * INTO target_session;
      target_capacity_at_movement_value:=target_table.capacity;
      target_guest_count_before_value:=0;
      target_guest_count_after_value:=requested_moved_guest_count;
    ELSE
      SELECT * INTO target_session FROM mbox.table_sessions session
      WHERE session.tenant_id=tenant_id_value AND session.store_id=store_id_value
        AND session.id=requested_target_table_session_id AND session.table_id=target_table.id;
      IF NOT FOUND OR target_session.status<>'open' THEN
        RAISE EXCEPTION 'merge target session is not open' USING ERRCODE='40001';
      END IF;
      target_capacity_at_movement_value:=target_session.capacity_at_open;
      target_guest_count_before_value:=target_session.guest_count;
      target_guest_count:=target_session.guest_count+requested_moved_guest_count;
      target_guest_count_after_value:=target_guest_count;
      IF target_guest_count>target_session.capacity_at_open AND normalized_override_reason IS NULL THEN
        RAISE EXCEPTION 'capacity override reason is required' USING ERRCODE='23514';
      ELSIF target_guest_count<=target_session.capacity_at_open AND normalized_override_reason IS NOT NULL THEN
        RAISE EXCEPTION 'capacity override reason is not allowed within capacity' USING ERRCODE='23514';
      END IF;
      UPDATE mbox.table_sessions SET guest_count=target_guest_count,
        capacity_override_reason=normalized_override_reason,
        capacity_overridden_by_employee_id=CASE WHEN target_guest_count>capacity_at_open
          THEN requested_actor_employee_id ELSE NULL END
      WHERE tenant_id=tenant_id_value AND store_id=store_id_value AND id=target_session.id
      RETURNING * INTO target_session;
    END IF;

    IF NOT closes_source_session THEN
      UPDATE mbox.table_sessions AS updated_session
      SET guest_count=updated_session.guest_count-requested_moved_guest_count,
        capacity_override_reason=CASE
          WHEN updated_session.guest_count-requested_moved_guest_count>updated_session.capacity_at_open
          THEN updated_session.capacity_override_reason ELSE NULL END,
        capacity_overridden_by_employee_id=CASE
          WHEN updated_session.guest_count-requested_moved_guest_count>updated_session.capacity_at_open
          THEN updated_session.capacity_overridden_by_employee_id ELSE NULL END
      WHERE updated_session.tenant_id=tenant_id_value AND updated_session.store_id=store_id_value
        AND updated_session.id=source_session.id;
    END IF;
    SELECT count(*)::integer INTO expected_revoked_count
    FROM mbox.guest_sessions guest_session
    WHERE guest_session.tenant_id=tenant_id_value AND guest_session.store_id=store_id_value
      AND guest_session.table_session_id=source_session.id AND guest_session.revoked_at IS NULL
      AND (closes_source_session OR EXISTS (
        SELECT 1 FROM mbox.table_session_customer_participations participation
        WHERE participation.tenant_id=tenant_id_value AND participation.store_id=store_id_value
          AND participation.id=ANY(requested_source_participation_ids)
          AND mbox.canonical_customer_id(
            participation.tenant_id,participation.store_id,participation.customer_id
          )=mbox.canonical_customer_id(
            guest_session.tenant_id,guest_session.store_id,guest_session.customer_id
          )
      ));
    INSERT INTO mbox.table_customer_movement_events(
      tenant_id,store_id,public_id,movement_kind,source_table_session_id,source_table_id,
      source_table_code_snapshot,target_table_session_id,target_table_id,target_table_code_snapshot,
      moved_guest_count,moved_participant_count,
      revoked_guest_session_count,target_capacity_at_movement,target_guest_count_before,target_guest_count_after,
      capacity_override_reason,moved_by_employee_id,reason,idempotency_key,request_fingerprint
    ) VALUES (
      tenant_id_value,store_id_value,'movement-'||replace(gen_random_uuid()::text,'-',''),
      requested_kind,source_session.id,source_session.table_id,source_table.code,
      target_session.id,target_table.id,target_table.code,
      requested_moved_guest_count,selected_count,expected_revoked_count,target_capacity_at_movement_value,
      target_guest_count_before_value,target_guest_count_after_value,normalized_override_reason,
      requested_actor_employee_id,btrim(requested_reason),requested_idempotency_key,
      requested_fingerprint
    ) RETURNING * INTO new_event;
    FOR participant_index IN 1..cardinality(requested_source_participation_ids) LOOP
      SELECT participation.* INTO source_segment
      FROM mbox.table_session_customer_participations participation
      WHERE participation.tenant_id=tenant_id_value AND participation.store_id=store_id_value
        AND participation.id=requested_source_participation_ids[participant_index];
      IF NOT FOUND OR requested_target_roles[participant_index]<>source_segment.participation_role
        OR requested_target_confirmation_states[participant_index]
          <>source_segment.confirmation_state THEN
        RAISE EXCEPTION 'participant target role and confirmation must derive from the authoritative source position'
          USING ERRCODE='22023';
      END IF;
      effective_target_role:=source_segment.participation_role;
      IF requested_kind='participant_merge' AND effective_target_role='organizer'
        AND EXISTS (
          SELECT 1 FROM mbox.table_session_customer_participations target_participation
          WHERE target_participation.tenant_id=tenant_id_value
            AND target_participation.store_id=store_id_value
            AND target_participation.table_session_id=target_session.id
            AND target_participation.table_id=target_session.table_id
            AND target_participation.left_at IS NULL
            AND target_participation.participation_role='organizer'
        ) THEN
        effective_target_role:='companion';
      END IF;
      PERFORM mbox.apply_table_customer_movement_member(
        new_event.id,requested_source_participation_ids[participant_index],
        effective_target_role,source_segment.confirmation_state
      );
    END LOOP;
  END IF;

  WITH revoked AS (
    UPDATE mbox.guest_sessions guest_session
    SET revoked_at=clock_timestamp(),revoke_reason='table_location_changed'
    WHERE guest_session.tenant_id=tenant_id_value AND guest_session.store_id=store_id_value
      AND guest_session.table_session_id=source_session.id AND guest_session.revoked_at IS NULL
      AND (requested_kind='whole_table_transfer' OR closes_source_session OR EXISTS(
        SELECT participation.customer_id
        FROM mbox.table_session_customer_participations participation
        WHERE participation.tenant_id=tenant_id_value AND participation.store_id=store_id_value
          AND participation.left_movement_event_id=new_event.id
          AND mbox.canonical_customer_id(
            participation.tenant_id,participation.store_id,participation.customer_id
          )=mbox.canonical_customer_id(
            guest_session.tenant_id,guest_session.store_id,guest_session.customer_id
          )
      ))
    RETURNING guest_session.id
  ), logged AS (
    INSERT INTO mbox.guest_session_events(
      tenant_id,store_id,guest_session_id,table_id,table_session_id,
      event_type,outcome,reason_code,metadata,occurred_at
    ) SELECT tenant_id_value,store_id_value,revoked.id,source_session.table_id,source_session.id,
      'guest_session.revoked','revoked','TABLE_LOCATION_CHANGED','{}',new_event.occurred_at
    FROM revoked RETURNING id
  ) SELECT count(*)::integer INTO revoked_count FROM logged;
  IF revoked_count<>new_event.revoked_guest_session_count THEN
    RAISE EXCEPTION 'guest session revocation evidence changed during controlled movement'
      USING ERRCODE='40001';
  END IF;
  IF closes_source_session THEN
    UPDATE mbox.table_sessions
    SET status='closed',closed_at=new_event.occurred_at,
      closed_by_employee_id=requested_actor_employee_id
    WHERE tenant_id=tenant_id_value AND store_id=store_id_value
      AND id=source_session.id AND status='open';
  END IF;
  RETURN QUERY SELECT new_event.id,target_session.id,selected_count,revoked_count,
    new_event.occurred_at,new_event.target_capacity_at_movement,
    new_event.target_guest_count_before,new_event.target_guest_count_after,
    new_event.capacity_override_reason,false;
END $$;

CREATE OR REPLACE FUNCTION mbox.enforce_table_session_location_movement()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.table_id IS DISTINCT FROM OLD.table_id THEN
    IF NEW.current_location_movement_event_id IS NULL
      OR NEW.current_location_movement_event_id IS NOT DISTINCT FROM OLD.current_location_movement_event_id
      OR NOT EXISTS (
        SELECT 1 FROM mbox.table_customer_movement_events event
        WHERE event.tenant_id=NEW.tenant_id AND event.store_id=NEW.store_id
          AND event.id=NEW.current_location_movement_event_id
          AND event.movement_kind='whole_table_transfer'
          AND event.source_table_session_id=NEW.id AND event.target_table_session_id=NEW.id
          AND event.source_table_id=OLD.table_id AND event.target_table_id=NEW.table_id
          AND event.location_version=OLD.location_version+1
          AND NEW.location_version=event.location_version
      )
    THEN
      RAISE EXCEPTION 'table session location changes require a new controlled movement event'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.current_location_movement_event_id IS DISTINCT FROM OLD.current_location_movement_event_id
    OR NEW.location_version IS DISTINCT FROM OLD.location_version THEN
    RAISE EXCEPTION 'location movement evidence cannot change without a table location change'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER table_sessions_require_location_movement
  BEFORE UPDATE OF table_id,current_location_movement_event_id,location_version ON mbox.table_sessions
  FOR EACH ROW EXECUTE FUNCTION mbox.enforce_table_session_location_movement();

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  WHERE con.conrelid='mbox.service_tasks'::regclass
    AND con.contype='f'
    AND con.confrelid='mbox.table_sessions'::regclass
    AND cardinality(con.conkey)=4
  LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE mbox.service_tasks DROP CONSTRAINT %I',constraint_name);
  END IF;
END $$;

ALTER TABLE mbox.service_tasks
  ADD CONSTRAINT service_tasks_table_session_fk
    FOREIGN KEY (tenant_id,store_id,table_session_id)
    REFERENCES mbox.table_sessions(tenant_id,store_id,id);

CREATE OR REPLACE FUNCTION mbox.enforce_service_task_origin_table()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_table_id uuid;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.table_session_id,NEW.table_id)
    IS DISTINCT FROM ROW(OLD.table_session_id,OLD.table_id)
  THEN
    RAISE EXCEPTION 'service task origin table is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    SELECT table_id INTO current_table_id FROM mbox.table_sessions
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.table_session_id;
    IF current_table_id IS DISTINCT FROM NEW.table_id THEN
      RAISE EXCEPTION 'service task origin table must match its table session' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER service_tasks_enforce_origin_table
  BEFORE INSERT OR UPDATE OF table_session_id,table_id ON mbox.service_tasks
  FOR EACH ROW EXECUTE FUNCTION mbox.enforce_service_task_origin_table();

ALTER TABLE mbox.table_customer_movement_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.table_customer_movement_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.table_customer_movement_events
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
ALTER TABLE mbox.table_customer_movement_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.table_customer_movement_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.table_customer_movement_members
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

REVOKE ALL ON TABLE mbox.table_customer_movement_events,mbox.table_customer_movement_members FROM PUBLIC;
REVOKE INSERT,UPDATE,DELETE ON TABLE mbox.table_session_customer_participations FROM mbox_runtime;
REVOKE INSERT,UPDATE,DELETE ON TABLE mbox.table_session_customers FROM mbox_runtime;
REVOKE INSERT ON TABLE mbox.table_session_transfer_events FROM mbox_runtime;
REVOKE UPDATE ON TABLE mbox.table_sessions FROM mbox_runtime;
GRANT UPDATE(status,closed_by_employee_id,closed_at) ON TABLE mbox.table_sessions TO mbox_runtime;
GRANT SELECT ON TABLE mbox.table_customer_movement_events TO mbox_runtime;
GRANT SELECT ON TABLE mbox.table_customer_movement_members TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.apply_table_customer_movement_member(uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION mbox.apply_table_customer_movement_member(uuid,uuid,text,text) FROM mbox_runtime;
REVOKE ALL ON FUNCTION mbox.lock_active_table_customer_position(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.lock_active_table_customer_position(uuid,uuid) TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.lock_active_table_guest_session_position(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.lock_active_table_guest_session_position(uuid,uuid,uuid) TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.ensure_scanned_table_customer_position(char,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.ensure_scanned_table_customer_position(char,uuid,uuid) TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.execute_table_customer_movement(
  text,uuid,uuid,uuid,integer,uuid[],text[],text[],uuid,text,text,char,text,text,jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.execute_table_customer_movement(
  text,uuid,uuid,uuid,integer,uuid[],text[],text[],uuid,text,text,char,text,text,jsonb
) TO mbox_runtime;

INSERT INTO mbox.staff_permission_definitions (
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,'table.participation.manage','管理跨桌参与关系',
  'table_management','将明确参与者拆分或合并到另一桌次并保留完整位置历史','active'
FROM mbox.stores store
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
 AND permission.code='table.participation.manage'
WHERE role.code IN ('OWNER','OPS_LEAD','MANAGER','DEPUT_MANAGER')
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.seed_role_table_participation_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IN ('OWNER','OPS_LEAD','MANAGER','DEPUT_MANAGER') THEN
    INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
    SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
    FROM mbox.staff_permission_definitions permission
    WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
      AND permission.code='table.participation.manage'
    ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER roles_seed_table_participation_permission
  AFTER INSERT ON mbox.roles FOR EACH ROW
  EXECUTE FUNCTION mbox.seed_role_table_participation_permission();

CREATE OR REPLACE FUNCTION mbox.seed_store_table_participation_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions (
    tenant_id,store_id,code,name,category,description,status
  ) VALUES (
    NEW.tenant_id,NEW.id,'table.participation.manage','管理跨桌参与关系',
    'table_management','将明确参与者拆分或合并到另一桌次并保留完整位置历史','active'
  ) ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,status='active';
  RETURN NEW;
END $$;
CREATE TRIGGER stores_seed_table_participation_permission
  AFTER INSERT ON mbox.stores FOR EACH ROW
  EXECUTE FUNCTION mbox.seed_store_table_participation_permission();

COMMENT ON TABLE mbox.table_customer_movement_events IS
  'Strong append-only whole-table and explicit participant location movement facts; no JSON decides access or location.';
COMMENT ON TABLE mbox.table_customer_movement_members IS
  'Per-customer source and target participation segments for one table movement.';
COMMENT ON COLUMN mbox.table_session_customer_participations.table_id IS
  'Physical table for this immutable participation segment; current access requires an active segment at the session current table.';
COMMENT ON COLUMN mbox.service_tasks.table_id IS
  'Immutable origin table at task creation; active routing and display use table_sessions.table_id.';
COMMENT ON TABLE mbox.table_session_customers IS
  'Stable historical association retained for foreign-key compatibility; it is not current table access authority after migration 096.';
COMMENT ON FUNCTION mbox.ensure_scanned_table_customer_position(char,uuid,uuid) IS
  'Contract boundary for table scans after migration 096. Revoking legacy table_session_customers writes is fail-closed and requires old writer instances to be drained before this migration is applied.';

COMMIT;
