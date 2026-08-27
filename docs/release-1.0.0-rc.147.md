# M-BOX 1.0.0-rc.147

## Scope

This candidate supersedes `1.0.0-rc.146` for the staff table-detail workflow.
An authorized service employee can select any active table and read the order
line status needed for service coordination: delivered, ready for delivery,
preparing, pending, awaiting collection, cancelled or attention required. The
read model deliberately excludes payment amounts, payment method and customer
data; existing mutation and table-responsibility rules are unchanged.

The table-observation sheet no longer offers microphone recording or browser
transcription. New observations are text-only and existing historical
transcripts remain readable. This does not remove the shared transcription
endpoint or any other workflow that may still use it.

## Acceptance boundary

Focused server and staff UI tests cover service-authorized read access, denied
unauthorized access, state mapping, automatic refresh and text-only table
observations. Type checks and the production build passed before release
metadata preparation. No database migration is added; the expected schema
remains `145`.

This release does not itself prove a real service shift, device login,
collection, refund settlement or WeChat payment outcome. Those remain
controlled production acceptance work with the applicable staff roles and
external providers.

## Production route

Deploy only through the approved release script with immutable tag and image
verification, backup/readback, candidate health, Caddy cutover, rollback
safeguards and public-route checks. Post-switch evidence must record the exact
commit, image digest, schema `145`, production tier and worker health.

## Deployment evidence

Not yet deployed. Immutable tag, CI, image, backup/readback and post-switch
evidence will be recorded only after the release gate passes.
