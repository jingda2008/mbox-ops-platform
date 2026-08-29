# M-BOX 1.0.0-rc.160

## Scope

This candidate contains PR #145 on top of the already deployed rc.159
baseline. It makes the persistent “今夜甄选” three-item exposure independent
from guided recommendation interactions. The ranking remains a server decision
and each item remains subject to the current table's sale, inventory, capacity
and payment guards.

For ordinary QR guest self-checkout only, an explicit customer exit from the
final native WeChat payment step abandons the uncollected attempt. The service
cancels the unproduced order, payment attempt, temporary reservation and
fulfillment plan with idempotency and an audit/outbox record. A later provider
capture is retained as a financial exception eligible for controlled refund,
but cannot revive fulfillment, inventory consumption, KDS work, loyalty or
recommendation attribution. Staff-assisted pending orders and activity payment
flows are deliberately excluded.

The staff table workspace now presents selected-table actions in a closeable
dialog, so navigating or closing the dialog never leaves an action panel stuck
over an unrelated surface. The recommendation administration copy also makes
clear that a policy version and customer rollout are two distinct operations.

## Acceptance boundary

The feature PR passed the exact-commit CI quality, isolated PostgreSQL
transaction/RLS and HTTP workflow, normalized browser and sustained-load
gates. Local verification also passed the complete project check, including the
native Mini Program static and customer-funnel regression suites. This proves
the code paths and isolated-data behaviour, not a real WeChat debit, payment
provider callback, POS/refund channel action, printer output or real-device
customer completion.

The deployment bundle deliberately excludes the native WeChat Mini Program.
Its source has been tested, but a separate source-identified DevTools upload
and real-device acceptance is required before any Mini Program code reaches
customers.

## Production route

Deploy only from immutable tag `v1.0.0-rc.160` after its tag CI publishes the
same commit, image digest, release manifest and evidence. The production
transaction performs configuration preflight, backup/readback, migration
compatibility validation, a zero-traffic candidate probe, formal route checks,
traffic cutover and OSS evidence sealing. Any failed gate keeps the preceding
immutable release active.
