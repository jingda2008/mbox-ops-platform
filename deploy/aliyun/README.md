# M-BOX Alibaba Cloud release system v2

This directory is the only supported application deployment entry for the
normalized runtime. The release process consumes one image, one full commit
SHA, one image digest and `normalized-runtime-config/v1`.

## Candidate freeze

Formal release tags must point to a commit reachable from `origin/main`. The
tag workflow reuses the image bundle produced for that exact commit; it never
rebuilds a different image during deployment. Ordinary changes cannot enter a
candidate after full CI starts. Only a P0 availability, money or data-integrity
fix may replace it, and that replacement is a new candidate.

## Mandatory order

1. Freeze the main-branch commit and verify SHA plus image digest.
2. Run the redacted real-environment configuration preflight.
3. Check public DNS, TLS and enabled external endpoints.
4. Inspect migration lineage and checksums without writing the database.
5. Create and verify the database backup in private OSS.
6. Run migrations and provisioning.
7. Start a zero-traffic candidate on an isolated port.
8. Verify API, browser, table QR, reservation and employee deep routes.
9. Switch Caddy traffic and repeat verification on the formal URL.
10. Upload release evidence, checksums and state journal to OSS.

Configuration, external or migration-compatibility failures happen before any
database write. Candidate, cutover or formal verification failures restore the
previous immutable image without rebuilding it.

## Configuration contract

Do not hand-maintain alternate environment examples. Generate validation and
production templates from the schema:

```bash
npm run release:config:generate
```

Integration modes are `disabled`, `test`, `uat` or `production`. Disabled
integrations reject leftover provider fields; enabled integrations require the
whole group. Secrets are checked but never printed.

## Deployment

The client must have the deployment private key. Password authentication is
not supported.

```bash
MBOX_RELEASE_TAG=v1.0.0-rc.83 \
MBOX_DEPLOYMENT_TIER=validation \
./deploy/aliyun/deploy-release.sh
```

Dry-run artifact validation:

```bash
MBOX_RELEASE_TAG=v1.0.0-rc.83 \
MBOX_DEPLOY_DRY_RUN=1 \
./deploy/aliyun/deploy-release.sh
```

The Shanghai validation ingress uses `Caddyfile.validation-ip`. Before a
commercial launch, use the filed domain and revalidate TLS, payment callbacks,
WeChat legal domains and permanent table QR files.

The filed payment callback domain is installed separately from application
cutover. Its certificate and private key remain server-side and are never added
to a release bundle or Git repository:

```bash
MBOX_PAYMENT_DOMAIN=pay.shmbox.com \
MBOX_PAYMENT_CERT_FILE=/root/payment-tls/pay.shmbox.com.pem \
MBOX_PAYMENT_KEY_FILE=/root/payment-tls/pay.shmbox.com.key \
./deploy/aliyun/configure-payment-ingress.sh
```

The command validates hostname, expiry, key pairing, Caddy syntax and a local
TLS application probe. Any failure restores the previous Caddyfile. Use the
reported backup path with `rollback-payment-ingress.sh` to roll back later.

## Evidence and logging

Formal evidence, manifests, checksums, backups and the latest rollback images
are stored in private OSS and verified after upload. SLS only receives selected
5xx, payment/refund, database-pool, container lifecycle, release and permission
audit events. GitHub artifacts are temporary diagnostics and their quota cannot
change a test result; OSS verification failure blocks a formal release.

Cloud bootstrap and verification:

```bash
./deploy/aliyun/bootstrap-evidence-services.sh
./deploy/aliyun/verify-evidence-services.sh
./deploy/aliyun/install-selective-observability.sh
```

The collector is outside the request path and can be stopped without affecting
the application:

```bash
systemctl disable --now mbox-sls-collector.timer
```
