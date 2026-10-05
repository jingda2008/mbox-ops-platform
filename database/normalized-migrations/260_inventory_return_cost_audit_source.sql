BEGIN;
-- Automated confirmed-refund returns have no acting employee. Attribute their
-- cost version to the immutable return movement instead of inventing an actor.
ALTER TABLE mbox.recipe_cost_versions
  ADD COLUMN source_inventory_movement_id uuid,
  ALTER COLUMN calculated_by_employee_id DROP NOT NULL,
  ADD CONSTRAINT recipe_cost_versions_return_source_fk
    FOREIGN KEY (tenant_id,store_id,source_inventory_movement_id)
    REFERENCES mbox.inventory_movements(tenant_id,store_id,id),
  ADD CONSTRAINT recipe_cost_versions_audit_source_ck
    CHECK (calculated_by_employee_id IS NOT NULL OR source_inventory_movement_id IS NOT NULL);
COMMIT;
