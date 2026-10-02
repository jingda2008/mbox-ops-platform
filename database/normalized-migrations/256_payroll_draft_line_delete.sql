BEGIN;

-- Draft line replacement/removal is part of the existing web contract, but the
-- runtime role previously lacked DELETE. Limit it to draft runs and serialize
-- against approval/posting; finalized payroll and its cost evidence stay intact.
GRANT DELETE ON mbox.payroll_lines TO mbox_runtime;
CREATE POLICY payroll_draft_delete_only ON mbox.payroll_lines AS RESTRICTIVE FOR DELETE
USING (EXISTS (
  SELECT 1 FROM mbox.payroll_runs run
  WHERE run.tenant_id=payroll_lines.tenant_id AND run.store_id=payroll_lines.store_id
    AND run.id=payroll_lines.payroll_run_id AND run.status='draft'
));
CREATE FUNCTION mbox.guard_payroll_draft_line_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_status text;
BEGIN
  SELECT status INTO run_status FROM mbox.payroll_runs
    WHERE tenant_id=OLD.tenant_id AND store_id=OLD.store_id AND id=OLD.payroll_run_id FOR UPDATE;
  IF run_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'only draft payroll lines may be removed' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER guard_payroll_draft_line_delete BEFORE DELETE ON mbox.payroll_lines
FOR EACH ROW EXECUTE FUNCTION mbox.guard_payroll_draft_line_delete();

UPDATE mbox.normalized_schema_metadata SET schema_version='256',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
