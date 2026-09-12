# M-BOX 1.0.0-rc.189

Close payment evidence and finance-review operational gaps. Structured payment failures are retained by the selective SLS filter with bounded safe identifiers, stages and code locations. Preserve Docker timestamps and support a forced-command SSH relay to the existing RAM-role SLS sender; cloud collection must be installed and verified separately from the backend image.

Finance review prioritizes channel-confirmed receipts not yet applied locally, shows explicit reasons and a visible count, refreshes once per minute while visible, and retains one row per payment. Existing case ownership and audit are reused; unresolved confirmed receipts cannot be closed. Migration197 supplies the missing finance-management definition and grants only existing finance-view CASHIER/MANAGER/OWNER/ADMIN roles. No collection or refund authority is added.

No Mini Program change. Historical root exception remains unproven; current observability does not reconstruct missing old logs. Staff acceptance of a subsequent real transaction remains separate from automated validation. See payment-evidence-closure-20260912.md.

Additional root-cause evidence: the legacy payment host still serves pay.shmbox.com and the old IP using518e941 against the same database, with active workers. Its payable lock rejects order_batch with PaymentNotFoundError/404, reproduced in the actual old container; callback404 timestamps match both saved success observations. The convergence script verifies current-primary TLS/SHA and both forwarded ingress routes before stopping the old runtime and removing watchdog/reboot resurrection. Execution and readback remain required.
