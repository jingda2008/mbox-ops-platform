BEGIN;
-- Credential rotation governs new login admission, not existing six-hour
-- employee sessions. Match staff authentication and the KDS query policy while
-- retaining every employee, session, device, expiry, presence and role guard.
CREATE OR REPLACE FUNCTION mbox.guard_pickup_actor_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE device_hash_value text;
BEGIN
 PERFORM 1 FROM mbox.staff_sessions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.staff_session_id
  AND employee_id=NEW.authorized_employee_id AND device_access_lease_id=NEW.device_access_lease_id AND revoked_at IS NULL
  AND expires_at>clock_timestamp() AND online_lease_until>clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'pickup source session invalid' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM mbox.employees WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.authorized_employee_id AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'pickup source employee invalid' USING ERRCODE='23514';END IF;
 SELECT device_key_hash INTO device_hash_value FROM mbox.store_device_access_leases
  WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.device_access_lease_id AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'pickup source lease invalid' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM mbox.pickup_devices WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.device_id AND device_key_hash=device_hash_value AND enabled FOR SHARE;
 IF NOT FOUND OR NOT mbox.employee_has_effective_permission(NEW.tenant_id,NEW.store_id,NEW.authorized_employee_id,'kds.deliver') THEN
  RAISE EXCEPTION 'pickup source must be a current authorized shared device session' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

COMMIT;
