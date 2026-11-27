BEGIN;
SET LOCAL lock_timeout='3s';
CREATE OR REPLACE FUNCTION mbox.session_dining_flags(t uuid,s uuid,sid uuid) RETURNS TABLE(minimum_enabled boolean,ticket_enabled boolean)
LANGUAGE sql STABLE STRICT AS $$
 SELECT coalesce(d.minimum_enabled,false),coalesce(d.ticket_enabled,false) FROM mbox.table_sessions ss
 LEFT JOIN mbox.dining_day_rules d USING(tenant_id,store_id,business_date)
 WHERE (ss.tenant_id,ss.store_id,ss.id)=(t,s,sid)
$$;
CREATE FUNCTION mbox.dining_ticket_owner(t uuid,s uuid,sid uuid) RETURNS uuid
LANGUAGE sql STABLE STRICT AS $$
 SELECT mbox.canonical_customer_id(t,s,r.customer_id) FROM mbox.table_tickets k
 JOIN mbox.community_activity_registrations r ON (r.tenant_id,r.store_id,r.id)=(k.tenant_id,k.store_id,k.registration_id)
 WHERE (k.tenant_id,k.store_id,k.id)=(t,s,mbox.session_dining_ticket(t,s,sid))
 AND (SELECT ticket_enabled FROM mbox.session_dining_flags(t,s,sid))
 AND mbox.valid_dining_buyer(t,s,sid,r.customer_id)
$$;
CREATE FUNCTION mbox.receipt_order_customer(t uuid,s uuid,oid uuid) RETURNS uuid
LANGUAGE sql STABLE STRICT AS $$
 SELECT customer_id FROM mbox.loyalty_order_awards
 WHERE (tenant_id,store_id,order_id)=(t,s,oid) AND awarded_points>0
$$;
UPDATE mbox.normalized_schema_metadata SET schema_version='377',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
