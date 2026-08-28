BEGIN;

ALTER TABLE mbox.inventory_items
  ADD COLUMN package_volume_ml numeric(18,6)
    CHECK (package_volume_ml IS NULL OR package_volume_ml > 0);

COMMENT ON COLUMN mbox.inventory_items.package_volume_ml IS
  '净含量提示；不参与库存扣减计算。可按毫升管理的物料仍以base_unit=ml和配方用量为唯一扣减依据。';

COMMIT;
