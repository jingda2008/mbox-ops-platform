# M-BOX 1.0.0-rc.118

## Scope

This candidate carries the merged normalized staff, service and database scope
through migration `098`, including the staff brand-green visual update. It does
not build, upload or overwrite the WeChat mini-program package.

## Release correction

- The evidence host first copies each post-cutover verification report to a
  hidden temporary path on the application host.
- The deployer verifies the report SHA-256 again on the application host and
  atomically renames the complete file to the final path watched by activation.
- Activation therefore cannot observe a partially written JSON report; its
  existing exact prefix, object-count, byte-size and SHA-256 checks remain
  unchanged.

## Incident boundary

The rc.117 candidate passed private and public checks. Deployment evidence
verified `8/8`, completion evidence verified `3/3`, and both final reports are
valid when read after transfer. During the live run, activation observed the
completion report as soon as `scp` created its destination and parsed it before
the write completed, so the fail-closed gate restored healthy rc.104. The
database stayed on schema `098`; no WeChat mini-program package was changed.

## Production route

The public origin remains `https://mbox.shmbox.com`. Deployment reaches the
private production host through the payment-server jump path to
`10.100.80.223:22`; the payment server separately acts as the immutable OSS
evidence relay before and after cutover.

## Verification boundary

This candidate requires pull-request CI, tag CI, immutable bundle verification,
real database backup relay verification, private and public candidate checks,
atomic report publication and exact post-cutover evidence verification. Any
missing, modified, partial or additional object keeps the release blocked.
