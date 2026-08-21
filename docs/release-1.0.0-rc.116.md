# M-BOX 1.0.0-rc.116

## Scope

This candidate carries the merged normalized staff, service and database scope
through migration `098`, including the staff brand-green visual update. It does
not build, upload or overwrite the WeChat mini-program package.

## Release correction

- The private application host stages deployment and completion evidence after
  the candidate has passed private and public readiness, but does not receive
  OSS credentials or an OSS role.
- The release operator transfers each checksummed stage to the payment/evidence
  host. That host uploads and reads every object back through its bounded ECS
  RAM role, then returns a verification report.
- Activation waits for those reports and independently matches the release
  prefix, object count, byte size and SHA-256 of every staged file before it can
  archive evidence and mark the release completed.

## Incident boundary

The rc.115 candidate started successfully, passed private deep-route checks and
passed both public readiness checks. The legacy post-cutover archive then tried
to invoke OSS on the private application host, which intentionally has no OSS
role, and the release transaction automatically restored healthy rc.104. The
database stayed on schema `098`; no WeChat mini-program package was changed.

## Production route

The public origin remains `https://mbox.shmbox.com`. Deployment reaches the
private production host through the payment-server jump path to
`10.100.80.223:22`; the payment server separately acts as the immutable OSS
evidence relay before and after cutover.

## Verification boundary

This candidate requires pull-request CI, tag CI, immutable bundle verification,
real database backup relay verification, private and public candidate checks,
and verified post-cutover evidence relay reports. Any missing or mismatched
report triggers the existing automatic recovery path.
