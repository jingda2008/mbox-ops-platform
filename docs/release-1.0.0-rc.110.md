# M-BOX 1.0.0-rc.110

## Scope

This candidate supersedes rc.109 and deploys the same merged staff, service
and normalized database scope through migration `098`. It does not build,
upload or overwrite the WeChat mini-program package.

## Release correction

- Freezes two different immutable image identities: the OCI archive/index
  digest used by release evidence and runtime readiness, and the selected
  linux/amd64 platform image ID used by Docker container identity checks.
- Proves that the selected platform configuration digest equals the image ID
  produced by `docker load`, while retaining the archive digest for public
  release verification.
- Supports the existing rc.104 production manifest without weakening the
  boundary: the previous platform image ID is accepted only from the active
  container after its commit label and ready response match rc.104, then is
  frozen into the new deployment evidence.
- Records the previous deployment tier in the new deployment manifest, so a
  later external rollback does not depend on a field that rc.104 did not yet
  write.

## Incident boundary

The rc.109 production attempt stopped before candidate startup, database work
or traffic cutover because the former release script incorrectly compared the
OCI index digest with Docker's loaded platform image ID. Production therefore
remained on rc.104 and schema 098. Missing host `jq` and the legacy runtime
secret location were corrected before this code defect was isolated; neither
change altered application data.

## Production route

The public origin remains `https://mbox.shmbox.com`. Deployment reaches the
production origin through the payment-server jump path to `10.100.80.223:22`.
The payment server's existing short-lived RAM role relays immutable OSS release
evidence; no cloud credential is added to the production application host or
container. The frozen deployment command supplies `MBOX_EVIDENCE_SSH_HOST`,
port and key explicitly, and verifies the relayed report against the exact
release SHA and version before activation.

## Verification boundary

The candidate requires focused release tests, the complete local check, pull-
request CI, tag CI, immutable bundle verification, the payment-server evidence
relay, candidate private/deep-route verification and final public readiness.
Any identity mismatch remains fail-closed.
