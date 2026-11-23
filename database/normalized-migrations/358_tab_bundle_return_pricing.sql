BEGIN;
-- A late points tender is recorded beside the immutable parent order item.
-- Apply that tender to both the original cash share and the retained component value.
DO $$ DECLARE original text; patched text; marker text:='root_effective:=root_item.total_amount_minor+';
BEGIN
 original:=pg_get_functiondef('mbox.quote_after_sales_price(uuid)'::regprocedure);
 IF position(marker IN original)=0 OR position('retained_amount-root_item.discount_amount_minor' IN original)=0
   THEN RAISE EXCEPTION 'missing original bundle refund pricing'; END IF;
 patched:=replace(original,marker,'root_effective:=root_item.total_amount_minor-mbox.tab_item_discount(target.tenant_id,target.store_id,root_item.id)+');
 EXECUTE replace(patched,'retained_amount-root_item.discount_amount_minor',
   'retained_amount-root_item.discount_amount_minor-mbox.tab_item_discount(target.tenant_id,target.store_id,root_item.id)');
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='358',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
