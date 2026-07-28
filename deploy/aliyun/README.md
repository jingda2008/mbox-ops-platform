# Alibaba Cloud validation ingress

`Caddyfile.validation-ip` is a validation-only HTTPS entry point for the
Shanghai ECS instance. It requests a Let's Encrypt short-lived certificate for
the public IPv4 address and renews it automatically.

The IP address must stay allocated to this instance, and inbound TCP ports 80
and 443 must remain open so ACME renewal can complete. Caddy data must persist
across container replacements.

This is not the commercial domain configuration. Before production launch:

1. complete ICP filing for the owned domain;
2. point the filed domain to the production ingress;
3. replace the IP site address with the filed domain;
4. update `MBOX_PUBLIC_BASE_URL`, `MBOX_GUEST_BASE_URL`,
   `MBOX_CORS_ORIGINS`, payment callbacks, WeChat legal domains and permanent
   table QR files;
5. verify certificate renewal, real payment callbacks and WeChat device flows.

## Immutable validation deployment without ACR

The optimized release path uses the exact image built by GitHub CI:

1. pull requests run risk-classified CI;
2. runtime changes run quality, browser, database and image jobs in parallel;
3. the image job uses GitHub Actions layer cache and exports one immutable bundle;
4. a version tag reuses that successful bundle instead of rebuilding it;
5. `deploy-release.sh` downloads the GitHub release asset, verifies its archive
   checksum and OCI config digest, resumes the SSH upload, starts a zero-traffic
   candidate and switches Caddy only after readiness succeeds;
6. any failed candidate or cutover restores the previous container.

The client machine must hold the deployment private key. The current default is
`~/.ssh/mbox_aliyun_ed25519`; passwords are not accepted by the deployment
script. Resumable upload uses `--append-verify` when the installed rsync supports
it and falls back to `--append` on the macOS system rsync; the archive checksum
is verified again on the server before loading.

Dry-run bundle validation:

```bash
MBOX_RELEASE_TAG=v1.0.0-rc.48 \
MBOX_DEPLOY_DRY_RUN=1 \
./deploy/aliyun/deploy-release.sh
```

Alibaba validation deployment:

```bash
MBOX_RELEASE_TAG=v1.0.0-rc.48 \
MBOX_DEPLOYMENT_TIER=validation \
./deploy/aliyun/deploy-release.sh
```

Production mode always creates a database backup before migration or cutover.
Validation mode creates a backup when migrations changed or no recent backup
exists. A migration manifest prevents repeated no-op migration runs.

This pipeline does not alter application features, API contracts, customer
data, payment behavior or authorization rules. It only changes how a verified
image reaches the validation server.
