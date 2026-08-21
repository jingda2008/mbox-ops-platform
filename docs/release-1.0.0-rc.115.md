# M-BOX 1.0.0-rc.115

## Scope

This candidate carries the merged normalized staff, service and database scope
through migration `098`, including the staff brand-green visual update. It does
not build, upload or overwrite the WeChat mini-program package.

## Release correction

- Candidate container arguments are now assembled into one non-empty array
  before Docker is called. This is compatible with the production host's GNU
  Bash 4.2 while retaining strict undefined-variable handling.
- Optional contract-candidate and worker-adapter arguments are appended only
  when present. The same construction is used when a contract candidate is
  restarted with normal write and worker settings.
- The correction was exercised directly by GNU Bash 4.2 on the private
  production host and is covered by the release policy tests.

## Incident boundary

The rc.114 release assets, database backup and OSS relay evidence were verified.
Activation then stopped at `provisioned` because Bash 4.2 rejected expansion of
an optional empty array under `set -u`. The candidate container had not started,
public traffic had not moved, database schema remained `098`, and rc.104 stayed
healthy. No WeChat mini-program package was changed.

## Production route

The public origin remains `https://mbox.shmbox.com`. Deployment reaches the
private production host through the payment-server jump path to
`10.100.80.223:22`; the payment server separately acts as the immutable OSS
evidence relay.

## Verification boundary

This candidate requires pull-request CI, tag CI, immutable bundle verification,
real database backup relay verification, private candidate/deep-route checks and
final public readiness. The production deployment remains fail-closed before
traffic cutover whenever any identity, evidence or candidate check differs.
