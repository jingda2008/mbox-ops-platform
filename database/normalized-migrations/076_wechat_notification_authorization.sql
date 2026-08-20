BEGIN;

ALTER TABLE mbox.customer_notification_consents
  DROP CONSTRAINT customer_notification_consents_decision_check,
  ADD COLUMN template_id text,
  ADD COLUMN authorization_context text,
  ADD COLUMN platform_result text,
  ADD COLUMN platform_event_reference text,
  ADD CONSTRAINT customer_notification_consents_decision_check
    CHECK (decision IN ('granted','denied','revoked')),
  ADD CONSTRAINT customer_notification_consents_wechat_evidence_check CHECK (
    source<>'wechat_authorization'
    OR (
      channel='wechat'
      AND template_id IS NOT NULL AND length(btrim(template_id)) BETWEEN 8 AND 128
      AND authorization_context IN ('loyalty_accrual','reservation','activity','service')
      AND platform_result IN ('accept','reject','ban')
      AND platform_event_reference IS NOT NULL
      AND length(btrim(platform_event_reference)) BETWEEN 8 AND 160
      AND (
        (platform_result='accept' AND decision='granted')
        OR (platform_result IN ('reject','ban') AND decision='denied')
      )
    )
  );

CREATE INDEX customer_notification_consents_template_latest_idx
  ON mbox.customer_notification_consents (
    tenant_id, store_id, customer_id, channel, purpose, template_id,
    consent_version DESC, id DESC
  ) WHERE template_id IS NOT NULL;

COMMENT ON COLUMN mbox.customer_notification_consents.platform_result IS
  'Typed result returned by wx.requestSubscribeMessage. Sending still depends on WeChat enforcing the template authorization; client evidence alone cannot force delivery.';

COMMIT;
