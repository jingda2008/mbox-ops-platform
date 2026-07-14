# Security Policy

## Supported version

Only the latest deployed release candidate receives security fixes before the first general-availability release.

## Reporting

Do not put credentials, payment data, customer identity, camera images, production URLs, or exploit details in a public issue. Report privately to the named M-Box technical owner and include the affected version, request ID, business date, reproduction steps, impact, and whether payment or personal data may be involved.

## Immediate response

- Suspected payment duplication, cross-table disclosure, credential exposure, or unauthorized refund is P0. Disable the affected write path, preserve logs and provider evidence, and do not repair ledgers by direct database updates.
- Rotate exposed session, QR, WeChat, payment, database, and metrics secrets from the secret manager. Committed or messaged secrets are considered compromised.
- Preserve append-only audit/outbox/runtime revision evidence and record every containment or recovery action.
- Notify the privacy and payment owners when customer identity or transaction data may be affected.

## Production requirements

Production requires HTTPS, database TLS, least-privilege roles, PITR, protected metrics, provider callback verification, idempotent queries/refunds, reviewed retention periods, dependency and penetration testing, and a documented incident contact roster. Camera and face-recognition data require a separate necessity and consent assessment before collection.
