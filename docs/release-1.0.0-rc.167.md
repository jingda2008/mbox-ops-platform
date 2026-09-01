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

## Production deployment

Production activation completed at `2026-09-01T05:53:13Z` from immutable tag
`v1.0.0-rc.167` and commit
`b828b68d0dc3f07bb4440c044498ed2ef610d775`. Feature pull-request CI run
`33473100923`, release pull-request CI run `33473790787`, tag CI run
`33474360099` and release run `33474360117` succeeded. The deployed image
digest is
`sha256:e25687c9209b2671890c375e43a961a50be815bab6477d0060efb83369e90a24`.

The deployment created backup
`/opt/mbox/backups/mbox-20260901T055136Z-bI1aVn.dump`, confirmed that no
migration was required, verified a zero-traffic candidate, switched Caddy and
archived predeployment, backup, deployment and completion evidence through the
OSS relay. Production readiness reports schema 155, production tier, strict
inventory, writes enabled and a healthy worker. The previous rc.166 image is
retained as the stopped rollback container.

The remote release transaction reached `completed` before the operator-side
wrapper discovered that the clean tag worktree lacked `@playwright/test` for
its final browser check. The running release was not replaced. After installing
the lockfile dependencies, the same release identity and digest passed the Node
and 430 px Playwright checks for `/`, `/guest?table=W01`, `/reserve` and
`/staff/live`; production activation was not repeated.

A before-and-after public-menu readback confirmed the reported issue. Before
cutover, the first 100 production products contained ten bundles and none had
the savings fields. After cutover, the complete public menu contained 247
products and 27 bundles; all 27 returned a same-currency separate-sale total
and positive savings. This proves that an unscanned menu can receive the
discount. The already uploaded native package `1.2.0` still requires real-device
visual acceptance, including 320 px behavior and confirmation of its WeChat
experience-version identity.
