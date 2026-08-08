BEGIN;

ALTER TABLE mbox.guest_behavior_events
  DROP CONSTRAINT IF EXISTS guest_behavior_events_event_type_check;

ALTER TABLE mbox.guest_behavior_events
  ADD CONSTRAINT guest_behavior_events_event_type_check CHECK (event_type IN (
    'session_started', 'tab_viewed', 'mood_selected', 'service_requested',
    'service_feedback', 'category_viewed', 'recommendation_viewed',
    'quick_select_started', 'quick_select_exited', 'quick_select_answered',
    'quick_select_completed', 'recommendation_reranked', 'recommendation_result_updated',
    'shake_requested', 'shake_result_viewed', 'product_detail_viewed',
    'recommendation_accepted', 'upgrade_accepted', 'product_added',
    'product_removed', 'cart_cleared', 'cart_abandoned', 'cart_submitted',
    'order_created', 'checkout_started', 'payment_completed',
    'singer_profile_viewed', 'song_requested'
  ));

COMMIT;
