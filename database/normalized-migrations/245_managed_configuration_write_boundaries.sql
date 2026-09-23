BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';

-- Narrow commands preserve the SELECT-only runtime policy table boundary.
-- Every command derives the tenant/store from the existing scoped transaction;
-- callers cannot supply another scope, table, column, or executable statement.
CREATE FUNCTION mbox.lock_managed_notification_policy(p_id uuid)
RETURNS SETOF mbox.wechat_notification_policies LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,mbox AS $$
  SELECT * FROM mbox.wechat_notification_policies
  WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()
    AND id=p_id AND governance_mode='managed' FOR UPDATE;
$$;

CREATE FUNCTION mbox.replace_managed_notification_draft(p_id uuid,p_expected integer,p_content jsonb,p_reason text)
RETURNS SETOF mbox.wechat_notification_policies LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,mbox AS $$
BEGIN
  RETURN QUERY UPDATE mbox.wechat_notification_policies SET
    notification_type=p_content->>'notificationType',authorization_purpose=p_content->>'authorizationPurpose',
    authorization_context=p_content->>'authorizationContext',template_id=p_content->>'templateId',
    page_path=p_content->>'pagePath',points_data_key=p_content->>'pointsDataKey',balance_data_key=p_content->>'balanceDataKey',
    occurred_at_data_key=p_content->>'occurredAtDataKey',expires_at_data_key=p_content->>'expiresAtDataKey',
    expiry_lead_days=(p_content->>'expiryLeadDays')::integer,
    max_per_customer_per_24h=(p_content->>'maxPerCustomerPer24h')::integer,
    minimum_interval_minutes=(p_content->>'minimumIntervalMinutes')::integer,
    quiet_hours_start=(p_content->>'quietHoursStart')::time,quiet_hours_end=(p_content->>'quietHoursEnd')::time,
    draft_revision=p_expected+1,reason=p_reason,updated_at=clock_timestamp()
  WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()
    AND id=p_id AND governance_mode='managed' AND status='draft' AND draft_revision=p_expected
  RETURNING *;
END $$;

CREATE FUNCTION mbox.approve_managed_notification_draft(p_id uuid,p_expected integer,p_employee uuid,p_reason text)
RETURNS SETOF mbox.wechat_notification_policies LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,mbox AS $$
BEGIN
  -- Existing governance triggers require the exact immutable impact approval,
  -- current revision and an approver who contributed to none of this draft.
  RETURN QUERY UPDATE mbox.wechat_notification_policies SET status='approved',
    approved_by_employee_id=p_employee,approved_at=clock_timestamp(),reason=p_reason
  WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()
    AND id=p_id AND governance_mode='managed' AND status='draft' AND draft_revision=p_expected
  RETURNING *;
END $$;

CREATE FUNCTION mbox.publish_managed_notification_policy(p_id uuid,p_expected integer,p_employee uuid,
  p_from timestamptz,p_until timestamptz,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE policy mbox.wechat_notification_policies;
BEGIN
  IF NOT COALESCE(mbox.employee_has_effective_permission(mbox.current_tenant_id(),mbox.current_store_id(),p_employee,'loyalty.policy.publish'),false) THEN
    RAISE EXCEPTION 'notification publication requires employee permission' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('notification-publication:'||mbox.current_tenant_id()::text||':'||mbox.current_store_id()::text,0));
  SELECT * INTO policy FROM mbox.lock_managed_notification_policy(p_id);
  IF policy.id IS NULL OR policy.status<>'approved' OR policy.draft_revision<>p_expected
    OR p_from IS NULL OR p_from<=clock_timestamp() OR (p_until IS NOT NULL AND p_until<=p_from)
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 2 AND 500 THEN
    RAISE EXCEPTION 'notification publication requires exact approved draft and future schedule' USING ERRCODE='23514';
  END IF;
  IF policy.approved_by_employee_id=p_employee OR policy.drafted_by_employee_id=p_employee
    OR EXISTS(SELECT 1 FROM mbox.membership_configuration_draft_contributors
      WHERE tenant_id=policy.tenant_id AND store_id=policy.store_id
        AND configuration_domain='wechat_notifications' AND configuration_id=p_id AND employee_id=p_employee) THEN
    RAISE EXCEPTION 'publisher must differ from every contributor and approver' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM mbox.wechat_notification_policies
    WHERE tenant_id=policy.tenant_id AND store_id=policy.store_id AND notification_type=policy.notification_type
      AND status='published' AND effective_from>=p_from) THEN
    RAISE EXCEPTION 'a later notification publication already exists' USING ERRCODE='23514';
  END IF;
  -- Legacy rules may end only as part of a fully checked managed replacement.
  UPDATE mbox.wechat_notification_policies SET effective_until=p_from,updated_at=clock_timestamp()
  WHERE tenant_id=policy.tenant_id AND store_id=policy.store_id AND notification_type=policy.notification_type
    AND status='published' AND effective_from<p_from AND (effective_until IS NULL OR effective_until>p_from);
  UPDATE mbox.wechat_notification_policies SET status='published',effective_from=p_from,effective_until=p_until,
    published_by_employee_id=p_employee,publication_reason=p_reason,published_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE tenant_id=policy.tenant_id AND store_id=policy.store_id AND id=p_id;
END $$;

CREATE FUNCTION mbox.clear_draft_tier_benefit_rules(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
BEGIN
  PERFORM 1 FROM mbox.loyalty_tier_benefit_policy_versions
  WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id() AND id=p_id AND status='draft' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'only scoped draft benefit rules may be replaced' USING ERRCODE='42501'; END IF;
  DELETE FROM mbox.loyalty_tier_benefit_rules
  WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id() AND policy_version_id=p_id;
END $$;
CREATE FUNCTION mbox.remove_absent_draft_redemption_items(p_id uuid,p_keep text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
BEGIN
  PERFORM 1 FROM mbox.redemption_catalog_versions
  WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id() AND id=p_id AND status='draft' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'only scoped draft redemption items may be replaced' USING ERRCODE='42501'; END IF;
  DELETE FROM mbox.redemption_catalog_items
  WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id() AND catalog_version_id=p_id
    AND NOT(public_id=ANY(p_keep));
END $$;

-- Gift fulfillment needs only scoped key-share locks, never product-map UPDATE.
CREATE FUNCTION mbox.lock_benefit_allowed_products(p_id uuid)
RETURNS SETOF mbox.benefit_allowed_products LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,mbox AS $$
  SELECT * FROM mbox.benefit_allowed_products
  WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()
    AND benefit_id=p_id FOR KEY SHARE;
$$;
REVOKE ALL ON FUNCTION mbox.lock_benefit_allowed_products(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.lock_benefit_allowed_products(uuid) TO mbox_runtime;

REVOKE ALL ON FUNCTION mbox.lock_managed_notification_policy(uuid),
  mbox.replace_managed_notification_draft(uuid,integer,jsonb,text),
  mbox.approve_managed_notification_draft(uuid,integer,uuid,text),
  mbox.publish_managed_notification_policy(uuid,integer,uuid,timestamptz,timestamptz,text),
  mbox.clear_draft_tier_benefit_rules(uuid),mbox.remove_absent_draft_redemption_items(uuid,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.lock_managed_notification_policy(uuid),
  mbox.replace_managed_notification_draft(uuid,integer,jsonb,text),
  mbox.approve_managed_notification_draft(uuid,integer,uuid,text),
  mbox.publish_managed_notification_policy(uuid,integer,uuid,timestamptz,timestamptz,text),
  mbox.clear_draft_tier_benefit_rules(uuid),mbox.remove_absent_draft_redemption_items(uuid,text[]) TO mbox_runtime;

UPDATE mbox.normalized_schema_metadata SET schema_version='245',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
