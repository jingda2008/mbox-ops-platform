# M-BOX 1.0.0-rc.164

## Scope

This candidate contains the public-sharing update and the Mini Program menu
image delivery repair. A menu asset referenced by an active, customer-visible
guest-QR product now passes the same publication boundary as the product. It
does not expose images for inactive, hidden or non-customer-channel products.

The release adds no database migration and does not alter any product's status,
price, inventory, recipe, payment, order, customer or audit data. Existing
inactive menu products remain absent from the customer menu until staff complete
their normal readiness checks and explicitly publish them.

## Acceptance boundary

The menu-image boundary is covered by source-level tests and a real PostgreSQL
test that verifies an active customer product returns its image and that the
same image becomes unavailable immediately after the product is stopped. The
PR also passed the GitHub quality, isolated normalized PostgreSQL, normalized
browser, sustained-performance and aggregate verification gates.

This is a staff/service/database deployment. It does not itself publish a new
native Mini Program package; the installed Mini Program fetches this asset from
the public API after backend deployment. Native scanned-table verification on a
real device remains a separate acceptance step.

## Production route

Deploy only from immutable tag `v1.0.0-rc.164` after tag CI publishes the same
commit, image digest, release manifest and checksummed evidence. The current
production release must remain recoverable until backup/readback, candidate
health, Caddy cutover and public-route verification complete.
