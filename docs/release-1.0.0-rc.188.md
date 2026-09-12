# M-BOX 1.0.0-rc.188

Recover already verified payment success without requiring a second successful channel query. The existing scoped observation authority validates and consumes the original evidence, and the existing transaction atomically updates payment, original orders, financial ledger and downstream events. Recovery uses a stable observation key and the provider receipt business date. No successful payment or refund is fabricated.

Separate verified-success application failures from channel failures; retain the known status and retry local application after one minute within the existing financial tracking window. Log safe error codes for both verified callbacks and background application failures, without provider secrets or raw SQL.

Includes mainline fixes for Postar-safe public payment numbers, payable/recently paid cashier visibility and recent provider failure retry. Production incident evidence proves confirmed results were received but not applied; the original triggering exception was discarded by the old handlers and remains unproven. This release fixes the recovery and diagnostic gaps, not a claimed reconstruction of that missing exception.

No database migration or Mini Program source change. Physical device acceptance and original commercial release blockers remain separate. Validation and deployment evidence: payment-sync-incident-20260912.md.
