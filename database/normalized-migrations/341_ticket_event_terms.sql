BEGIN;
CREATE TABLE mbox.table_ticket_event_terms(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,activity_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 organizer text NOT NULL,seller text NOT NULL,approval_reference text NOT NULL,performers text NOT NULL,
 duration_minutes integer NOT NULL CHECK(duration_minutes>0),program_note text NOT NULL,service_contact text NOT NULL,
 refund_schedule text NOT NULL,requires_named_attendees boolean NOT NULL,
 approved_by uuid NOT NULL,approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,activity_id,version),UNIQUE(tenant_id,store_id,activity_id,id),
 FOREIGN KEY(tenant_id,store_id,activity_id) REFERENCES mbox.community_activities(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,approved_by) REFERENCES mbox.employees(tenant_id,store_id,id)
);
ALTER TABLE mbox.table_ticket_event_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.table_ticket_event_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON mbox.table_ticket_event_terms USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT ON mbox.table_ticket_event_terms TO mbox_runtime;
CREATE TRIGGER immutable_ticket_terms BEFORE UPDATE OR DELETE ON mbox.table_ticket_event_terms FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
ALTER TABLE mbox.table_ticket_offers ADD COLUMN event_terms_id uuid,
 ADD FOREIGN KEY(tenant_id,store_id,activity_id,event_terms_id) REFERENCES mbox.table_ticket_event_terms(tenant_id,store_id,activity_id,id);
UPDATE mbox.normalized_schema_metadata SET schema_version='341',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
