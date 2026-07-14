# PostgreSQL production persistence baseline

This directory is the production transactional database baseline for the M-Box operations platform. It follows `AI运营系统/11-总体技术架构.md`, `AI运营系统/12-核心数据模型与API契约.md`, and the current TypeScript contracts.

## Requirements

- PostgreSQL 15 or newer. `UNIQUE NULLS NOT DISTINCT` is used for responsibility scopes.
- A migration role that owns the `mbox` schema.
- A separate runtime role that is not a superuser, does not have `BYPASSRLS`, and does not own the tables.
- Application timestamps are sent and stored as `timestamptz`; `business_date` is calculated with the store timezone and cutoff.

`gen_random_uuid()` is provided by supported PostgreSQL versions. No optional extension is required.

## Migration order

Apply every file once, in lexical order, with checksum recording and stop-on-error enabled:

```sh
DATABASE_URL='postgresql://...' npm run db:migrate
DATABASE_URL='postgresql://...' npm run db:verify
```

The files are transactional but are not designed to be reapplied. A deployment migration runner must record each filename and checksum. Production rollback uses a tested forward migration; destructive down migrations are intentionally not supplied for financial and audit data.

## Model coverage

- Organization: tenants, stores, areas, venue tables, employees, roles, shifts, shift assignments, and store/area/table responsibilities.
- Operations: table sessions, immutable configuration versions, proactive service intents, service tasks, and append-only task events.
- Membership: customer profiles, configurable benefit templates and role policies, grant approvals, campaigns, member entitlements, atomic lock/redemption/release records, an append-only redemption event ledger, notification Outbox retry/DLQ state, and immutable delivery attempts.
- Entertainment: singers, per-singer repertoire and price versions, performance sessions, appearances, table-bound paid song requests, refund references, and append-only request events.
- Reservations: configurable sources/areas/occasions, reservation lifecycle, table seating, deposit payment/refund evidence, idempotency, and append-only events.
- Inventory: products and units, stock locations/batches/movements, count approval and adjustment, low-stock policy, customer bottle storage, transfer/use/void, and append-only events.
- Identity: encrypted WeChat identity links, nonce replay protection, bounded sessions, and auditable login evidence.
- Commerce: products, non-overlapping price versions, orders, item price snapshots, and fulfillment status.
- Finance: table ledgers, append-only ledger entries, approvals, payment intents, payments, provider callbacks, refunds, and item-level refund allocations.
- Reliability: operation-scoped idempotency records and a Transactional Outbox.
- Runtime integrity: optimistic aggregate CAS, document checksum, and an append-only database journal of every aggregate revision/hash transition.
- Accountability: append-only audit events carrying actor, request, trace, business date, and before/after evidence.

All monetary values use `bigint` columns ending in `_amount_minor`. Values are integer minor currency units, for example CNY fen. Floating-point and PostgreSQL `money` values are not allowed. Currency is snapshotted with each financial record.

Database statuses are lower-case to match the current TypeScript contracts. External APIs that expose upper-case states must map them at the adapter boundary.

## Tenant isolation

Row Level Security is enabled and forced on every table. Each runtime transaction must set both IDs before any query:

```sql
BEGIN;
SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000001';
SET LOCAL app.store_id = '00000000-0000-0000-0000-000000000002';
-- Application statements.
COMMIT;
```

Missing or invalid context must fail closed: no store rows are visible or writable. With transaction-pooling proxies, set both values after every `BEGIN`; never use session-level settings that can leak to another request. Cross-store reporting should consume the event/analytics path or use a separately controlled reporting role, not weaken the runtime policy.

Example deployment grants, with role names chosen by the operator:

```sql
GRANT USAGE ON SCHEMA mbox TO mbox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mbox TO mbox_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA mbox TO mbox_app;
```

`DELETE` privilege does not make append-only tables mutable: triggers reject changes to task events, ledger entries, refund allocations, audit events, and Outbox identity/payload. Keep broad grants in infrastructure code so role changes are reviewed and tested; production may grant a narrower table-by-table matrix.

## Transaction and idempotency rules

A command transaction must atomically include:

1. The aggregate state change using `WHERE id = $id AND version = $expectedVersion`.
2. Its task event or financial ledger entry when applicable.
3. One Outbox event for each externally observable domain event.
4. An audit event for privileged, security-sensitive, configuration, and financial actions.
5. Completion of the matching `idempotency_records` row.

If the versioned update affects zero rows, return a conflict and do not append events. Version triggers advance the row by exactly one and reject larger jumps. Entity-specific idempotency keys, provider transaction IDs, provider event IDs, ledger references, and Outbox aggregate versions provide additional duplicate protection.

Ledger entries are the financial journal. An insert trigger updates the table-ledger debit/credit aggregate in the same transaction. Corrections use compensating entries, never updates or deletes. Order header totals and order items must be validated by the domain service before submission; reconciliation jobs should independently compare item totals, ledger entries, payments, refunds, and provider statements.

Benefit redemption is also transaction-bound. Creating a `benefit_redemptions` lock row atomically reserves `member_benefits.remaining_quantity`; only `locked -> redeemed/released/expired` terminal transitions are accepted. Release restores quantity, redemption consumes it, and every transition writes an append-only `benefit_redemption_events` row. A referenced order is constrained to the same table session as the redemption. Callers must retry with the original lock or resolution idempotency key and must never repair balances with direct updates.

`customer_notifications` is the business Outbox and delivery aggregate. Workers claim due rows with a short lease, append one immutable `notification_delivery_attempts` row per completed call, and update retry/DLQ fields in the same transaction. An expired lease is an unknown outcome: query the provider when possible and preserve the same business idempotency identity. Dead-letter replay creates new attempt evidence; it must not recreate the member benefit or mutate prior attempts.

Commercial V1 executes against `runtime_states` as the authoritative store aggregate. `runtime_state_versions` is written by a database trigger and makes every revision/hash transition append-only. The normalized domain tables remain the target projection contract; they must not be described as live authoritative records until transactional projectors and parity reconciliation are enabled.

Payment success is accepted only after a verified provider callback or a server-side provider query. Frontend redirects never update a payment to `succeeded`. Refund triggers reserve the original payment amount across active refunds and prevent item quantities from exceeding the purchased quantity.

## Configuration boundary

`config_versions` stores complete, executable, store-resolved snapshots. Published content is immutable and may only be retired. Tasks and orders reference the exact snapshot used at execution time.

Platform and tenant-level authoring, inheritance editing, approval workflow UI, and merge diagnostics are outside this baseline. A future configuration service may author those layers, but publication must materialize a complete store snapshot here rather than make runtime requests merge drafts.

## External and future adapters

The schema deliberately does not contain provider-specific business columns. Adapters map external identifiers into `external_source`, provider transaction/event IDs, metadata, and Outbox payloads.

Future forward migrations can add evidence attachments, POS import staging, payment reconciliation projections, partitioning/archival, and analytics projections. Object files, visual clips, credentials, raw payment secrets, and large provider payloads belong in encrypted object/secret storage with references in PostgreSQL.

RLS is defense in depth, not authentication or authorization. API authorization, capability checks, approval limits, trusted callback verification, encryption, backups, point-in-time recovery, monitoring, retention jobs, and restore drills remain required production controls.

## Local verification

The complete migration set can be executed and verified against an empty PostgreSQL 16 database:

```sh
DATABASE_URL='postgresql://...' npm run db:migrate
DATABASE_URL='postgresql://...' npm run db:verify
```

Use a fresh database for each migration test. A release gate should also run behavioral tests for RLS isolation, invalid state transitions, duplicate idempotency keys, append-only rejection, ledger aggregation, payment callback deduplication, over-refund rejection, concurrent benefit over-redemption, failed-lock release, cross-session order rejection, notification lease recovery, retry exhaustion, and DLQ replay.
