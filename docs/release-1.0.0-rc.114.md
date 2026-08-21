# M-BOX 1.0.0-rc.114

## Scope

This candidate carries the merged normalized staff, service and database scope
through migration `098`, including the staff brand-green visual update. It does
not build, upload or overwrite the WeChat mini-program package.

## Release correction

- The private production application host creates the PostgreSQL snapshot with
  a root-only libpq service/passfile and a PostgreSQL 16 client.
- The payment/evidence server, which already holds the bounded ECS RAM role,
  uploads the snapshot and reads every object back from OSS.
- Activation accepts the relay report only when the release SHA, database
  identity, backup age, object count, byte sizes and SHA-256 values all match.
- No cloud access key is copied to the application host, release package,
  process arguments or application container.

## Incident boundary

The rc.112 production attempt generated a valid backup and stopped at
`migration_compatible` because the private application host intentionally has
neither `ossutil` nor an OSS RAM role. No database write, candidate start or
traffic cutover occurred; rc.104 remained healthy. The backup relay was then
rehearsed against the real two-host route with four objects uploaded and read
back successfully. Temporary rehearsal copies were removed after verification.

The rc.113 tag was rejected before image construction because the package
version remained rc.112. The existing release metadata gate worked as intended;
rc.113 was not published or deployed.

## Production route

The public origin remains `https://mbox.shmbox.com`. Deployment reaches the
private production host through the payment-server jump path to
`10.100.80.223:22`; the payment server separately acts as the immutable OSS
evidence relay.

## Verification boundary

This candidate requires pull-request CI, tag CI, immutable bundle verification,
real database backup relay verification, private candidate/deep-route checks
and final public readiness. The production deployment remains fail-closed
before database writes or cutover whenever any identity or evidence differs.
