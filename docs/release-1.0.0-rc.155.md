# M-BOX 1.0.0-rc.155

## Scope

This candidate supersedes `1.0.0-rc.154` and contains the merged catalog,
inventory and customer-cart reliability changes from commits `1978523`,
`f5142de` and `6b6397e`.

Schema migration 147 adds optional inventory category and package net-content
reference fields, plus a guarded update path for already-recorded items. It
does not rewrite historical stock movements, product SKU codes, base units,
cost values, payment records or order records.

The customer mini-program source in this commit was uploaded as version
`1.1.19`. Upload is not an experience-version switch and does not prove
real-device acceptance. The server release bundle deliberately excludes the
mini-program package.

## Acceptance boundary

The release tag must pass the full immutable CI lane, including normalized
database migration and integration checks, browser checks, performance checks,
quality evidence verification and release-artifact construction. Deployment
then requires a database backup/readback, compatibility check from schema 146
to 147, isolated candidate health checks, Caddy cutover and public-route
verification.

These gates do not prove a real customer payment, physical inventory count,
WeChat real-device flow or live-store operational acceptance. Cost values that
were historically blank or overwritten are intentionally not auto-repaired;
they require an authorized manual source-of-truth review.

## Production route

Deploy only through the immutable tag process. Record the deployed commit,
image digest, schema 147 and public readiness output after the switch. On any
preflight, migration, candidate or formal-route failure, preserve the prior
immutable rc.154 image and stop rather than continuing a partial release.
