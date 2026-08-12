BEGIN;

ALTER TABLE mbox.benefit_redemptions
  ADD COLUMN authorization_source jsonb NOT NULL DEFAULT '{"kind":"legacy"}'::jsonb
    CHECK (jsonb_typeof(authorization_source) = 'object' AND authorization_source <> '{}'::jsonb);

ALTER TABLE mbox.benefit_redemptions
  ALTER COLUMN authorization_source DROP DEFAULT;

COMMENT ON COLUMN mbox.benefit_redemptions.authorization_source IS
  'Immutable authorization evidence captured when the benefit is redeemed.';

COMMIT;
