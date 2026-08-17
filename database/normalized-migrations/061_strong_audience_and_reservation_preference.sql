BEGIN;

ALTER TABLE mbox.community_activities
  ADD COLUMN audience_member_levels text[] NOT NULL DEFAULT '{}',
  ADD COLUMN audience_lifecycle_stages text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT community_activities_audience_member_levels_check
    CHECK (audience_member_levels <@ ARRAY['member','silver','gold','black']::text[]),
  ADD CONSTRAINT community_activities_audience_lifecycle_stages_check
    CHECK (audience_lifecycle_stages <@ ARRAY['new','active','high_value','at_risk','dormant']::text[]);

UPDATE mbox.community_activities activity
SET audience_member_levels = COALESCE((
      SELECT array_agg(DISTINCT value ORDER BY value)
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(activity.audience_rule->'memberLevels')='array'
          THEN activity.audience_rule->'memberLevels' ELSE '[]'::jsonb END
      ) AS value
      WHERE value = ANY(ARRAY['member','silver','gold','black']::text[])
    ), '{}'),
    audience_lifecycle_stages = COALESCE((
      SELECT array_agg(DISTINCT value ORDER BY value)
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(activity.audience_rule->'lifecycleStages')='array'
          THEN activity.audience_rule->'lifecycleStages' ELSE '[]'::jsonb END
      ) AS value
      WHERE value = ANY(ARRAY['new','active','high_value','at_risk','dormant']::text[])
    ), '{}');

ALTER TABLE mbox.community_activities
  ADD CONSTRAINT community_activities_typed_audience_check CHECK (
    (visibility IN ('public','member')
      AND cardinality(audience_member_levels)=0
      AND cardinality(audience_lifecycle_stages)=0)
    OR (visibility='segment'
      AND cardinality(audience_member_levels)+cardinality(audience_lifecycle_stages)>0)
  );

CREATE INDEX community_activities_typed_audience_idx
  ON mbox.community_activities
    USING gin (audience_member_levels, audience_lifecycle_stages);

ALTER TABLE mbox.member_content_cards
  ADD COLUMN audience_visibility text NOT NULL DEFAULT 'public'
    CHECK (audience_visibility IN ('public','member','segment')),
  ADD COLUMN audience_member_levels text[] NOT NULL DEFAULT '{}',
  ADD COLUMN audience_lifecycle_stages text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT member_content_cards_audience_member_levels_check
    CHECK (audience_member_levels <@ ARRAY['member','silver','gold','black']::text[]),
  ADD CONSTRAINT member_content_cards_audience_lifecycle_stages_check
    CHECK (audience_lifecycle_stages <@ ARRAY['new','active','high_value','at_risk','dormant']::text[]);

UPDATE mbox.member_content_cards card
SET audience_member_levels = COALESCE((
      SELECT array_agg(DISTINCT value ORDER BY value)
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(card.audience_rule->'memberLevels')='array'
          THEN card.audience_rule->'memberLevels' ELSE '[]'::jsonb END
      ) AS value
      WHERE value = ANY(ARRAY['member','silver','gold','black']::text[])
    ), '{}'),
    audience_lifecycle_stages = COALESCE((
      SELECT array_agg(DISTINCT value ORDER BY value)
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(card.audience_rule->'lifecycleStages')='array'
          THEN card.audience_rule->'lifecycleStages' ELSE '[]'::jsonb END
      ) AS value
      WHERE value = ANY(ARRAY['new','active','high_value','at_risk','dormant']::text[])
    ), '{}');

UPDATE mbox.member_content_cards
SET audience_visibility = CASE
  WHEN cardinality(audience_member_levels)+cardinality(audience_lifecycle_stages)>0
    THEN 'segment'
  ELSE 'public'
END;

ALTER TABLE mbox.member_content_cards
  ADD CONSTRAINT member_content_cards_typed_audience_check CHECK (
    (audience_visibility IN ('public','member')
      AND cardinality(audience_member_levels)=0
      AND cardinality(audience_lifecycle_stages)=0)
    OR (audience_visibility='segment'
      AND cardinality(audience_member_levels)+cardinality(audience_lifecycle_stages)>0)
  );

CREATE INDEX member_content_cards_typed_audience_idx
  ON mbox.member_content_cards
    USING gin (audience_member_levels, audience_lifecycle_stages);

ALTER TABLE mbox.reservations
  ADD COLUMN seat_preference text NOT NULL DEFAULT 'no_preference'
    CHECK (seat_preference IN (
      'no_preference','stage_atmosphere','quiet_chat','comfortable_booth','outdoor_view'
    ));

UPDATE mbox.reservations
SET seat_preference = CASE reservation_snapshot->>'seatPreference'
  WHEN 'stage_atmosphere' THEN 'stage_atmosphere'
  WHEN 'quiet_chat' THEN 'quiet_chat'
  WHEN 'comfortable_booth' THEN 'comfortable_booth'
  WHEN 'outdoor_view' THEN 'outdoor_view'
  ELSE 'no_preference'
END;

CREATE INDEX reservations_seat_preference_idx
  ON mbox.reservations (tenant_id, store_id, seat_preference, arrival_at, id);

COMMENT ON COLUMN mbox.community_activities.audience_member_levels IS
  'Strong activity eligibility levels; audience_rule remains historical display evidence only.';
COMMENT ON COLUMN mbox.member_content_cards.audience_visibility IS
  'Strong public/member/segment visibility used by the customer portal.';
COMMENT ON COLUMN mbox.reservations.seat_preference IS
  'Strong operational seat preference; reservation_snapshot is never consulted for placement preference.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='061', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
