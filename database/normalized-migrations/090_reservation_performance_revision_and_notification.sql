BEGIN;

-- Performance changes that affect a reservation are business commands. The
-- immutable revision, impact and customer acknowledgement are the authority;
-- no reservation_snapshot or free JSON key participates in any decision.
CREATE TABLE mbox.performance_schedule_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(btrim(public_id)) BETWEEN 8 AND 128),
  schedule_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  revision_kind text NOT NULL CHECK (revision_kind IN ('rescheduled','cancelled','replaced')),
  previous_performer_id uuid NOT NULL,
  previous_starts_at timestamptz NOT NULL,
  previous_ends_at timestamptz NOT NULL,
  previous_status text NOT NULL CHECK (previous_status='scheduled'),
  resulting_schedule_id uuid,
  resulting_performer_id uuid,
  resulting_starts_at timestamptz,
  resulting_ends_at timestamptz,
  resulting_status text CHECK (resulting_status IN ('scheduled','cancelled')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  created_by_employee_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 160),
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,schedule_id) REFERENCES mbox.schedules(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,previous_performer_id) REFERENCES mbox.performers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,resulting_schedule_id) REFERENCES mbox.schedules(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,resulting_performer_id) REFERENCES mbox.performers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,schedule_id,revision_number),
  UNIQUE (tenant_id,store_id,idempotency_key),
  UNIQUE (tenant_id,store_id,id,schedule_id,revision_number),
  UNIQUE (tenant_id,store_id,id),
  CHECK (previous_ends_at>previous_starts_at),
  CHECK (resulting_ends_at IS NULL OR resulting_starts_at IS NULL OR resulting_ends_at>resulting_starts_at),
  CHECK (
    (revision_kind='rescheduled' AND resulting_schedule_id=schedule_id
      AND resulting_performer_id=previous_performer_id
      AND resulting_starts_at IS NOT NULL AND resulting_ends_at IS NOT NULL
      AND resulting_status='scheduled')
    OR
    (revision_kind='cancelled' AND resulting_schedule_id=schedule_id
      AND resulting_performer_id=previous_performer_id
      AND resulting_starts_at=previous_starts_at AND resulting_ends_at=previous_ends_at
      AND resulting_status='cancelled')
    OR
    (revision_kind='replaced' AND resulting_schedule_id IS NOT NULL
      AND resulting_schedule_id<>schedule_id AND resulting_performer_id IS NOT NULL
      AND resulting_starts_at IS NOT NULL AND resulting_ends_at IS NOT NULL
      AND resulting_status='scheduled')
  )
);

CREATE INDEX performance_schedule_revisions_timeline_idx
  ON mbox.performance_schedule_revisions(
    tenant_id,store_id,schedule_id,revision_number DESC,created_at DESC,id
  );

CREATE TABLE mbox.reservation_performance_impacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(btrim(public_id)) BETWEEN 8 AND 128),
  revision_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  reservation_customer_id uuid,
  canonical_customer_id uuid,
  original_preferred_schedule_id uuid NOT NULL,
  impact_kind text NOT NULL CHECK (impact_kind IN ('rescheduled','cancelled','replaced')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,revision_id)
    REFERENCES mbox.performance_schedule_revisions(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,reservation_id) REFERENCES mbox.reservations(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,reservation_customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,canonical_customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,original_preferred_schedule_id) REFERENCES mbox.schedules(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,revision_id,reservation_id),
  UNIQUE (tenant_id,store_id,id,revision_id,reservation_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK ((reservation_customer_id IS NULL)=(canonical_customer_id IS NULL))
);

CREATE INDEX reservation_performance_impacts_customer_idx
  ON mbox.reservation_performance_impacts(
    tenant_id,store_id,canonical_customer_id,created_at DESC,id
  ) WHERE canonical_customer_id IS NOT NULL;

CREATE TABLE mbox.reservation_performance_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(btrim(public_id)) BETWEEN 8 AND 128),
  impact_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  acting_customer_id uuid NOT NULL,
  canonical_customer_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('keep','reselect','clear')),
  selected_schedule_id uuid,
  resulting_preferred_schedule_id uuid,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 160),
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,impact_id,revision_id,reservation_id)
    REFERENCES mbox.reservation_performance_impacts(tenant_id,store_id,id,revision_id,reservation_id),
  FOREIGN KEY (tenant_id,store_id,acting_customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,canonical_customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,selected_schedule_id) REFERENCES mbox.schedules(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,resulting_preferred_schedule_id) REFERENCES mbox.schedules(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,impact_id),
  UNIQUE (tenant_id,store_id,idempotency_key),
  UNIQUE (tenant_id,store_id,id,impact_id,reservation_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (decision='keep' AND selected_schedule_id IS NULL)
    OR
    (decision='reselect' AND selected_schedule_id IS NOT NULL
      AND resulting_preferred_schedule_id=selected_schedule_id)
    OR
    (decision='clear' AND selected_schedule_id IS NULL
      AND resulting_preferred_schedule_id IS NULL)
  )
);

CREATE FUNCTION mbox.validate_reservation_performance_impact()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  revision_record record;
  reservation_record record;
BEGIN
  SELECT revision.schedule_id,revision.revision_kind
  INTO revision_record
  FROM mbox.performance_schedule_revisions revision
  WHERE revision.tenant_id=NEW.tenant_id AND revision.store_id=NEW.store_id
    AND revision.id=NEW.revision_id;
  SELECT reservation.customer_id,reservation.preferred_schedule_id
  INTO reservation_record
  FROM mbox.reservations reservation
  WHERE reservation.tenant_id=NEW.tenant_id AND reservation.store_id=NEW.store_id
    AND reservation.id=NEW.reservation_id;
  IF revision_record.schedule_id IS NULL OR reservation_record.preferred_schedule_id IS NULL
    OR revision_record.schedule_id<>NEW.original_preferred_schedule_id
    OR reservation_record.preferred_schedule_id<>NEW.original_preferred_schedule_id
    OR revision_record.revision_kind<>NEW.impact_kind THEN
    RAISE EXCEPTION 'Reservation performance impact does not match strong revision/reservation facts'
      USING ERRCODE='23514';
  END IF;
  IF reservation_record.customer_id IS NULL THEN
    IF NEW.reservation_customer_id IS NOT NULL OR NEW.canonical_customer_id IS NOT NULL THEN
      RAISE EXCEPTION 'Anonymous reservation impact cannot claim a customer'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.reservation_customer_id<>reservation_record.customer_id
    OR NEW.canonical_customer_id<>mbox.canonical_customer_id(
      NEW.tenant_id,NEW.store_id,reservation_record.customer_id
    ) THEN
    RAISE EXCEPTION 'Reservation impact customer family does not match reservation'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reservation_performance_impacts_validate
  BEFORE INSERT ON mbox.reservation_performance_impacts
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_reservation_performance_impact();

CREATE FUNCTION mbox.validate_reservation_performance_acknowledgement()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  impact_record record;
  resulting_record record;
BEGIN
  SELECT impact.reservation_id,impact.revision_id,impact.canonical_customer_id,
    reservation.arrival_at,revision.revision_kind,revision.resulting_schedule_id
  INTO impact_record
  FROM mbox.reservation_performance_impacts impact
  JOIN mbox.reservations reservation
    ON reservation.tenant_id=impact.tenant_id AND reservation.store_id=impact.store_id
   AND reservation.id=impact.reservation_id
  JOIN mbox.performance_schedule_revisions revision
    ON revision.tenant_id=impact.tenant_id AND revision.store_id=impact.store_id
   AND revision.id=impact.revision_id
  WHERE impact.tenant_id=NEW.tenant_id AND impact.store_id=NEW.store_id
    AND impact.id=NEW.impact_id;
  IF impact_record.reservation_id IS NULL OR impact_record.canonical_customer_id IS NULL
    OR impact_record.reservation_id<>NEW.reservation_id
    OR impact_record.revision_id<>NEW.revision_id
    OR impact_record.canonical_customer_id<>NEW.canonical_customer_id
    OR mbox.canonical_customer_id(NEW.tenant_id,NEW.store_id,NEW.acting_customer_id)
      <>NEW.canonical_customer_id THEN
    RAISE EXCEPTION 'Reservation performance acknowledgement ownership is invalid'
      USING ERRCODE='23514';
  END IF;
  IF NEW.decision='keep' AND (
    (impact_record.revision_kind='cancelled' AND NEW.resulting_preferred_schedule_id IS NOT NULL)
    OR
    (impact_record.revision_kind<>'cancelled'
      AND NEW.resulting_preferred_schedule_id IS DISTINCT FROM impact_record.resulting_schedule_id
      AND NEW.resulting_preferred_schedule_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Keep decision does not match the revision result'
      USING ERRCODE='23514';
  END IF;
  IF NEW.resulting_preferred_schedule_id IS NOT NULL THEN
    SELECT schedule.id INTO resulting_record
    FROM mbox.schedules schedule
    JOIN mbox.stores store
      ON store.tenant_id=schedule.tenant_id AND store.id=schedule.store_id
    WHERE schedule.tenant_id=NEW.tenant_id AND schedule.store_id=NEW.store_id
      AND schedule.id=NEW.resulting_preferred_schedule_id
      AND schedule.status='scheduled'
      AND (schedule.starts_at AT TIME ZONE store.timezone)::date
        =(impact_record.arrival_at AT TIME ZONE store.timezone)::date;
    IF resulting_record.id IS NULL THEN
      RAISE EXCEPTION 'Resulting performance does not match reservation local date'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reservation_performance_acknowledgements_validate
  BEFORE INSERT ON mbox.reservation_performance_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_reservation_performance_acknowledgement();

CREATE FUNCTION mbox.guard_performance_schedule_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision_id uuid;
BEGIN
  IF NEW.performer_id IS NOT DISTINCT FROM OLD.performer_id
    AND NEW.starts_at IS NOT DISTINCT FROM OLD.starts_at
    AND NEW.ends_at IS NOT DISTINCT FROM OLD.ends_at
    AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.performer_id=OLD.performer_id AND NEW.starts_at=OLD.starts_at AND NEW.ends_at=OLD.ends_at
    AND ((OLD.status='scheduled' AND NEW.status='performing')
      OR (OLD.status='performing' AND NEW.status='completed')) THEN
    RETURN NEW;
  END IF;
  revision_id := NULLIF(current_setting('mbox.performance_revision_id',true),'')::uuid;
  IF revision_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM mbox.performance_schedule_revisions revision
    WHERE revision.tenant_id=OLD.tenant_id AND revision.store_id=OLD.store_id
      AND revision.id=revision_id AND revision.schedule_id=OLD.id
      AND revision.previous_performer_id=OLD.performer_id
      AND revision.previous_starts_at=OLD.starts_at AND revision.previous_ends_at=OLD.ends_at
      AND revision.previous_status=OLD.status
      AND (
        (revision.revision_kind='rescheduled'
          AND revision.resulting_schedule_id=NEW.id
          AND revision.resulting_performer_id=NEW.performer_id
          AND revision.resulting_starts_at=NEW.starts_at
          AND revision.resulting_ends_at=NEW.ends_at AND NEW.status='scheduled')
        OR
        (revision.revision_kind='cancelled'
          AND NEW.performer_id=OLD.performer_id AND NEW.starts_at=OLD.starts_at
          AND NEW.ends_at=OLD.ends_at AND NEW.status='cancelled')
        OR
        (revision.revision_kind='replaced'
          AND revision.resulting_schedule_id<>OLD.id
          AND NEW.performer_id=OLD.performer_id AND NEW.starts_at=OLD.starts_at
          AND NEW.ends_at=OLD.ends_at AND NEW.status='cancelled')
      )
  ) THEN
    RAISE EXCEPTION 'Schedule cancellation or rescheduling requires an exact append-only revision'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER schedules_performance_revision_guard
  BEFORE UPDATE OF performer_id,starts_at,ends_at,status ON mbox.schedules
  FOR EACH ROW EXECUTE FUNCTION mbox.guard_performance_schedule_revision();

CREATE FUNCTION mbox.guard_reservation_performance_acknowledgement()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE acknowledgement_id uuid;
BEGIN
  IF NEW.preferred_schedule_id IS NOT DISTINCT FROM OLD.preferred_schedule_id THEN RETURN NEW; END IF;
  acknowledgement_id := NULLIF(
    current_setting('mbox.reservation_performance_acknowledgement_id',true),'')
  ::uuid;
  IF acknowledgement_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM mbox.reservation_performance_acknowledgements acknowledgement
    JOIN mbox.reservation_performance_impacts impact
      ON impact.tenant_id=acknowledgement.tenant_id AND impact.store_id=acknowledgement.store_id
     AND impact.id=acknowledgement.impact_id
    WHERE acknowledgement.tenant_id=OLD.tenant_id
      AND acknowledgement.store_id=OLD.store_id
      AND acknowledgement.id=acknowledgement_id
      AND acknowledgement.reservation_id=OLD.id
      AND impact.original_preferred_schedule_id=OLD.preferred_schedule_id
      AND acknowledgement.resulting_preferred_schedule_id IS NOT DISTINCT FROM NEW.preferred_schedule_id
      AND NEW.status=OLD.status AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.arrival_at=OLD.arrival_at
      AND NEW.aggregate_version=OLD.aggregate_version+1
  ) THEN
    RETURN NEW;
  END IF;
  IF EXISTS(
    SELECT 1 FROM mbox.reservation_performance_impacts impact
    LEFT JOIN mbox.reservation_performance_acknowledgements acknowledgement
      ON acknowledgement.tenant_id=impact.tenant_id AND acknowledgement.store_id=impact.store_id
     AND acknowledgement.impact_id=impact.id
    WHERE impact.tenant_id=OLD.tenant_id AND impact.store_id=OLD.store_id
      AND impact.reservation_id=OLD.id
      AND impact.original_preferred_schedule_id=OLD.preferred_schedule_id
      AND acknowledgement.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Pending performance impact requires an exact customer acknowledgement'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reservations_performance_acknowledgement_guard
  BEFORE UPDATE OF preferred_schedule_id ON mbox.reservations
  FOR EACH ROW EXECUTE FUNCTION mbox.guard_reservation_performance_acknowledgement();

CREATE TRIGGER performance_schedule_revisions_append_only
  BEFORE UPDATE OR DELETE ON mbox.performance_schedule_revisions
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER reservation_performance_impacts_append_only
  BEFORE UPDATE OR DELETE ON mbox.reservation_performance_impacts
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER reservation_performance_acknowledgements_append_only
  BEFORE UPDATE OR DELETE ON mbox.reservation_performance_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

-- Reservation notifications use a dedicated one-use authorization tied to one
-- reservation, one typed context and one published template. Generic member
-- notification consent is deliberately not consulted or promoted.
CREATE TABLE mbox.reservation_performance_notification_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  notification_type text NOT NULL DEFAULT 'reservation_performance_revised'
    CHECK (notification_type='reservation_performance_revised'),
  authorization_context text NOT NULL DEFAULT 'reservation'
    CHECK (authorization_context='reservation'),
  policy_version integer NOT NULL CHECK (policy_version>0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  template_id text NOT NULL CHECK (length(btrim(template_id)) BETWEEN 8 AND 128),
  page_path text NOT NULL CHECK (page_path ~ '^pages/[A-Za-z0-9_./-]{1,180}$'),
  change_type_data_key text NOT NULL CHECK (change_type_data_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  performance_time_data_key text NOT NULL CHECK (performance_time_data_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  reservation_time_data_key text NOT NULL CHECK (reservation_time_data_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  effective_from timestamptz,
  effective_until timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  UNIQUE (tenant_id,store_id,notification_type,policy_version),
  UNIQUE (tenant_id,store_id,id,notification_type,authorization_context,policy_version,template_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until>effective_from),
  CHECK (
    (status='published' AND effective_from IS NOT NULL AND published_at IS NOT NULL)
    OR status<>'published'
  ),
  CHECK (
    change_type_data_key<>performance_time_data_key
    AND change_type_data_key<>reservation_time_data_key
    AND performance_time_data_key<>reservation_time_data_key
  )
);

ALTER TABLE mbox.reservation_performance_notification_policies
  ADD CONSTRAINT reservation_performance_notification_policies_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,store_id WITH =,
    tstzrange(effective_from,effective_until,'[)') WITH &&
  ) WHERE (status='published');

CREATE TABLE mbox.reservation_performance_notification_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  canonical_customer_id uuid NOT NULL,
  identity_external_id text NOT NULL,
  policy_id uuid NOT NULL,
  notification_type text NOT NULL CHECK (notification_type='reservation_performance_revised'),
  authorization_context text NOT NULL CHECK (authorization_context='reservation'),
  policy_version integer NOT NULL CHECK (policy_version>0),
  template_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('granted','denied','revoked')),
  platform_result text NOT NULL CHECK (platform_result IN ('accept','reject','ban','revoke')),
  authorization_version integer NOT NULL CHECK (authorization_version>0),
  uses_allowed integer NOT NULL CHECK (uses_allowed IN (0,1)),
  source text NOT NULL CHECK (source IN ('wechat_client','customer_revoke')),
  platform_event_reference_hash char(64) NOT NULL
    CHECK (platform_event_reference_hash ~ '^[0-9a-f]{64}$'),
  authorized_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,reservation_id) REFERENCES mbox.reservations(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,canonical_customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,identity_external_id)
    REFERENCES mbox.wechat_identities(tenant_id,store_id,external_identity_id),
  FOREIGN KEY (
    tenant_id,store_id,policy_id,notification_type,authorization_context,policy_version,template_id
  ) REFERENCES mbox.reservation_performance_notification_policies(
    tenant_id,store_id,id,notification_type,authorization_context,policy_version,template_id
  ),
  UNIQUE (tenant_id,store_id,reservation_id,policy_id,authorization_version),
  UNIQUE (tenant_id,store_id,identity_external_id,platform_event_reference_hash),
  UNIQUE (
    tenant_id,store_id,id,reservation_id,canonical_customer_id,identity_external_id,
    policy_id,notification_type,authorization_context,policy_version,template_id
  ),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (platform_result='accept' AND decision='granted' AND uses_allowed=1 AND source='wechat_client')
    OR (platform_result IN ('reject','ban') AND decision='denied' AND uses_allowed=0 AND source='wechat_client')
    OR (platform_result='revoke' AND decision='revoked' AND uses_allowed=0 AND source='customer_revoke')
  )
);

CREATE INDEX reservation_performance_notification_auth_latest_idx
  ON mbox.reservation_performance_notification_authorizations(
    tenant_id,store_id,reservation_id,policy_id,authorization_version DESC,id DESC
  );

CREATE FUNCTION mbox.validate_reservation_performance_notification_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1
    FROM mbox.reservations reservation
    JOIN mbox.wechat_identities identity
      ON identity.tenant_id=reservation.tenant_id AND identity.store_id=reservation.store_id
     AND identity.external_identity_id=NEW.identity_external_id
     AND identity.channel='mini_program' AND identity.revoked_at IS NULL
    JOIN mbox.customer_identities customer_identity
      ON customer_identity.tenant_id=identity.tenant_id
     AND customer_identity.store_id=identity.store_id
     AND customer_identity.identity_kind='wechat'
     AND customer_identity.identity_hash=encode(
       digest('wechat:'||identity.principal_id,'sha256'),'hex'
     )
     AND customer_identity.status='active'
    WHERE reservation.tenant_id=NEW.tenant_id AND reservation.store_id=NEW.store_id
      AND reservation.id=NEW.reservation_id AND reservation.customer_id IS NOT NULL
      AND reservation.preferred_schedule_id IS NOT NULL
      AND reservation.status IN ('pending','confirmed','arrived','seated')
      AND mbox.canonical_customer_id(
        reservation.tenant_id,reservation.store_id,reservation.customer_id
      )=NEW.canonical_customer_id
      AND mbox.canonical_customer_id(
        customer_identity.tenant_id,customer_identity.store_id,customer_identity.customer_id
      )=NEW.canonical_customer_id
  ) THEN
    RAISE EXCEPTION 'Reservation notification authorization is not owned by the customer family'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reservation_performance_notification_auth_owner_guard
  BEFORE INSERT ON mbox.reservation_performance_notification_authorizations
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_reservation_performance_notification_owner();

CREATE TABLE mbox.reservation_performance_notification_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  impact_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  identity_external_id text NOT NULL,
  authorization_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  notification_type text NOT NULL CHECK (notification_type='reservation_performance_revised'),
  authorization_context text NOT NULL CHECK (authorization_context='reservation'),
  policy_version integer NOT NULL CHECK (policy_version>0),
  template_id text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed','unknown','suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1),
  max_attempts integer NOT NULL DEFAULT 1 CHECK (max_attempts=1),
  locked_by text,
  locked_at timestamptz,
  sent_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,impact_id,revision_id,reservation_id)
    REFERENCES mbox.reservation_performance_impacts(tenant_id,store_id,id,revision_id,reservation_id),
  FOREIGN KEY (tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY (
    tenant_id,store_id,authorization_id,reservation_id,customer_id,identity_external_id,
    policy_id,notification_type,authorization_context,policy_version,template_id
  ) REFERENCES mbox.reservation_performance_notification_authorizations(
    tenant_id,store_id,id,reservation_id,canonical_customer_id,identity_external_id,
    policy_id,notification_type,authorization_context,policy_version,template_id
  ),
  UNIQUE (tenant_id,store_id,impact_id,notification_type),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (status='sending' AND locked_by IS NOT NULL AND locked_at IS NOT NULL AND sent_at IS NULL)
    OR (status='sent' AND locked_by IS NULL AND locked_at IS NULL AND sent_at IS NOT NULL)
    OR (status IN ('pending','failed','unknown','suppressed')
      AND locked_by IS NULL AND locked_at IS NULL AND sent_at IS NULL)
  )
);

CREATE INDEX reservation_performance_notification_jobs_queue_idx
  ON mbox.reservation_performance_notification_jobs(
    tenant_id,store_id,status,scheduled_for,created_at,id
  ) WHERE status='pending';

CREATE TABLE mbox.reservation_performance_notification_authorization_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  notification_job_id uuid NOT NULL,
  used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id,authorization_id)
    REFERENCES mbox.reservation_performance_notification_authorizations(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,notification_job_id)
    REFERENCES mbox.reservation_performance_notification_jobs(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,authorization_id),
  UNIQUE (tenant_id,store_id,notification_job_id),
  UNIQUE (tenant_id,store_id,id)
);

CREATE TABLE mbox.reservation_performance_notification_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  notification_job_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted','provider_rejected','unknown')),
  provider_reference_hash char(64)
    CHECK (provider_reference_hash IS NULL OR provider_reference_hash ~ '^[0-9a-f]{64}$'),
  provider_error_code text CHECK (
    provider_error_code IS NULL OR provider_error_code ~ '^[a-z][a-z0-9_.:-]{2,95}$'
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id,notification_job_id)
    REFERENCES mbox.reservation_performance_notification_jobs(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,notification_job_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (outcome='accepted' AND provider_error_code IS NULL)
    OR (outcome IN ('provider_rejected','unknown') AND provider_error_code IS NOT NULL)
  )
);

CREATE TRIGGER reservation_performance_notification_auth_append_only
  BEFORE UPDATE OR DELETE ON mbox.reservation_performance_notification_authorizations
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER reservation_performance_notification_uses_append_only
  BEFORE UPDATE OR DELETE ON mbox.reservation_performance_notification_authorization_uses
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER reservation_performance_notification_receipts_append_only
  BEFORE UPDATE OR DELETE ON mbox.reservation_performance_notification_receipts
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

CREATE FUNCTION mbox.enqueue_reservation_performance_wechat_jobs(
  target_tenant_id uuid,
  target_store_id uuid,
  target_revision_id uuid
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE inserted_count integer;
BEGIN
  INSERT INTO mbox.reservation_performance_notification_jobs(
    tenant_id,store_id,reservation_id,impact_id,revision_id,customer_id,
    identity_external_id,authorization_id,policy_id,notification_type,
    authorization_context,policy_version,template_id,scheduled_for
  )
  SELECT impact.tenant_id,impact.store_id,impact.reservation_id,impact.id,impact.revision_id,
    impact.canonical_customer_id,authorized.identity_external_id,authorized.id,
    policy.id,policy.notification_type,policy.authorization_context,
    policy.policy_version,policy.template_id,clock_timestamp()
  FROM mbox.reservation_performance_impacts impact
  JOIN mbox.reservation_performance_notification_policies policy
    ON policy.tenant_id=impact.tenant_id AND policy.store_id=impact.store_id
   AND policy.status='published' AND policy.notification_type='reservation_performance_revised'
   AND policy.authorization_context='reservation'
   AND policy.effective_from<=clock_timestamp()
   AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
  JOIN LATERAL (
    SELECT candidate.id,candidate.identity_external_id,candidate.tenant_id,candidate.store_id
    FROM mbox.reservation_performance_notification_authorizations candidate
    WHERE candidate.tenant_id=impact.tenant_id AND candidate.store_id=impact.store_id
      AND candidate.reservation_id=impact.reservation_id
      AND candidate.canonical_customer_id=impact.canonical_customer_id
      AND candidate.policy_id=policy.id
      AND candidate.notification_type=policy.notification_type
      AND candidate.authorization_context=policy.authorization_context
      AND candidate.policy_version=policy.policy_version
      AND candidate.template_id=policy.template_id
      AND candidate.decision='granted'
    ORDER BY candidate.authorization_version DESC,candidate.id DESC LIMIT 1
  ) authorized ON NOT EXISTS(
    SELECT 1 FROM mbox.reservation_performance_notification_authorization_uses used
    WHERE used.tenant_id=authorized.tenant_id
      AND used.store_id=authorized.store_id
      AND used.authorization_id=authorized.id
  )
  WHERE impact.tenant_id=target_tenant_id AND impact.store_id=target_store_id
    AND impact.revision_id=target_revision_id
    AND impact.canonical_customer_id IS NOT NULL
  ON CONFLICT (tenant_id,store_id,impact_id,notification_type) DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  RETURN inserted_count;
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'performance_schedule_revisions','reservation_performance_impacts',
    'reservation_performance_acknowledgements',
    'reservation_performance_notification_policies',
    'reservation_performance_notification_authorizations',
    'reservation_performance_notification_jobs',
    'reservation_performance_notification_authorization_uses',
    'reservation_performance_notification_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT,INSERT ON TABLE mbox.performance_schedule_revisions TO mbox_runtime;
GRANT SELECT,INSERT ON TABLE mbox.reservation_performance_impacts TO mbox_runtime;
GRANT SELECT,INSERT ON TABLE mbox.reservation_performance_acknowledgements TO mbox_runtime;
GRANT SELECT ON TABLE mbox.reservation_performance_notification_policies TO mbox_runtime;
GRANT SELECT,INSERT ON TABLE mbox.reservation_performance_notification_authorizations TO mbox_runtime;
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.reservation_performance_notification_jobs TO mbox_runtime;
GRANT SELECT,INSERT ON TABLE mbox.reservation_performance_notification_authorization_uses TO mbox_runtime;
GRANT SELECT,INSERT ON TABLE mbox.reservation_performance_notification_receipts TO mbox_runtime;

INSERT INTO mbox.staff_permission_definitions(
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,'performance.schedule.revise','调整已发布演出','performance',
  '取消、改期或换场并生成受影响预约；不自动取消预约','active'
FROM mbox.stores store
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,
  description=EXCLUDED.description,status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
WHERE role.status='active' AND role.code IN ('OWNER','MANAGER','DEPUT_MANAGER','OPS_LEAD')
  AND permission.code='performance.schedule.revise'
ON CONFLICT DO NOTHING;

CREATE FUNCTION mbox.seed_store_reservation_performance_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id,store_id,code,name,category,description,status
  ) VALUES(
    NEW.tenant_id,NEW.id,'performance.schedule.revise','调整已发布演出','performance',
    '取消、改期或换场并生成受影响预约；不自动取消预约','active'
  ) ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name,category=EXCLUDED.category,
    description=EXCLUDED.description,status='active';
  RETURN NEW;
END;
$$;

CREATE TRIGGER stores_seed_reservation_performance_permissions
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_reservation_performance_permissions();

CREATE FUNCTION mbox.seed_role_reservation_performance_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
  SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
  FROM mbox.staff_permission_definitions permission
  WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
    AND permission.code='performance.schedule.revise'
    AND NEW.code IN ('OWNER','MANAGER','DEPUT_MANAGER','OPS_LEAD')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER roles_seed_reservation_performance_permissions
  AFTER INSERT ON mbox.roles
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_role_reservation_performance_permissions();

COMMENT ON TABLE mbox.performance_schedule_revisions IS
  'Append-only strong revisions for published performance cancellation, rescheduling and replacement.';
COMMENT ON TABLE mbox.reservation_performance_impacts IS
  'Append-only affected reservations; an impact never changes or cancels the reservation status.';
COMMENT ON TABLE mbox.reservation_performance_acknowledgements IS
  'Customer-family-owned keep/reselect/clear decisions; performance preference is not a seat guarantee.';
COMMENT ON TABLE mbox.reservation_performance_notification_authorizations IS
  'One-use WeChat subscription authorization tied to one reservation, context, policy and template.';
COMMENT ON TABLE mbox.reservation_performance_notification_jobs IS
  'Typed reservation performance notification queue; generic consent and JSON are never send authority.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='090',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
