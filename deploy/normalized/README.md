# M-BOX normalized candidate deployment

This directory is an isolated Alibaba Cloud candidate-deployment skeleton for
`normalized-core-v1`. It does not modify `deploy/aliyun`, and every mutating
script is a dry-run unless both `MBOX_DEPLOY_APPLY=1` and its operation-specific
confirmation value are supplied.

## Safety boundaries

- Candidate build, database, startup, verification and rollback scripts never
  stop or replace the existing `mbox-app` container. Only the separately
  confirmed `activate-candidate.sh` may rename it to a versioned rollback name
  after the candidate has passed both isolated and public-route verification.
- `pre-cutover-check.sh` is read-only. `activate-candidate.sh` is the separately
  confirmed atomic routing change: it verifies the isolated candidate, switches
  Caddy, checks the public SHA/schema identity, preserves the previous container
  as a rollback target and restores it automatically if any later gate fails.
- Database initialization accepts only a database with zero user tables. It
  runs `runNormalizedMigrations` from `database/normalized-migrations`; it does
  not import, copy or project legacy store JSON.
- The candidate has no built-in fake payment, printer, message or worker
  adapter. Production runtime configuration must pass the application's own
  fail-closed validation.
- Secrets belong in an operator-owned environment file outside the repository.
  The scripts pass only its path to Docker and do not print its contents.
- Use `env.validation.example` for the controlled validation tier and
  `env.example` for commercial production. Both require a private metrics
  bearer token; production additionally requires real payment and worker
  adapter configuration.

## Image

The image uses a build stage for the Vite web output and `dist-normalized`, then
a production-only runtime stage. It runs as the `node` user, uses a read-only
container filesystem, drops Linux capabilities, and checks `/api/ready`.

Dry-run image build:

```bash
IMAGE_REF='<candidate-image-reference>' \
APP_COMMIT_SHA='<git-commit-sha>' \
deploy/normalized/build-image.sh
```

An actual local build additionally requires:

```bash
MBOX_DEPLOY_APPLY=1 \
NORMALIZED_BUILD_CONFIRM=BUILD_NORMALIZED_IMAGE \
IMAGE_REF='<candidate-image-reference>' \
APP_COMMIT_SHA='<git-commit-sha>' \
deploy/normalized/build-image.sh
```

Record the reported `sha256:` image ID. Candidate startup refuses an image if
that digest or its OCI commit label differs from the expected values.

## Empty database initialization

Use a newly created, isolated database. Do not point this command at the legacy
database. Dry-run:

```bash
IMAGE_REF='<candidate-image-reference>' \
APP_COMMIT_SHA='<git-commit-sha>' \
EXPECTED_IMAGE_DIGEST='<sha256-image-id>' \
ENV_FILE='<absolute-private-env-file>' \
deploy/normalized/initialize-empty-database.sh
```

Actual initialization requires both `MBOX_DEPLOY_APPLY=1` and
`NORMALIZED_DATABASE_CONFIRM=INITIALIZE_NEW_EMPTY_DATABASE`. The in-container
guard refuses any target containing a user table before invoking normalized
migrations.

After migration, apply both the reviewed, secret-free store configuration and
the versioned catalog with `provision-store.sh` (`STORE_CONFIG_FILE` and
`CATALOG_CONFIG_FILE`). Employee PINs and the daily store credential are read only
from the private environment file. The script is a dry-run unless
`NORMALIZED_STORE_CONFIRM=PROVISION_VERSIONED_STORE_CONFIG` is supplied.

## Candidate and verification

The candidate name must start with `mbox-normalized-candidate-`. The bind
address, host port and verification URL are inputs; no server address is stored
in this repository.

```bash
IMAGE_REF='<candidate-image-reference>' \
APP_COMMIT_SHA='<git-commit-sha>' \
EXPECTED_IMAGE_DIGEST='<sha256-image-id>' \
ENV_FILE='<absolute-private-env-file>' \
CANDIDATE_CONTAINER_NAME='<isolated-candidate-name>' \
CANDIDATE_BIND_ADDRESS='<loopback-bind-address>' \
CANDIDATE_HOST_PORT='<unused-host-port>' \
CANDIDATE_BASE_URL='<candidate-base-url>' \
deploy/normalized/start-candidate.sh
```

Actual startup requires `MBOX_DEPLOY_APPLY=1` and
`NORMALIZED_CANDIDATE_CONFIRM=START_ISOLATED_CANDIDATE`. It then verifies:

1. OCI commit label equals `APP_COMMIT_SHA`.
2. Local image ID equals `EXPECTED_IMAGE_DIGEST`.
3. The container uses that exact image ID and normalized schema label.
4. `/api/version` and `/api/ready` return the same SHA, schema flavor and
   deployment tier requested by the release command.
5. The database is migrated and the configured store is active.
6. The store configuration and catalog hashes are tied to the candidate SHA.
7. Products, prices, bundle components, KDS scopes, financial approval limits,
   table minimum-spend decisions and layout coordinates pass the commercial-readiness gate.
8. The loaded worker adapter declares every required commercial capability,
   including Postar payment creation and approved refund execution. A generic
   no-op outbox adapter cannot satisfy this gate.

For `DEPLOYMENT_TIER=validation`, database-only workers and simulated payment
remain allowed because this environment is not approved for real settlement or
hardware. `DEPLOYMENT_TIER=production` retains the external worker and payment
capability gates above.

## Pre-cutover gate

`pre-cutover-check.sh` checks both the current service and candidate without
changing routing. Actual checking requires
`NORMALIZED_PRE_CUTOVER_CONFIRM=CHECK_ONLY_NO_CUTOVER`. Passing this gate is not
authorization to switch production traffic; payment, worker adapters and staff
browser acceptance still require separate evidence. After those gates are
reviewed, `activate-candidate.sh` requires the explicit confirmation value
`NORMALIZED_ACTIVATION_CONFIRM=ACTIVATE_VERIFIED_NORMALIZED_CANDIDATE`.

## Candidate rollback

`rollback-candidate.sh` only stops and removes a container with both the
candidate name prefix and `normalized-core-v1` label. It cannot target
`mbox-app`. Actual cleanup requires
`NORMALIZED_ROLLBACK_CONFIRM=REMOVE_ISOLATED_CANDIDATE`. If
`CURRENT_HEALTH_URL` is supplied, the script verifies the current service after
candidate removal.

## Local static verification

```bash
node --test deploy/normalized/deployment.test.mjs
```

This validates strict shell mode, dry-run behavior, protected-container rules,
empty-database migration boundaries, image structure, and absence of embedded
public endpoints or credential assignments.
