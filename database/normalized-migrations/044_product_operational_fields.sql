BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE mbox.products
  ADD COLUMN guest_visible boolean NOT NULL DEFAULT true,
  ADD COLUMN search_text text NOT NULL DEFAULT '' CHECK (length(search_text) <= 4000),
  ADD COLUMN recommendation_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN recommendation_min_guests smallint NOT NULL DEFAULT 1 CHECK (recommendation_min_guests BETWEEN 1 AND 200),
  ADD COLUMN recommendation_max_guests smallint NOT NULL DEFAULT 100 CHECK (recommendation_max_guests BETWEEN 1 AND 200),
  ADD COLUMN recommendation_priority smallint NOT NULL DEFAULT 100 CHECK (recommendation_priority BETWEEN 0 AND 1000),
  ADD COLUMN recommendation_scene_tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN recommendation_intent_tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN recommendation_taste_tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN recommendation_dwell_tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN recommendation_single_wave_eligible boolean NOT NULL DEFAULT true,
  ADD COLUMN recommendation_expected_prep_minutes smallint NOT NULL DEFAULT 8
    CHECK (recommendation_expected_prep_minutes BETWEEN 0 AND 240),
  ADD COLUMN recommendation_hold_minutes smallint NOT NULL DEFAULT 10
    CHECK (recommendation_hold_minutes BETWEEN 0 AND 240),
  ADD COLUMN recommendation_upgrade_product_id uuid,
  ADD COLUMN menu_sort_order integer NOT NULL DEFAULT 999 CHECK (menu_sort_order BETWEEN 0 AND 100000),
  ADD COLUMN available_from time,
  ADD COLUMN available_until time,
  ADD COLUMN allowed_channels text[] NOT NULL DEFAULT ARRAY['guest_qr','staff_assisted','cashier','reservation','integration']::text[],
  ADD COLUMN max_order_quantity smallint NOT NULL DEFAULT 50 CHECK (max_order_quantity BETWEEN 1 AND 9999),
  ADD COLUMN kds_priority smallint NOT NULL DEFAULT 100 CHECK (kds_priority BETWEEN 0 AND 1000),
  ADD COLUMN fulfillment_sla_seconds integer CHECK (fulfillment_sla_seconds IS NULL OR fulfillment_sla_seconds BETWEEN 30 AND 14400),
  ADD COLUMN cost_amount_minor bigint CHECK (cost_amount_minor IS NULL OR cost_amount_minor >= 0),
  ADD CONSTRAINT products_recommendation_guest_range
    CHECK (recommendation_min_guests <= recommendation_max_guests),
  ADD CONSTRAINT products_recommendation_scene_tags_check
    CHECK (recommendation_scene_tags <@ ARRAY['date','brothers','besties','friends','business','celebration','unsure']::text[]),
  ADD CONSTRAINT products_recommendation_intent_tags_check
    CHECK (recommendation_intent_tags <@ ARRAY['relaxed','energetic','ritual','unsure']::text[]),
  ADD CONSTRAINT products_recommendation_taste_tags_check
    CHECK (recommendation_taste_tags <@ ARRAY['refreshing','layered','strong','any']::text[]),
  ADD CONSTRAINT products_recommendation_dwell_tags_check
    CHECK (recommendation_dwell_tags <@ ARRAY['one_set','stay_longer','no_rush']::text[]),
  ADD CONSTRAINT products_allowed_channels_check
    CHECK (allowed_channels <@ ARRAY['guest_qr','staff_assisted','cashier','reservation','integration']::text[] AND cardinality(allowed_channels) > 0),
  ADD CONSTRAINT products_availability_window_check
    CHECK ((available_from IS NULL AND available_until IS NULL)
      OR (available_from IS NOT NULL AND available_until IS NOT NULL AND available_from <> available_until)),
  ADD CONSTRAINT products_recommendation_upgrade_fk
    FOREIGN KEY (tenant_id, store_id, recommendation_upgrade_product_id)
    REFERENCES mbox.products(tenant_id, store_id, id);

UPDATE mbox.products product
SET guest_visible = NOT COALESCE((
      product.product_snapshot->'guestVisible' = 'false'::jsonb
      OR product.product_snapshot->'source'->'guestVisible' = 'false'::jsonb
    ), false),
    search_text = left(concat_ws(' ',
      product.code,
      product.name,
      product.product_snapshot->>'aliases',
      product.product_snapshot->>'pinyin',
      product.product_snapshot->>'specification',
      product.product_snapshot->'source'->>'aliases',
      product.product_snapshot->'source'->>'pinyin',
      product.product_snapshot->'source'->>'specification'
    ), 4000),
    recommendation_enabled = product.product_snapshot->'recommendation'->'enabled' = 'true'::jsonb,
    recommendation_min_guests = CASE
      WHEN product.product_snapshot->'recommendation'->>'minimumPartySize' ~ '^\d{1,3}$'
        AND (product.product_snapshot->'recommendation'->>'minimumPartySize')::integer BETWEEN 1 AND 200
      THEN (product.product_snapshot->'recommendation'->>'minimumPartySize')::smallint ELSE 1 END,
    recommendation_max_guests = CASE
      WHEN product.product_snapshot->'recommendation'->>'maximumPartySize' ~ '^\d{1,3}$'
        AND (product.product_snapshot->'recommendation'->>'maximumPartySize')::integer BETWEEN 1 AND 200
      THEN (product.product_snapshot->'recommendation'->>'maximumPartySize')::smallint ELSE 100 END,
    recommendation_priority = CASE
      WHEN product.product_snapshot->'recommendation'->>'priority' ~ '^\d{1,4}$'
        AND (product.product_snapshot->'recommendation'->>'priority')::integer BETWEEN 0 AND 1000
      THEN (product.product_snapshot->'recommendation'->>'priority')::smallint ELSE 100 END,
    recommendation_scene_tags = CASE
      WHEN jsonb_typeof(product.product_snapshot->'recommendation'->'sceneTags')='array'
      THEN ARRAY(SELECT value FROM jsonb_array_elements_text(product.product_snapshot->'recommendation'->'sceneTags') value
        WHERE value = ANY(ARRAY['date','brothers','besties','friends','business','celebration','unsure']::text[]))
      ELSE '{}'::text[] END,
    recommendation_intent_tags = CASE
      WHEN jsonb_typeof(product.product_snapshot->'recommendation'->'intentTags')='array'
      THEN ARRAY(SELECT value FROM jsonb_array_elements_text(product.product_snapshot->'recommendation'->'intentTags') value
        WHERE value = ANY(ARRAY['relaxed','energetic','ritual','unsure']::text[]))
      ELSE '{}'::text[] END,
    recommendation_taste_tags = CASE
      WHEN jsonb_typeof(product.product_snapshot->'recommendation'->'tasteTags')='array'
      THEN ARRAY(SELECT value FROM jsonb_array_elements_text(product.product_snapshot->'recommendation'->'tasteTags') value
        WHERE value = ANY(ARRAY['refreshing','layered','strong','any']::text[]))
      ELSE '{}'::text[] END,
    recommendation_dwell_tags = CASE
      WHEN jsonb_typeof(product.product_snapshot->'recommendation'->'dwellTags')='array'
      THEN ARRAY(SELECT value FROM jsonb_array_elements_text(product.product_snapshot->'recommendation'->'dwellTags') value
        WHERE value = ANY(ARRAY['one_set','stay_longer','no_rush']::text[]))
      ELSE '{}'::text[] END,
    recommendation_single_wave_eligible = CASE
      WHEN lower(product.product_snapshot->'recommendation'->>'singleWaveEligible')='false' THEN false
      ELSE true
    END,
    recommendation_expected_prep_minutes = CASE
      WHEN product.product_snapshot->'recommendation'->>'expectedPrepMinutes' ~ '^\d{1,3}$'
        AND (product.product_snapshot->'recommendation'->>'expectedPrepMinutes')::integer BETWEEN 0 AND 240
      THEN (product.product_snapshot->'recommendation'->>'expectedPrepMinutes')::smallint ELSE 8 END,
    recommendation_hold_minutes = CASE
      WHEN product.product_snapshot->'recommendation'->>'holdMinutes' ~ '^\d{1,3}$'
        AND (product.product_snapshot->'recommendation'->>'holdMinutes')::integer BETWEEN 0 AND 240
      THEN (product.product_snapshot->'recommendation'->>'holdMinutes')::smallint ELSE 10 END,
    menu_sort_order = CASE
      WHEN COALESCE(product.product_snapshot->>'sortOrder', product.product_snapshot->'source'->>'sortOrder') ~ '^\d{1,6}$'
        AND COALESCE(product.product_snapshot->>'sortOrder', product.product_snapshot->'source'->>'sortOrder')::integer BETWEEN 0 AND 100000
      THEN COALESCE(product.product_snapshot->>'sortOrder', product.product_snapshot->'source'->>'sortOrder')::integer ELSE 999 END,
    available_from = CASE
      WHEN COALESCE(product.product_snapshot->>'availableFrom', product.product_snapshot->'source'->>'availableFrom') ~ '^([01]\d|2[0-3]):[0-5]\d$'
        AND COALESCE(product.product_snapshot->>'availableUntil', product.product_snapshot->'source'->>'availableUntil') ~ '^([01]\d|2[0-3]):[0-5]\d$'
        AND COALESCE(product.product_snapshot->>'availableFrom', product.product_snapshot->'source'->>'availableFrom')
          <> COALESCE(product.product_snapshot->>'availableUntil', product.product_snapshot->'source'->>'availableUntil')
      THEN COALESCE(product.product_snapshot->>'availableFrom', product.product_snapshot->'source'->>'availableFrom')::time ELSE NULL END,
    available_until = CASE
      WHEN COALESCE(product.product_snapshot->>'availableFrom', product.product_snapshot->'source'->>'availableFrom') ~ '^([01]\d|2[0-3]):[0-5]\d$'
        AND COALESCE(product.product_snapshot->>'availableUntil', product.product_snapshot->'source'->>'availableUntil') ~ '^([01]\d|2[0-3]):[0-5]\d$'
        AND COALESCE(product.product_snapshot->>'availableFrom', product.product_snapshot->'source'->>'availableFrom')
          <> COALESCE(product.product_snapshot->>'availableUntil', product.product_snapshot->'source'->>'availableUntil')
      THEN COALESCE(product.product_snapshot->>'availableUntil', product.product_snapshot->'source'->>'availableUntil')::time ELSE NULL END,
    allowed_channels = CASE
      WHEN jsonb_typeof(COALESCE(product.product_snapshot->'allowedChannels', product.product_snapshot->'source'->'allowedChannels'))='array'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(product.product_snapshot->'allowedChannels', product.product_snapshot->'source'->'allowedChannels')) value
          WHERE value = ANY(ARRAY['guest_qr','staff_assisted','cashier','reservation','integration']::text[])
        )
      THEN ARRAY(SELECT value FROM jsonb_array_elements_text(COALESCE(product.product_snapshot->'allowedChannels', product.product_snapshot->'source'->'allowedChannels')) value
        WHERE value = ANY(ARRAY['guest_qr','staff_assisted','cashier','reservation','integration']::text[]))
      ELSE ARRAY['guest_qr','staff_assisted','cashier','reservation','integration']::text[] END,
    max_order_quantity = CASE
      WHEN COALESCE(product.product_snapshot->>'maxOrderQuantity', product.product_snapshot->'source'->>'maxOrderQuantity') ~ '^\d{1,4}$'
        AND COALESCE(product.product_snapshot->>'maxOrderQuantity', product.product_snapshot->'source'->>'maxOrderQuantity')::integer BETWEEN 1 AND 9999
      THEN COALESCE(product.product_snapshot->>'maxOrderQuantity', product.product_snapshot->'source'->>'maxOrderQuantity')::smallint ELSE 50 END,
    kds_priority = CASE
      WHEN COALESCE(product.product_snapshot->>'kdsPriority', product.product_snapshot->'source'->>'kdsPriority') ~ '^\d{1,4}$'
        AND COALESCE(product.product_snapshot->>'kdsPriority', product.product_snapshot->'source'->>'kdsPriority')::integer BETWEEN 0 AND 1000
      THEN COALESCE(product.product_snapshot->>'kdsPriority', product.product_snapshot->'source'->>'kdsPriority')::smallint ELSE 100 END,
    fulfillment_sla_seconds = CASE
      WHEN COALESCE(product.product_snapshot->>'fulfillmentSlaSeconds', product.product_snapshot->'source'->>'fulfillmentSlaSeconds') ~ '^\d{2,5}$'
        AND COALESCE(product.product_snapshot->>'fulfillmentSlaSeconds', product.product_snapshot->'source'->>'fulfillmentSlaSeconds')::integer BETWEEN 30 AND 14400
      THEN COALESCE(product.product_snapshot->>'fulfillmentSlaSeconds', product.product_snapshot->'source'->>'fulfillmentSlaSeconds')::integer ELSE NULL END,
    cost_amount_minor = CASE
      WHEN product.product_snapshot->>'costAmount' ~ '^\d{1,15}$'
        AND (product.product_snapshot->>'costAmount')::numeric <= 9007199254740991
      THEN (product.product_snapshot->>'costAmount')::bigint ELSE NULL END;

UPDATE mbox.products
SET recommendation_max_guests = recommendation_min_guests
WHERE recommendation_max_guests < recommendation_min_guests;

UPDATE mbox.products product
SET recommendation_upgrade_product_id=target.id
FROM mbox.products target
WHERE target.tenant_id=product.tenant_id AND target.store_id=product.store_id
  AND target.id::text=product.product_snapshot->'recommendation'->>'upgradeProductId'
  AND target.id<>product.id;

CREATE OR REPLACE FUNCTION mbox.sync_product_operational_rollback_compatibility()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source jsonb := CASE WHEN jsonb_typeof(NEW.product_snapshot->'source')='object'
    THEN NEW.product_snapshot->'source' ELSE '{}'::jsonb END;
  recommendation jsonb := CASE WHEN jsonb_typeof(NEW.product_snapshot->'recommendation')='object'
    THEN NEW.product_snapshot->'recommendation' ELSE '{}'::jsonb END;
  raw text;
  start_value text;
  end_value text;
BEGIN
  IF NEW.product_snapshot ? 'guestVisible' OR source ? 'guestVisible' THEN
    NEW.guest_visible := NOT COALESCE((
      NEW.product_snapshot->'guestVisible'='false'::jsonb OR source->'guestVisible'='false'::jsonb
    ), false);
  END IF;
  IF NEW.product_snapshot ? 'searchText' OR NEW.search_text='' THEN
    NEW.search_text := left(COALESCE(NULLIF(btrim(NEW.product_snapshot->>'searchText'), ''), concat_ws(' ',
      NEW.code, NEW.name, NEW.product_snapshot->>'aliases', NEW.product_snapshot->>'pinyin',
      NEW.product_snapshot->>'specification', source->>'aliases', source->>'pinyin', source->>'specification'
    )), 4000);
  END IF;
  NEW.recommendation_enabled := COALESCE(recommendation->'enabled'='true'::jsonb, false);
  raw := recommendation->>'minimumPartySize';
  NEW.recommendation_min_guests := CASE WHEN raw ~ '^\d{1,3}$' AND raw::integer BETWEEN 1 AND 200
    THEN raw::smallint ELSE 1 END;
  raw := recommendation->>'maximumPartySize';
  NEW.recommendation_max_guests := CASE WHEN raw ~ '^\d{1,3}$' AND raw::integer BETWEEN 1 AND 200
    THEN GREATEST(raw::smallint, NEW.recommendation_min_guests) ELSE 100 END;
  raw := recommendation->>'priority';
  NEW.recommendation_priority := CASE WHEN raw ~ '^\d{1,4}$' AND raw::integer BETWEEN 0 AND 1000
    THEN raw::smallint ELSE 100 END;
  NEW.recommendation_scene_tags := ARRAY(
    SELECT value FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(recommendation->'sceneTags')='array'
      THEN recommendation->'sceneTags' ELSE '[]'::jsonb END) value
    WHERE value=ANY(ARRAY['date','brothers','besties','friends','business','celebration','unsure']::text[])
  );
  NEW.recommendation_intent_tags := ARRAY(
    SELECT value FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(recommendation->'intentTags')='array'
      THEN recommendation->'intentTags' ELSE '[]'::jsonb END) value
    WHERE value=ANY(ARRAY['relaxed','energetic','ritual','unsure']::text[])
  );
  NEW.recommendation_taste_tags := ARRAY(
    SELECT value FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(recommendation->'tasteTags')='array'
      THEN recommendation->'tasteTags' ELSE '[]'::jsonb END) value
    WHERE value=ANY(ARRAY['refreshing','layered','strong','any']::text[])
  );
  NEW.recommendation_dwell_tags := ARRAY(
    SELECT value FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(recommendation->'dwellTags')='array'
      THEN recommendation->'dwellTags' ELSE '[]'::jsonb END) value
    WHERE value=ANY(ARRAY['one_set','stay_longer','no_rush']::text[])
  );
  NEW.recommendation_single_wave_eligible := lower(recommendation->>'singleWaveEligible') IS DISTINCT FROM 'false';
  raw := recommendation->>'expectedPrepMinutes';
  NEW.recommendation_expected_prep_minutes := CASE WHEN raw ~ '^\d{1,3}$' AND raw::integer BETWEEN 0 AND 240
    THEN raw::smallint ELSE 8 END;
  raw := recommendation->>'holdMinutes';
  NEW.recommendation_hold_minutes := CASE WHEN raw ~ '^\d{1,3}$' AND raw::integer BETWEEN 0 AND 240
    THEN raw::smallint ELSE 10 END;
  raw := recommendation->>'upgradeProductId';
  NEW.recommendation_upgrade_product_id := CASE
    WHEN raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND raw::uuid<>NEW.id THEN raw::uuid ELSE NULL END;
  raw := COALESCE(NEW.product_snapshot->>'sortOrder', source->>'sortOrder');
  NEW.menu_sort_order := CASE WHEN raw ~ '^\d{1,6}$' AND raw::integer BETWEEN 0 AND 100000
    THEN raw::integer ELSE 999 END;
  start_value := COALESCE(NEW.product_snapshot->>'availableFrom', source->>'availableFrom');
  end_value := COALESCE(NEW.product_snapshot->>'availableUntil', source->>'availableUntil');
  IF start_value ~ '^([01]\d|2[0-3]):[0-5]\d$'
    AND end_value ~ '^([01]\d|2[0-3]):[0-5]\d$' AND start_value<>end_value THEN
    NEW.available_from := start_value::time;
    NEW.available_until := end_value::time;
  ELSE
    NEW.available_from := NULL;
    NEW.available_until := NULL;
  END IF;
  NEW.allowed_channels := ARRAY(
    SELECT value FROM jsonb_array_elements_text(CASE
      WHEN jsonb_typeof(COALESCE(NEW.product_snapshot->'allowedChannels', source->'allowedChannels'))='array'
      THEN COALESCE(NEW.product_snapshot->'allowedChannels', source->'allowedChannels') ELSE '[]'::jsonb END) value
    WHERE value=ANY(ARRAY['guest_qr','staff_assisted','cashier','reservation','integration']::text[])
  );
  IF cardinality(NEW.allowed_channels)=0 THEN
    NEW.allowed_channels := ARRAY['guest_qr','staff_assisted','cashier','reservation','integration']::text[];
  END IF;
  raw := COALESCE(NEW.product_snapshot->>'maxOrderQuantity', source->>'maxOrderQuantity');
  NEW.max_order_quantity := CASE WHEN raw ~ '^\d{1,4}$' AND raw::integer BETWEEN 1 AND 9999
    THEN raw::smallint ELSE 50 END;
  raw := COALESCE(NEW.product_snapshot->>'kdsPriority', source->>'kdsPriority');
  NEW.kds_priority := CASE WHEN raw ~ '^\d{1,4}$' AND raw::integer BETWEEN 0 AND 1000
    THEN raw::smallint ELSE 100 END;
  raw := COALESCE(NEW.product_snapshot->>'fulfillmentSlaSeconds', source->>'fulfillmentSlaSeconds');
  NEW.fulfillment_sla_seconds := CASE WHEN raw ~ '^\d{2,5}$' AND raw::integer BETWEEN 30 AND 14400
    THEN raw::integer ELSE NULL END;
  raw := NEW.product_snapshot->>'costAmount';
  NEW.cost_amount_minor := CASE WHEN raw ~ '^\d{1,15}$' AND raw::numeric<=9007199254740991
    THEN raw::bigint ELSE NULL END;
  RETURN NEW;
END $$;

CREATE TRIGGER products_operational_rollback_compatibility
  BEFORE INSERT OR UPDATE OF product_snapshot ON mbox.products
  FOR EACH ROW EXECUTE FUNCTION mbox.sync_product_operational_rollback_compatibility();

CREATE INDEX products_search_text_trgm_idx ON mbox.products USING gin (lower(search_text) gin_trgm_ops);
CREATE INDEX products_guest_recommendation_idx ON mbox.products (
  tenant_id, store_id, guest_visible, recommendation_enabled,
  recommendation_priority DESC, recommendation_min_guests, recommendation_max_guests
) WHERE status='active';
CREATE INDEX products_guest_menu_order_idx ON mbox.products (
  tenant_id, store_id, guest_visible, menu_sort_order, category_code, name, id
) WHERE status='active';

COMMENT ON COLUMN mbox.products.product_snapshot IS
  'Flexible display snapshot plus rollback compatibility copies. Runtime eligibility, timing, sorting, money and recommendation decisions must use typed columns.';
COMMENT ON TRIGGER products_operational_rollback_compatibility ON mbox.products IS
  'Temporary rollback-window adapter for the previous release writer. Current runtime reads typed columns only; drop this adapter with legacy JSON copies after rollback expiry.';

UPDATE mbox.normalized_schema_metadata
SET schema_version = '044', updated_at = clock_timestamp()
WHERE singleton = true AND schema_flavor = 'normalized-core-v1';

COMMIT;
