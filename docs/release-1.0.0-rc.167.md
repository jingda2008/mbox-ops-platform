# M-BOX 1.0.0-rc.167

## Scope

This candidate completes the native Mini Program menu presentation and bundle
savings contract. Product photography occupies more of the existing 520 rpx
card without increasing the card frame. Price and detail spacing is reduced,
and a dedicated details dialog can open the product image at full size without
adding the item to the cart.

Both the unscanned public menu and the table-scanned guest menu now receive a
server-authoritative `separateAmountMinor` and `savingsAmountMinor` for a
qualifying bundle. The separate amount is calculated from the current standard
price of every bundle component, multiplied by its quantity. Savings is shown
only when all components have a price in the bundle currency and the separate
total is greater than the bundle price. Missing prices, mixed currencies and
zero or negative savings fail closed instead of creating a misleading discount.

The same Mini Program source was uploaded as developer package `1.2.0` before
this release candidate was prepared. Native package upload and WeChat admin
selection remain separate from this backend deployment. The backend deployment
is still required: the already uploaded client cannot display a saving that the
production API does not return.

## Acceptance boundary

Pull request 162 passed repository quality, isolated PostgreSQL transaction and
RLS coverage, real normalized HTTP workflows, mobile-browser commercial flows
and sustained-performance checks on the feature commit. Focused service tests
also cover complete component prices, missing prices, mixed currencies and
non-discount bundles. Native Mini Program source checks and its 88-test release
suite pass.

The automated evidence proves the calculation and rendering contract, but it
does not prove that every production bundle qualifies for an advertised saving.
After cutover, production data must be read back to count qualifying bundles and
to identify bundles intentionally suppressed because their current pricing is
incomplete or non-discounted. Final visual acceptance still requires the WeChat
experience version on a real device, including a narrow-screen check.

## Production route

Deploy only from immutable tag `v1.0.0-rc.167` after tag CI publishes the same
commit, image digest, release manifest and checksummed evidence. Keep rc.166
recoverable until backup and restore metadata, candidate health, Caddy cutover,
public readiness, worker health and the four browser routes are verified. This
candidate adds no database migration; the expected normalized schema remains
155.
