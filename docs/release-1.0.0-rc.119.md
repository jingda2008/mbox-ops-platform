# M-BOX 1.0.0-rc.119

## Scope

This candidate supersedes `1.0.0-rc.118`. It deploys only the normalized staff
web, service and database bundle through migration `099`. It does not build,
upload or overwrite the WeChat mini-program package.

## Fixed store login code

- The configured store login value remains stable across business dates.
- After a successful verification, the server creates the current business
  date's hashed credential record when the previous daily record is no longer
  current. Plaintext is not persisted in the database.
- An incorrect value cannot create or renew a credential record.
- Every automatic renewal records an audit fact and a matching outbox event.
- Explicit credential replacement revokes prior reusable credential records,
  so a replaced value cannot become valid again on a later business date.

## Security boundary

The reusable value changes only the shared store gate. Device leases still
expire and remain device-bound; employees still authenticate with their own
four-digit PIN; staff sessions still expire after six hours and remain
revocable. Rate limiting and tenant/store isolation remain active.

## Production route

The public origin is `https://mbox.shmbox.com`. Deployment reaches the private
application host through the approved payment-server jump path. Migration
`099` requires the existing maintenance-window database contract and its
backup, restore and evidence gates.
