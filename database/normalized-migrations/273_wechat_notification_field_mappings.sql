BEGIN;

-- Keyword-to-source rows are the executable template. The four original columns
-- stay so already published policies keep their previous payload shape.
-- membership_card_points is the loyalty account balance after the event: this
-- product has one points balance per membership card. WeChat's "0000" sample is
-- a number placeholder, not zero-padding.
CREATE TABLE mbox.wechat_notification_policy_fields (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  data_key text NOT NULL CHECK (data_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  value_source text NOT NULL CHECK (value_source IN (
    'store_name','granted_points','deducted_points','membership_card_points','current_points',
    'balance_after','points_change_text','occurred_at','expires_at','account_label',
    'last_month_consumed_points','month_expiring_points','account_points_balance','points_at_risk'
  )),
  sort_order smallint NOT NULL CHECK (sort_order BETWEEN 0 AND 9),
  PRIMARY KEY (tenant_id, store_id, policy_id, data_key),
  UNIQUE (tenant_id, store_id, policy_id, sort_order),
  UNIQUE (tenant_id, store_id, policy_id, value_source),
  FOREIGN KEY (tenant_id, store_id, policy_id)
    REFERENCES mbox.wechat_notification_policies (tenant_id, store_id, id)
);

ALTER TABLE mbox.wechat_notification_policy_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.wechat_notification_policy_fields FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.wechat_notification_policy_fields
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON TABLE mbox.wechat_notification_policy_fields FROM PUBLIC;
GRANT SELECT ON TABLE mbox.wechat_notification_policy_fields TO mbox_runtime;

CREATE FUNCTION mbox.assert_wechat_notification_template_mappings(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,mbox AS $$
DECLARE policy mbox.wechat_notification_policies;
BEGIN
  SELECT * INTO policy FROM mbox.wechat_notification_policies
  WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id() AND id=p_id;
  IF policy.id IS NULL THEN
    RAISE EXCEPTION 'notification policy is outside the current store' USING ERRCODE='42501';
  END IF;
  IF policy.template_id='WWUaFeNQ-mHRkwMYhEKMl_WsZ3iGyoKKHdOGbtC209I' THEN
    IF policy.notification_type NOT IN ('loyalty_points_credited','loyalty_points_reversed') THEN
      RAISE EXCEPTION 'points-change template requires a balance notification' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM mbox.wechat_notification_policy_fields field
        WHERE field.tenant_id=policy.tenant_id AND field.store_id=policy.store_id AND field.policy_id=policy.id) <> 5
      OR (SELECT count(*) FROM mbox.wechat_notification_policy_fields field
        WHERE field.tenant_id=policy.tenant_id AND field.store_id=policy.store_id AND field.policy_id=policy.id
          AND (field.data_key, field.value_source) IN (
            ('thing5','store_name'),('number2','granted_points'),('number7','membership_card_points'),
            ('number3','deducted_points'),('number4','current_points')
          )) <> 5 THEN
      RAISE EXCEPTION 'points-change template requires its five field mappings' USING ERRCODE='23514';
    END IF;
  ELSIF policy.template_id='1oGIa4-cFg9vXfoD3hYaSpYCRITsO4isvtX1N-7GHGI' THEN
    IF policy.notification_type <> 'loyalty_points_expiring' THEN
      RAISE EXCEPTION 'points-expiry template requires an expiry notification' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM mbox.wechat_notification_policy_fields field
        WHERE field.tenant_id=policy.tenant_id AND field.store_id=policy.store_id AND field.policy_id=policy.id) <> 5
      OR (SELECT count(*) FROM mbox.wechat_notification_policy_fields field
        WHERE field.tenant_id=policy.tenant_id AND field.store_id=policy.store_id AND field.policy_id=policy.id
          AND (field.data_key, field.value_source) IN (
            ('thing1','account_label'),('time2','expires_at'),('thing3','last_month_consumed_points'),
            ('thing4','month_expiring_points'),('thing5','account_points_balance')
          )) <> 5 THEN
      RAISE EXCEPTION 'points-expiry template requires its five field mappings' USING ERRCODE='23514';
    END IF;
  END IF;
END $$;

CREATE FUNCTION mbox.sync_wechat_notification_policy_fields(p_id uuid, p_content jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,mbox AS $$
DECLARE
  policy mbox.wechat_notification_policies;
  mapping_count integer;
BEGIN
  IF p_content IS NULL OR NOT (p_content ? 'fieldMappings') THEN RETURN; END IF;
  IF jsonb_typeof(p_content->'fieldMappings') <> 'array' THEN
    RAISE EXCEPTION 'wechat notification field mappings must be an array' USING ERRCODE='23514';
  END IF;
  SELECT * INTO policy FROM mbox.wechat_notification_policies
  WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()
    AND id=p_id AND governance_mode='managed' AND status='draft';
  IF policy.id IS NULL THEN
    RAISE EXCEPTION 'only a managed notification draft can change field mappings' USING ERRCODE='42501';
  END IF;
  SELECT count(*) INTO mapping_count FROM jsonb_array_elements(p_content->'fieldMappings');
  IF mapping_count > 10 THEN
    RAISE EXCEPTION 'wechat notification field mappings exceed 10' USING ERRCODE='23514';
  END IF;
  IF mapping_count <> (
    SELECT count(DISTINCT item->>'dataKey') FROM jsonb_array_elements(p_content->'fieldMappings') item
  ) OR mapping_count <> (
    SELECT count(DISTINCT item->>'valueSource') FROM jsonb_array_elements(p_content->'fieldMappings') item
  ) THEN
    RAISE EXCEPTION 'wechat notification field mappings must be unique' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_content->'fieldMappings') item
    WHERE COALESCE(item->>'dataKey','') !~ '^[a-z][a-z0-9_]{1,31}$'
      OR COALESCE(item->>'valueSource','') NOT IN (
        'store_name','granted_points','deducted_points','membership_card_points','current_points',
        'balance_after','points_change_text','occurred_at','expires_at','account_label',
        'last_month_consumed_points','month_expiring_points','account_points_balance','points_at_risk'
      )
      OR (
        policy.notification_type IN ('loyalty_points_credited','loyalty_points_reversed')
        AND item->>'valueSource' NOT IN (
          'store_name','granted_points','deducted_points','membership_card_points','current_points',
          'balance_after','points_change_text','occurred_at'
        )
      )
      OR (
        policy.notification_type='loyalty_points_expiring'
        AND item->>'valueSource' NOT IN (
          'store_name','account_label','occurred_at','expires_at','points_change_text','points_at_risk',
          'last_month_consumed_points','month_expiring_points','account_points_balance'
        )
      )
      OR (
        item->>'valueSource' IN ('granted_points','deducted_points','membership_card_points','current_points','balance_after')
        AND item->>'dataKey' !~ '^number[0-9]{1,2}$'
      )
      OR (
        item->>'valueSource' IN ('store_name','account_label')
        AND item->>'dataKey' !~ '^(thing|phrase|name|letter|character_string)[0-9]{1,2}$'
      )
      OR (
        item->>'valueSource'='points_change_text'
        AND item->>'dataKey' !~ '^(thing|phrase|character_string)[0-9]{1,2}$'
      )
      OR (
        item->>'valueSource' IN ('occurred_at','expires_at')
        AND item->>'dataKey' !~ '^(time|date)[0-9]{1,2}$'
      )
      OR (
        item->>'valueSource' IN ('last_month_consumed_points','month_expiring_points','account_points_balance','points_at_risk')
        AND item->>'dataKey' !~ '^(thing|phrase|number|character_string)[0-9]{1,2}$'
      )
  ) THEN
    RAISE EXCEPTION 'wechat notification field mapping is invalid' USING ERRCODE='23514';
  END IF;
  DELETE FROM mbox.wechat_notification_policy_fields
  WHERE tenant_id=policy.tenant_id AND store_id=policy.store_id AND policy_id=policy.id;
  INSERT INTO mbox.wechat_notification_policy_fields(
    tenant_id, store_id, policy_id, data_key, value_source, sort_order
  )
  SELECT policy.tenant_id, policy.store_id, policy.id,
    item->>'dataKey', item->>'valueSource', (ordinality - 1)::smallint
  FROM jsonb_array_elements(p_content->'fieldMappings') WITH ORDINALITY AS field(item, ordinality);
  PERFORM mbox.assert_wechat_notification_template_mappings(policy.id);
END $$;

CREATE OR REPLACE FUNCTION mbox.replace_managed_notification_draft(p_id uuid,p_expected integer,p_content jsonb,p_reason text)
RETURNS SETOF mbox.wechat_notification_policies LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,mbox AS $$
BEGIN
  RETURN QUERY UPDATE mbox.wechat_notification_policies SET
    notification_type=p_content->>'notificationType',authorization_purpose=p_content->>'authorizationPurpose',
    authorization_context=p_content->>'authorizationContext',template_id=p_content->>'templateId',
    page_path=p_content->>'pagePath',points_data_key=p_content->>'pointsDataKey',balance_data_key=NULLIF(p_content->>'balanceDataKey',''),
    occurred_at_data_key=p_content->>'occurredAtDataKey',expires_at_data_key=NULLIF(p_content->>'expiresAtDataKey',''),
    expiry_lead_days=NULLIF(p_content->>'expiryLeadDays','')::integer,
    max_per_customer_per_24h=(p_content->>'maxPerCustomerPer24h')::integer,
    minimum_interval_minutes=(p_content->>'minimumIntervalMinutes')::integer,
    quiet_hours_start=NULLIF(p_content->>'quietHoursStart','')::time,quiet_hours_end=NULLIF(p_content->>'quietHoursEnd','')::time,
    draft_revision=p_expected+1,reason=p_reason,updated_at=clock_timestamp()
  WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()
    AND id=p_id AND governance_mode='managed' AND status='draft' AND draft_revision=p_expected
  RETURNING *;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM mbox.sync_wechat_notification_policy_fields(p_id, p_content);
END $$;

CREATE FUNCTION mbox.create_managed_notification_draft(p_employee uuid, p_content jsonb, p_reason text)
RETURNS SETOF mbox.wechat_notification_policies LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,mbox AS $$
DECLARE created mbox.wechat_notification_policies;
BEGIN
  IF p_employee IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 2 AND 500 OR p_content IS NULL THEN
    RAISE EXCEPTION 'notification draft requires an employee, reason and content' USING ERRCODE='23514';
  END IF;
  IF NOT (
    COALESCE(mbox.employee_has_effective_permission(mbox.current_tenant_id(),mbox.current_store_id(),p_employee,'loyalty.policy.manage'),false)
    OR COALESCE(mbox.employee_has_effective_permission(mbox.current_tenant_id(),mbox.current_store_id(),p_employee,'loyalty.configuration.edit'),false)
  ) THEN
    RAISE EXCEPTION 'notification draft requires employee permission' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM mbox.stores
  WHERE tenant_id=mbox.current_tenant_id() AND id=mbox.current_store_id()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'notification draft store is not current' USING ERRCODE='42501';
  END IF;
  INSERT INTO mbox.wechat_notification_policies(
    tenant_id,store_id,notification_type,authorization_purpose,authorization_context,
    policy_version,status,template_id,page_path,points_data_key,balance_data_key,
    occurred_at_data_key,expires_at_data_key,expiry_lead_days,max_per_customer_per_24h,
    minimum_interval_minutes,quiet_hours_start,quiet_hours_end,reason,
    governance_mode,drafted_by_employee_id,draft_revision
  )
  SELECT mbox.current_tenant_id(),mbox.current_store_id(),
    p_content->>'notificationType',p_content->>'authorizationPurpose',p_content->>'authorizationContext',
    COALESCE((
      SELECT MAX(existing.policy_version) FROM mbox.wechat_notification_policies existing
      WHERE existing.tenant_id=mbox.current_tenant_id() AND existing.store_id=mbox.current_store_id()
        AND existing.notification_type=p_content->>'notificationType'
    ),0)+1,
    'draft',p_content->>'templateId',p_content->>'pagePath',p_content->>'pointsDataKey',
    NULLIF(p_content->>'balanceDataKey',''),p_content->>'occurredAtDataKey',NULLIF(p_content->>'expiresAtDataKey',''),
    NULLIF(p_content->>'expiryLeadDays','')::integer,(p_content->>'maxPerCustomerPer24h')::integer,
    (p_content->>'minimumIntervalMinutes')::integer,NULLIF(p_content->>'quietHoursStart','')::time,
    NULLIF(p_content->>'quietHoursEnd','')::time,btrim(p_reason),'managed',p_employee,1
  RETURNING * INTO created;
  PERFORM mbox.sync_wechat_notification_policy_fields(created.id, p_content);
  PERFORM mbox.assert_wechat_notification_template_mappings(created.id);
  RETURN QUERY SELECT * FROM mbox.wechat_notification_policies
  WHERE tenant_id=created.tenant_id AND store_id=created.store_id AND id=created.id;
END $$;

REVOKE ALL ON FUNCTION mbox.assert_wechat_notification_template_mappings(uuid),
  mbox.sync_wechat_notification_policy_fields(uuid,jsonb),
  mbox.create_managed_notification_draft(uuid,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.create_managed_notification_draft(uuid,jsonb,text) TO mbox_runtime;

COMMENT ON TABLE mbox.wechat_notification_policy_fields IS
  'Typed WeChat keyword mapping. Sends with rows use only these keywords; policies without rows keep the original four data keys.';

UPDATE mbox.normalized_schema_metadata SET schema_version='273',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
