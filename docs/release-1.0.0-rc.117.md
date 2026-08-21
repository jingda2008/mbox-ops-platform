# M-BOX 1.0.0-rc.117

## Scope

This candidate carries the merged normalized staff, service and database scope
through migration `098`, including the staff brand-green visual update. It does
not build, upload or overwrite the WeChat mini-program package.

## Release correction

- The external evidence relay uploads the `SHA256SUMS` ledger as an independent
  object together with every file listed by that ledger.
- Activation now verifies the ledger object's exact OSS key, byte size and
  SHA-256 before verifying every listed evidence object.
- The final object-count check includes the verified ledger and remains exact;
  missing, modified or additional objects still block completion.

## Incident boundary

The rc.116 candidate passed private and public checks and the evidence host
successfully uploaded and read back all eight deployment evidence objects. The
application host then counted only the seven ledger entries while comparing
against all eight uploaded objects, treated the valid ledger as an extra object
and automatically restored healthy rc.104. The database stayed on schema
`098`; no WeChat mini-program package was changed.

## Production route

The public origin remains `https://mbox.shmbox.com`. Deployment reaches the
private production host through the payment-server jump path to
`10.100.80.223:22`; the payment server separately acts as the immutable OSS
evidence relay before and after cutover.

## Verification boundary

This candidate requires pull-request CI, tag CI, immutable bundle verification,
real database backup relay verification, private and public candidate checks,
and exact post-cutover evidence relay verification including the checksum
ledger itself. Any missing, modified or additional object triggers automatic
recovery.
