# M-BOX 1.0.0-rc.165

## Scope

This candidate fixes Mini Program menu images that were successfully requested
but rejected by the device renderer. The Mini Program loads customer images
from `mbox.shmbox.com` in a cross-site, no-CORS image request. The service
previously applied `Cross-Origin-Resource-Policy: same-site` to every response,
including public JPEG files, so OpenHarmony ArkWeb refused to render them even
when the server returned HTTP 200.

The candidate returns `Cross-Origin-Resource-Policy: cross-origin` only for
`/menu/*` and `/api/public/media-assets/*`. Staff media and all other API and
application responses retain the existing `same-site` policy. Publication and
customer-visibility checks for dynamic media remain unchanged.

This release adds no database migration and does not alter product status,
price, inventory, recipe, payment, order, customer or audit data.

## Acceptance boundary

Automated coverage verifies that static menu JPEG responses are cross-origin
embeddable even with a cache query, public media responses use the same policy,
and staff media remains same-site. The implementation passed normalized server
type checking, targeted lint, the production build, and the pull request's
quality, PostgreSQL, browser, sustained-performance and aggregate gates.

This is a staff/service/database deployment. The installed Mini Program already
constructs the correct HTTPS image URLs, so this release does not upload or
publish another native Mini Program package. A scanned-table check on the
Huawei OpenHarmony device remains the final field confirmation after cutover.

## Production route

Deploy only from immutable tag `v1.0.0-rc.165` after tag CI publishes the same
commit, image digest, release manifest and checksummed evidence. Keep rc.164
recoverable until backup/readback, candidate health, Caddy cutover, public-image
headers and application readiness are verified.
