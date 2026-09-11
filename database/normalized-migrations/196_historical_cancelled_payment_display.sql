BEGIN;
-- A narrow compatibility exception for the five verified historical records.
-- No general closed-table write permission and no payment fact is changed.
DO $migration$
DECLARE definition text; needle text; replacement text;
BEGIN
 needle := $needle$          WHEN 'pending' THEN new_row->>'payment_status'='paid'$needle$;
 replacement := $replacement$          WHEN 'pending' THEN new_row->>'payment_status'='paid' OR (
            new_row->>'status'='cancelled' AND new_row->>'payment_status'='unpaid'
            AND (new_row - 'payment_status' - 'updated_at')=(old_row - 'payment_status' - 'updated_at')
            AND EXISTS(SELECT 1 FROM (VALUES
              ('055a604d-7252-409c-8149-767c545e02a7'::uuid,'2c997dc6-51f7-48ba-bfb1-121df3f537a2'::uuid,2000),
              ('36d43286-9ff2-4be4-bfef-1c85afe63b50'::uuid,'d1e0e17c-b51d-4ba3-ba83-ba4580ae9872'::uuid,35600),
              ('b1fb1e9b-4403-42dc-9d94-2a6348a8d7c2'::uuid,'1693b6c5-1df0-472b-ac48-8403a86d2734'::uuid,35600),
              ('e29ec9b7-ce4d-45a1-8d65-a2204f2a57a9'::uuid,'06c1f2c7-531b-492e-b03e-333449ea378e'::uuid,2000),
              ('eb7009d3-4878-4f15-beb7-7e9616218da5'::uuid,'c754853a-209b-4abd-9c78-13d40b10a0e9'::uuid,12800)
            ) expected(payment_id,order_id,amount_minor)
            JOIN mbox.payments p ON p.id=expected.payment_id AND p.order_id=expected.order_id AND p.amount_minor=expected.amount_minor
            JOIN mbox.payment_reconciliation_states r ON r.tenant_id=p.tenant_id AND r.store_id=p.store_id AND r.payment_id=p.id
            WHERE p.tenant_id=(new_row->>'tenant_id')::uuid AND p.store_id=(new_row->>'store_id')::uuid
              AND p.order_id=(new_row->>'id')::uuid AND p.status='pending' AND p.retry_released_at IS NULL
              AND r.phase='stopped' AND r.stop_reason='finance_review_required')
            AND NOT EXISTS(SELECT 1 FROM mbox.order_payment_facts p WHERE p.tenant_id=(new_row->>'tenant_id')::uuid AND p.store_id=(new_row->>'store_id')::uuid
              AND p.order_id=(new_row->>'id')::uuid AND p.status IN ('succeeded','partially_refunded','refunded'))
          )$replacement$;
 definition:=pg_get_functiondef('mbox.lock_table_session_for_closure_fact_write()'::regprocedure);
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'missing expected pending-payment closure guard'; END IF;
 EXECUTE replace(definition,needle,replacement);
END $migration$;
COMMIT;
