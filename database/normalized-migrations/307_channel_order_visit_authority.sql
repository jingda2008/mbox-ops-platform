BEGIN;
-- Attribution belongs to the continuous visit, regardless of who places or
-- pays for an order. Never reconstruct historical source from present tables.
CREATE FUNCTION mbox.lock_channel_order_table() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Take the final lock BEFORE the order's FK/other triggers acquire key-share
 -- locks. Upgrading two concurrent FK locks in an AFTER trigger deadlocks.
 IF TG_OP='INSERT' OR (OLD.status='draft' AND NEW.status NOT IN('draft','cancelled')) THEN
  PERFORM 1 FROM mbox.table_sessions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.table_session_id FOR UPDATE;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.lock_channel_order_table() FROM PUBLIC;
CREATE TRIGGER aaa_channel_order_table_lock BEFORE INSERT OR UPDATE OF status ON mbox.orders
 FOR EACH ROW EXECUTE FUNCTION mbox.lock_channel_order_table();
CREATE FUNCTION mbox.capture_channel_order_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IN('draft','cancelled') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.status<>'draft' THEN RETURN NEW; END IF;
 PERFORM v.id FROM mbox.channel_visit_tables t JOIN mbox.channel_visits v ON (v.tenant_id,v.store_id,v.id)=(t.tenant_id,t.store_id,t.visit_id)
 WHERE t.tenant_id=NEW.tenant_id AND t.store_id=NEW.store_id AND t.table_session_id=NEW.table_session_id AND t.detached_at IS NULL AND v.closed_at IS NULL FOR UPDATE OF v;
 INSERT INTO mbox.channel_order_attributions(tenant_id,store_id,order_id,visit_id,batch_id)
 SELECT NEW.tenant_id,NEW.store_id,NEW.id,v.id,v.source_batch_id
 FROM mbox.channel_visit_tables t JOIN mbox.channel_visits v
 ON (v.tenant_id,v.store_id,v.id)=(t.tenant_id,t.store_id,t.visit_id)
 WHERE t.tenant_id=NEW.tenant_id AND t.store_id=NEW.store_id
 AND t.table_session_id=NEW.table_session_id AND t.detached_at IS NULL
 AND v.closed_at IS NULL AND v.source_batch_id IS NOT NULL
 AND NEW.created_at>=v.opened_at
 ON CONFLICT(tenant_id,store_id,order_id) DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.capture_channel_order_source() FROM PUBLIC;
CREATE TRIGGER orders_capture_channel_source AFTER INSERT OR UPDATE OF status ON mbox.orders
 FOR EACH ROW EXECUTE FUNCTION mbox.capture_channel_order_source();

-- The existing whole-table transfer retains its table_session_id. Split or
-- merge events must carry the same visit; unrelated source groups cannot merge
-- automatically. The original movement and this linkage commit together.
CREATE FUNCTION mbox.move_channel_visit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_visit uuid;target_visit uuid;
BEGIN
 IF NEW.source_table_session_id=NEW.target_table_session_id THEN RETURN NEW; END IF;
 SELECT visit_id INTO source_visit FROM mbox.channel_visit_tables WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND table_session_id=NEW.source_table_session_id AND detached_at IS NULL;
 SELECT visit_id INTO target_visit FROM mbox.channel_visit_tables WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND table_session_id=NEW.target_table_session_id AND detached_at IS NULL;
 IF source_visit IS NULL AND target_visit IS NULL THEN RETURN NEW; END IF;
 IF source_visit IS NOT NULL AND target_visit IS NOT NULL AND source_visit<>target_visit THEN
  RAISE EXCEPTION '不同渠道客组不能直接合并，请分别结算或由主管核对' USING ERRCODE='23514';
 END IF;
 IF source_visit IS NOT NULL AND target_visit IS NULL THEN
  -- An already consuming table is a distinct group until a supervisor reviews
  -- it. Do not award its prior/remaining revenue to an arriving referral.
  IF EXISTS(SELECT 1 FROM mbox.orders WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND table_session_id=NEW.target_table_session_id AND status NOT IN('draft','cancelled')) THEN
   RAISE EXCEPTION '目标桌已有消费，请先核对客组来源' USING ERRCODE='23514';
  END IF;
  INSERT INTO mbox.channel_visit_tables(tenant_id,store_id,visit_id,table_session_id) VALUES(NEW.tenant_id,NEW.store_id,source_visit,NEW.target_table_session_id);
 ELSIF source_visit IS NULL AND target_visit IS NOT NULL THEN
  RAISE EXCEPTION '无渠道来源客组不能直接并入渠道客组，请先核对来源' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.move_channel_visit() FROM PUBLIC;
CREATE TRIGGER table_movement_channel_visit AFTER INSERT ON mbox.table_customer_movement_events
 FOR EACH ROW EXECUTE FUNCTION mbox.move_channel_visit();

-- A customer rescanning a different table does not prove the whole party has
-- moved. Require the existing staff movement flow instead of resetting L or
-- silently attributing another party's next orders to this referral.
CREATE FUNCTION mbox.guard_channel_guest_rescan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_visit uuid;target_visit uuid;
BEGIN
 SELECT t.visit_id INTO source_visit FROM mbox.table_session_customer_participations p
 JOIN mbox.channel_visit_tables t ON (t.tenant_id,t.store_id,t.table_session_id)=(p.tenant_id,p.store_id,p.table_session_id)
 JOIN mbox.channel_visits v ON (v.tenant_id,v.store_id,v.id)=(t.tenant_id,t.store_id,t.visit_id)
 WHERE p.tenant_id=NEW.tenant_id AND p.store_id=NEW.store_id AND p.id=NEW.source_participation_id AND t.detached_at IS NULL AND v.closed_at IS NULL;
 IF source_visit IS NULL THEN RETURN NEW; END IF;
 SELECT visit_id INTO target_visit FROM mbox.channel_visit_tables WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND table_session_id=NEW.target_table_session_id AND detached_at IS NULL;
 IF target_visit IS DISTINCT FROM source_visit THEN
  RAISE EXCEPTION 'channel_guest_rescan_requires_staff' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.guard_channel_guest_rescan() FROM PUBLIC;
CREATE TRIGGER guest_rescan_channel_visit BEFORE INSERT ON mbox.guest_table_rescan_events
 FOR EACH ROW EXECUTE FUNCTION mbox.guard_channel_guest_rescan();

CREATE FUNCTION mbox.close_channel_visit_table() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE visit uuid;
BEGIN
 IF NEW.status NOT IN('closed','cancelled') OR OLD.status=NEW.status THEN RETURN NEW; END IF;
 UPDATE mbox.channel_visit_tables SET detached_at=clock_timestamp()
 WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND table_session_id=NEW.id AND detached_at IS NULL RETURNING visit_id INTO visit;
 IF visit IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mbox.channel_visit_tables WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND visit_id=visit AND detached_at IS NULL) THEN
  UPDATE mbox.channel_visits SET closed_at=clock_timestamp(),version=version+1 WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=visit AND closed_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.close_channel_visit_table() FROM PUBLIC;
CREATE TRIGGER table_sessions_close_channel_visit AFTER UPDATE OF status ON mbox.table_sessions
 FOR EACH ROW EXECUTE FUNCTION mbox.close_channel_visit_table();
UPDATE mbox.normalized_schema_metadata SET schema_version='307',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
