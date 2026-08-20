# M-BOX 1.0.0-rc.90

## Scope

This candidate advances the normalized store platform from the `rc.89`
baseline through migrations 090–096. It includes operational policy release,
membership configuration governance, personal-contact governance and
customer-location movement, together with the corresponding employee and
mini-program workflows.

## Employee session handoff

- The signed-in employee remains visible in the staff workspace and can open a
  dedicated account-switch dialog.
- Switching requires the next employee code and that employee's own four-digit
  PIN. A successful switch clears route-specific UI state and returns to the
  employee workspace without sharing the previous employee's authority.
- Logout uses a separate two-step confirmation and returns to the login entry.
  The verified store device lease is intentionally retained; employee identity
  and permissions are not.
- The mobile session control, workspace entry and refresh control have distinct
  accessible names and touch targets.

## Customer consent and operational continuity

- WeChat membership enrollment requires the customer to explicitly select the
  service and privacy agreement checkbox before requesting a phone number, on
  both the profile entry and the full terms page.
- Staff quick actions remain available after navigating between work modules.
- Operational exception views retain business-day context so unresolved work
  is not silently treated as a current-day success after midnight.

## Data and release safety

- Migrations 090–096 add strong approval, contact-governance and table-customer
  movement evidence without reusing mutable JSON as executable authority.
- Table transfers and participant split/merge preserve historical orders and
  payments, revoke stale guest authority and keep unsettled business objects
  fail-closed.
- The contract migration is deployed only through the maintenance release
  path: old writers are drained, the database is backed up and verified, and a
  failed candidate remains behind the maintenance response until paired
  recovery succeeds.

## Acceptance boundary

This release does not itself prove live acquiring, live refund, external
hardware, PITR or on-site multi-role acceptance. Those remain environment and
operator gates. Production deployment must use the immutable `rc.90` artifact
and the formal release script; application-only rollback across migration 096
is not supported.
