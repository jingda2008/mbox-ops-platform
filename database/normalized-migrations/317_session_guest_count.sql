BEGIN;

CREATE FUNCTION mbox.can_edit_session_guest_count(p_session uuid, p_employee uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,mbox AS $$
  SELECT EXISTS (
    SELECT 1 FROM mbox.table_sessions s
    WHERE s.tenant_id=mbox.current_tenant_id() AND s.store_id=mbox.current_store_id() AND s.id=p_session
      AND mbox.employee_has_effective_permission(s.tenant_id,s.store_id,p_employee,'table.open')
      AND (mbox.employee_has_effective_permission(s.tenant_id,s.store_id,p_employee,'table.view_all')
        OR EXISTS (SELECT 1 FROM mbox.table_assignments a
          WHERE (a.tenant_id,a.store_id,a.table_id,a.employee_id)=(s.tenant_id,s.store_id,s.table_id,p_employee)
            AND a.cancelled_at IS NULL AND a.starts_at<=statement_timestamp()
            AND (a.ends_at IS NULL OR a.ends_at>statement_timestamp())))
  )
$$;

-- Runtime has no direct UPDATE grant for headcount or guest profile columns.
CREATE FUNCTION mbox.edit_session_guest_count(p_session uuid, p_employee uuid, p_table uuid,
  p_location_version bigint, p_expected integer, p_count integer, p_reason text)
RETURNS date LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE
  visit mbox.table_sessions%ROWTYPE;
  reason text := nullif(btrim(p_reason),'');
BEGIN
  SELECT * INTO visit FROM mbox.table_sessions
    WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id() AND id=p_session FOR UPDATE;
  IF NOT FOUND OR NOT mbox.can_edit_session_guest_count(p_session,p_employee) THEN
    RAISE EXCEPTION '无权修改该桌人数' USING ERRCODE='P3171';
  END IF;
  IF visit.status<>'open' OR visit.table_id IS DISTINCT FROM p_table
    OR visit.location_version IS DISTINCT FROM p_location_version OR visit.guest_count IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION '桌台或人数已变化，请核对最新人数再修改' USING ERRCODE='P3172';
  END IF;
  IF p_count IS NULL OR p_count NOT BETWEEN 1 AND 200 OR p_count=p_expected THEN
    RAISE EXCEPTION '请填写新的实际人数（1 至 200）' USING ERRCODE='P3173';
  END IF;
  IF p_count>visit.capacity_at_open AND (reason IS NULL OR length(reason) NOT BETWEEN 2 AND 1000) THEN
    RAISE EXCEPTION '超过桌次容量，请填写至少两个字的加座说明' USING ERRCODE='P3173';
  END IF;
  UPDATE mbox.table_sessions SET guest_count=p_count,
    capacity_override_reason=CASE WHEN p_count>visit.capacity_at_open THEN reason END,
    capacity_overridden_by_employee_id=CASE WHEN p_count>visit.capacity_at_open THEN p_employee END,
    guest_profile_snapshot=jsonb_set(guest_profile_snapshot,'{extraSeatCount}',to_jsonb(greatest(0,p_count-visit.capacity_at_open)))
  WHERE (tenant_id,store_id,id)=(visit.tenant_id,visit.store_id,visit.id);
  RETURN visit.business_date;
END $$;

REVOKE ALL ON FUNCTION mbox.can_edit_session_guest_count(uuid,uuid),
  mbox.edit_session_guest_count(uuid,uuid,uuid,bigint,integer,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.can_edit_session_guest_count(uuid,uuid),
  mbox.edit_session_guest_count(uuid,uuid,uuid,bigint,integer,integer,text) TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='317',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
