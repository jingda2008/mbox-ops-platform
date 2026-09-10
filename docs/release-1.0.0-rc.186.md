# M-BOX 1.0.0-rc.186

Urgent service tasks now produce reminders at intervals of at least 30 minutes instead of repeatedly reporting priority escalation. Real priority increases and backup assignment remain independently audited; unresolved complaints are not marked complete.

Expired order/activity recollection authorizations are terminalized by the scheduled worker with audit records. Consumption rechecks expiry. The single known historical expired authorization was already repaired separately; this release makes future cleanup automatic.

Normalized migration189 preserves closed-table write protection while permitting status-only terminal correction of fully refunded items with original manager cancellation evidence and no uncancelled production tasks. The explicit four-item repair script defaults to rollback preview; execute only after deployment and validate readback. Financial amounts, original refunds and inventory remain unchanged. The user confirmed the historical CNY20 refund was handled; it is excluded from this repair.

Local isolated PostgreSQL regression: 1869 passed, 1 skipped. Existing commercial acceptance gaps remain in the generated registers. Store configuration remains 2026.09.11-v22. Backend deployment uses the approved immutable-image pipeline with backup and candidate checks. Windows bridge upgrade source is included but installation is separate and deferred to maintenance; no Mini Program upload or physical-print acceptance is claimed.
