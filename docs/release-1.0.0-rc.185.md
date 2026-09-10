# M-BOX 1.0.0-rc.185

September 11 operations consolidation. Includes normalized migrations 187–188: independent order history permissions, immutable delivery batches and partial physical stock-return records. Includes all current local source changes: order center/history scope, manual single-order bills, payment-code scanner fallback, confirmed delivery feedback, product taste profiles, gift presentation, historical package price references, kitchen routing and print-bridge unknown-result protection.

Delivery slips now require explicit batch-ready confirmation in the fulfillment page. Batch creation is not delivery completion. Whole-item delivery remains available independently of printer success; different table sessions and workstations cannot be combined. Legacy generated delivery sources are retained without automatic duplicate batches.

Refunds do not automatically restore inventory. Authorized staff must confirm eligible actual returns after successful refund, subject to original quantity, original consumption cost and concurrency safeguards. No new provider refund is sent by stock return.

Local database regression: 1865 passed, 1 skipped. Physical printer acceptance and real employee/return acceptance remain open. Whole-table/day report printing, financial summary and monthly schedule requirements are not declared complete. Existing commercial acceptance gaps remain in the generated registers.

Deployment uses the main-reachable immutable image, verified backup, lineage checks and zero-traffic candidate before cutover. Windows print-bridge 1.0.2 needs separate terminal installation. WeChat/Alipay source changes are included in GitHub but are not distributed by backend deployment; no native upload is claimed here.
