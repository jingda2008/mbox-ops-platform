# Changelog

## 1.0.0-rc.91 - 2026-08-20

- Required explicit customer agreement before WeChat phone authorization and membership enrollment while preserving browse-and-order access after refusal.
- Refined the mini-program home, menu entry, ordering layout, tab bar, M-BOX artwork and Huawei X5 narrow-screen behavior without duplicating member functions across tabs.
- Added authorized, typed home-content draft, publish and pause management for customer-facing activities and brand stories.
- Preserved staff shortcuts and explicit employee switching while tightening staff-assisted ordering contracts.
- Added mobile barcode and QR receiving for tracked inventory, typed product inventory-control modes, and safe receipt unit-cost derivation; food and snack products can remain explicitly not managed.
- Added normalized migration 097 and PostgreSQL coverage for inventory and home-content publication; WeChat review, real payment and physical-device acceptance remain separate release evidence.

## 1.0.0-rc.89 - 2026-08-15

- Aligned Postar synchronous responses with the provider contract: requests remain RSA-signed, optional response signatures are verified when present, and unsigned synchronous responses are accepted only over the fixed HTTPS endpoint with strict merchant, order, status and amount binding.
- Preserved pending payment queries when Postar reports `txamt=0`, while requiring the exact expected amount before any successful result can activate fulfillment.
- Distinguished signed callbacks from server-to-server active queries in payment evidence instead of falsely marking unsigned query responses as signature-verified.
- Preserved an explicitly configured `test`, `uat` or `production` payment mode during server environment canonicalization, preventing a valid test configuration from silently changing to UAT.
- Kept store online-payment policy fail-closed and production acquiring unchanged; validation uses the restored Postar test channel only.

## 1.0.0-rc.88 - 2026-08-15

- Restored role-scoped responsibility assignment, venue, performer, schedule, song-catalog and product operating configuration without exposing management actions to every logged-in employee.
- Normalized performer songs and aliases, product eligibility/search/recommendation/cost fields, reservation timing policy and customer notification consent while retaining display snapshots only for flexible copy, images and immutable history.
- Added a fail-closed store payment policy and database-enforced unpaid-order inventory reservation/KDS isolation; no configured provider or missing policy can silently open new online payment.
- Restored current performance information on guest ordering and date-specific performance information on reservation, removed member notification switches, and corrected server-validated hidden bundle components in guest recommendations.
- Added migrations 042–048, rollback-window compatibility adapters, exact legacy-dependency gates and unit, PostgreSQL, browser, accessibility, responsive and load regression coverage.

## 1.0.0-rc.87 - 2026-08-14

- Preserved the bind-mounted Caddyfile inode while installing or rolling back the payment domain, so the running container reads the exact host configuration that was validated.
- Added a host-to-container SHA256 visibility gate before Caddy validation and reload; a stale bind mount now fails before activation.
- Kept provider payment disabled; this release changes ingress activation only and does not initiate a real transaction.

## 1.0.0-rc.86 - 2026-08-14

- Normalized Alibaba Cloud certificate bundles before Caddy activation by removing bundled self-signed root certificates while preserving the leaf and intermediate chain.
- Replaced the immediate payment-domain TLS probe with a bounded readiness retry, so a successful Caddy reload is not rejected while the new TLS listener is still becoming ready.
- Backed up and restored the managed certificate and private key together with the Caddyfile and domain snippet when ingress validation fails.
- Kept provider payment disabled; this release repairs payment callback ingress installation and does not initiate a real transaction.

## 1.0.0-rc.85 - 2026-08-14

- Added a signed, amount-checked active Postar payment query to the normalized runtime so an uncertain payment can be verified without creating another charge.
- Reconciled successful query results exactly once, preserved pending results and reopened failed or closed payment actions for a controlled retry.
- Added an employee-facing "核对是否到账" action after QR or barcode initiation while keeping guests and staff on the same table payment.
- Added a release-controlled `pay.shmbox.com` TLS ingress installer with certificate, private-key, Caddy validation, redacted access logging, health verification and rollback.
- Added the first real one-yuan payment acceptance runbook and permanent regression coverage; production acquiring remains disabled until the correct provider public key, channel environment and explicit transaction authorization are present.

## 1.0.0-rc.84 - 2026-08-14

- Added the store credential and every employee PIN field from the authoritative store configuration to generated validation and production templates.
- Preserved only valid dynamic provisioning fields during server-side environment canonicalization and rejected malformed aliases.
- Moved store provisioning credential and four-digit PIN format checks into the read-only configuration preflight before backup or database work.
- Reused one provisioning validator in both preflight and database provisioning so the checks cannot drift.
- Stopped sending IP addresses as TLS SNI server names and added permanent regression coverage for both failures observed during the rejected `rc.83` candidate.

## 1.0.0-rc.83 - 2026-08-14

- Replaced parallel deployment paths with one Alibaba Cloud release chain, one root Dockerfile and one normalized runtime configuration contract.
- Added explicit disabled/test/UAT/production modes for payment, AI, printing and headset integrations; legacy Postar aliases now fail closed after one protected server-side normalization.
- Added configuration, DNS/TLS, migration-compatibility, backup, migration, candidate, cutover, evidence and completion states that cannot be skipped.
- Required formal tags to be reachable from `main` and bound each release to one frozen SHA, image digest, configuration version and migration manifest.
- Added a permanent release-incident register plus isolated config-rejection, post-cutover rollback and happy-path candidate drills with SHA256 evidence.
- Kept GitHub diagnostic artifacts non-blocking while OSS evidence and checksum failures remain formal release blockers.
- Removed obsolete Google Cloud and duplicate normalized deployment scripts without changing the normalized business runtime or database model.

## 1.0.0-rc.82 - 2026-08-14

- Kept inactive Postar UAT identifiers dormant when validation explicitly sets `MBOX_POSTAR_ENABLED=false` and uses simulated checkout.
- Preserved fail-closed production payment requirements and explicit provider configuration, including the provider public key.
- Added regression coverage for inactive validation settings, explicit provider precedence and production enforcement after the `rc.81` candidate startup rejection.
- Preserved the `rc.81` immutable OCI identity checks and the `rc.80` shared-table assisted-ordering and payment handoff behavior.

## 1.0.0-rc.81 - 2026-08-14

- Preserved the `rc.80` shared-table assisted-ordering and guest-payment behavior without changing business semantics.
- Accepted both OCI image indexes and Docker-flattened single-platform OCI manifests during Alibaba Cloud release verification.
- Derived the release image identity from the immutable archive reference instead of a builder-local Docker image ID.
- Kept archive, referenced-blob, Linux/AMD64 configuration and final Docker image-ID checks fail-closed before database migration or traffic cutover.

## 1.0.0-rc.80 - 2026-08-14

- Unified employee-assisted and guest self-service settlement around one shared table order and one active payment action.
- Let employees choose either a customer-scanned payment QR or an employee-scanned customer payment code after assisted ordering, without creating a second order.
- Synchronized assisted orders to every authenticated guest on the current table session and allowed a guest phone to continue the same reusable QR payment.
- Prevented guest devices from interrupting employee barcode collection or reusing another guest's JSAPI parameters, while keeping payment-provider payloads encrypted at rest.
- Added role-isolation, payment-method locking, same-table multi-guest, provider-rejection and real-browser regression coverage; real small-value acquiring remains a separately authorized acceptance step.

## 1.0.0-rc.79 - 2026-08-13

- Added bounded browser-style HTTP and rendered Playwright release gates for the home, fixed-table QR, reservation and employee deep links, including front-end build identity, root mounts and executable module assets.
- Kept API-style unknown requests as structured 404 responses instead of weakening the single-page application boundary.
- Hardened automatic and operator rollback with immutable identity, app-shell verification and restored container restart policy; exact-commit Playwright remains the rendered-browser acceptance gate.

## 1.0.0-rc.78 - 2026-08-13

- Unified the default development, build, container and Alibaba Cloud release paths on the normalized runtime while retaining explicit legacy-only commands for controlled comparison.
- Restored security response headers, protected runtime metrics and one-query readiness checks, and packaged the selective SLS collector in the immutable image.
- Moved guest duplicate-order confirmation and per-customer/per-table rate limits to a server-authoritative transaction; thresholds are deployment-configurable and the table limit cannot be lower than the customer limit.
- Restored contribution-sensitive menu ranking without exposing product cost to customer clients.
- Stopped invalid reservation links and failed session renewals from creating repeated polling errors while preserving the submitted receipt and manual refresh path.
- Added a current-business-day cashier after-sales workbench for original-item partial refunds, separate-person approval and channel-safe execution; real online refund success still requires a verified provider callback.
- Preserved the current table-session cart after uncertain order failures while isolating the next turnover with a server-generated opaque scope.
- Reused the exact refund payload and idempotency key after retryable failures, and added an explicit second confirmation before recording manual cash or POS refund results.
- Made store and catalog publication atomic, bound release smoke checks to the runtime image digest and hardened rollback, OSS evidence and selective SLS handling.
- Kept real payment, physical POS, printers, inventory reconciliation and staff field acceptance outside completed commercial acceptance.

## 1.0.0-rc.77 - 2026-08-13

- Audited customer, reservation, employee, fulfillment, payment, refund, inventory, security, performance and release paths with browser, PostgreSQL, load and role simulations.
- Fixed the normalized fulfillment empty state so filtered queues no longer render a blank work surface.
- Improved narrow mobile ordering with a reachable 44px recommendation add action, full-width single search results and larger cart, search and quantity controls.
- Added semantic page headings and corrected serious contrast issues across guest, reservation and employee work surfaces.
- Added normalized browser accessibility coverage for guest ordering, public reservation, employee home and onsite actions.
- Corrected isolated-load cleanup so expected rejection of closing unsettled fixture tables cannot contaminate database failure metrics; the repeated 5 RPS PostgreSQL gate completed with zero transaction failures.
- Kept simulated payment, real acquiring, physical POS, printers and other hardware explicitly outside completed commercial acceptance.

## 1.0.0-rc.76 - 2026-08-13

- Added an explicit validation-only inventory audit mode so incomplete recipe and stock setup no longer blocks simulated ordering, while production remains strict and rejects this mode.
- Recorded unconfigured inventory items in order metadata, audit events and readiness/version responses instead of silently pretending that stock was deducted.
- Rebalanced the guest ordering page for mobile: mood and service controls are compact, products appear earlier, menu items remain directly addable and detail pages remain available from product images.
- Replaced pure-white normalized customer and staff surfaces with restrained soft off-white surfaces, strengthened tactile control feedback and kept final payment visually distinct from ordinary cart review.
- Added 320, 360, 390 and 430 pixel customer, reservation, manager and all-employee role coverage, including overflow and high-frequency route checks.
- Prevented concurrent store provisioners from retaining a stale serializable snapshot while waiting for the global provisioning lock, and added both concurrent PostgreSQL coverage and normalized migration-count verification.

## 1.0.0-rc.75 - 2026-08-13

- Preserved the validated `rc.72` business behavior and the `rc.74` OCI archive digest-chain verification.
- Replaced obsolete aggregate-projection release checks with the normalized service contract: exact commit, normalized schema flavor and migrated schema version.
- Bound the candidate runtime to the exact release commit while keeping image identity authoritative in the immutable OCI manifest and release evidence.

## 1.0.0-rc.74 - 2026-08-13

- Preserved the validated `rc.72` fixed-table QR, reservation, feedback, configuration and normalized authorization behavior.
- Corrected Alibaba Cloud release verification for OCI multi-platform archives by independently verifying the OCI index, Linux/AMD64 manifest and image configuration digest chain.
- Kept database backup, migration, candidate health, cutover and rollback gates unchanged.

## 1.0.0-rc.72 - 2026-08-13

- 改为不绑具体桌位的预约申请，并在门店确认后的约定到店时间启动10分钟到店保留。
- 修正固定桌码未开台、无效入口和开台后的客户引导，不再要求更换静态桌码。
- 增加全局操作结果定位和服务端复核的管理员权限控制中心。
- 将权限、审批、数据范围和岗位入口改为服务端目录与单项运行时接管，版本初始化不覆盖现场已配置项目。
- 删除规范化KDS、支付、退款、通知和调价对旧岗位能力数组的授权回退。

## 1.0.0-rc.71 - 2026-08-12

- Replaced the obsolete aggregate-runtime migration command in Alibaba Cloud activation with the normalized migrator that is actually shipped in the immutable image.
- Added a release regression test that rejects any return to the missing legacy migrator path.
- Preserved the `rc.70` quota-independent evidence archives and the `rc.69` assisted-ordering, onsite product-gift and customer-benefit separation behavior.

## 1.0.0-rc.70 - 2026-08-12

- Removed the GitHub Actions artifact quota as a single point of failure in tagged releases.
- Materialized commit-bound quality and runtime evidence from successful CI job outputs and stored checksummed evidence archives beside the immutable image in the draft pre-release.
- Made the release workflow and Alibaba Cloud deployment verify those exact archives before creating the OSS evidence bundle or starting a candidate container.
- Retained Actions artifacts only as optional diagnostics and preserved the existing CI, image digest, database backup, candidate health, cutover and rollback gates.
- Preserved the `rc.69` assisted-ordering, role-limited onsite product-gift and customer-benefit separation behavior without changing business semantics.

## 1.0.0-rc.69 - 2026-08-12

- Restored fixed-table staff-assisted ordering for open table sessions in the normalized onsite workspace.
- Restored role-limited product gifts with a required reason, immutable audit evidence and server-authoritative approval resolution.
- Kept customer benefits out of onsite table actions so birthday, recall and daily customer-operation rights remain a separate business domain.
- Preserved one-use customer-benefit authorization while allowing an employee role limit to authorize separate eligible gift orders on the same table.
- Added mobile manager, API authorization, PostgreSQL concurrency, migration and TC regression coverage.
- Kept real payment, printer hardware and external messaging integrations outside this validation release's completion claim.

## 1.0.0-rc.68 - 2026-08-09

- Moved production staff presence heartbeats to normalized PostgreSQL leases so routine heartbeats and lightweight authentication no longer read, clone or rewrite the whole-store aggregate.
- Added one-pass presence hydration, bounded staff-directory caching and revision-preserving heartbeat coverage while keeping aggregate audit events for login, logout and real online-state transitions.
- Reused a single China-time formatter in hot projections, delayed noncritical initial heartbeat work and removed an extra aggregate read from reservation access.
- Coalesced repeated guest-session insight writes per anonymous visit while retaining database idempotency as the authoritative fallback.
- Added bounded normalized route latency metrics, database-pool and mutation-queue readiness details, reusable historical-log analysis and explicit runtime SLOs.
- Added a mandatory two-instance PostgreSQL performance job to CI, including route latency, event-loop, pool, queue and projection gates with retained raw evidence.
- Added a reusable function/performance testing method, TC/evidence templates and a machine-verified CI quality ledger bound to the exact commit and run id.
- Removed the unused iOS asset-regeneration dependency after its transitive toolchain retained unfixed advisories; the application dependency audit now reports zero vulnerabilities.
- Increased high-frequency mobile controls to a reliable touch size without expanding unrelated desktop information density.
- Split TC acceptance status from engineering coverage so external dependencies, field-validation work, partial implementations and known capability gaps cannot be presented as completed.
- Kept the release closed until full automated checks, independent quality review, immutable-image deployment and post-cutover metric evidence succeed; real payment, printing, weak-network and three-shift acceptance remain external gates.

## 1.0.0-rc.67 - 2026-08-09

- Preserved the independently approved `rc.66` fulfillment, role-isolation, inventory-permission and reservation behavior without additional business changes.
- Bypassed exhausted GitHub Actions temporary artifact storage for release tags by staging the immutable CI image bundle in a draft GitHub pre-release.
- Kept the release closed until the complete tag CI succeeds, then verified the SHA, image digest and archive checksum before publishing the pre-release.
- Retained Actions artifact uploads for non-tag workflows and preserved the existing Alibaba Cloud checksum, candidate health, cutover and rollback gates.

## 1.0.0-rc.66 - 2026-08-09

- Reduced production fulfillment to one maker action while preserving an explicit system auto-receipt marker instead of fabricating a manual start event.
- Reduced delivery to one employee “已送达” action that atomically records inferred pickup, confirmed delivery, linked service completion and immutable audit evidence.
- Isolated production and delivery queues by the employee's home role, active shift, workstation, skill and assignment; secondary management duties no longer turn a bartender into a store-wide delivery workbench.
- Prioritized exception and overdue work, the current employee's deliveries, eligible backup deliveries and production work using deadline-first ordering.
- Kept electronic KDS active when printing is queued or failed and added a duty-manager print-failure risk without claiming physical printer acceptance.
- Added separate personal permissions for receiving, counting, remakes and bottle storage in both the API and interface; a direct grant no longer expands into unrestricted inventory management.
- Separated formal reservations, arrived guests and seated history from walk-ins; staff-created walk-ins now use the table-opening flow instead of a synthetic reservation.
- Added an independent quality supervision gate, focused fulfillment acceptance cases, mobile role checks and explicit deployment, hardware and payment evidence boundaries; the candidate passed only after two rejected review rounds and a final request-trace correction.

## 1.0.0-rc.65 - 2026-08-08

- Added bounded in-process PostgreSQL mutation serialization so aggregate writes no longer exhaust the five-connection application pool during bursts.
- Reused a revision-matched verified aggregate state during serialized writes, avoiding a repeated full-state database read and parse on every mutation.
- Classified database backpressure as a temporary 503 response, typed high-frequency business rejections as explicit 4xx responses and client disconnects as warnings rather than system failures; unclassified defects remain error-level signals.
- Made repeated service completion and KDS completion from another device converge on the existing terminal state without duplicate events or fulfillment.
- Aligned the guest behavior database constraint with every application event type, including quick-select, recommendation-update and cart-abandonment events.
- Removed guest credentials from new QR query strings, exchanged sessions through POST bodies and added application plus Caddy access-log redaction.
- Refreshed the production dependency lock for patched `brace-expansion` and `fast-uri` releases identified by the GitHub Actions security gate.
- Added PostgreSQL queue, error classification, redaction, QR contract, event contract, semantic idempotency, browser and load regression coverage.

## 1.0.0-rc.64 - 2026-07-31

- Added configurable high-frequency navigation defaults for every role while preserving the complete permission-derived module set.
- Added optional employee-level navigation overrides for multi-role and exceptional assignments, with the employee override taking precedence over role defaults.
- Added explicit entry ordering, move-up, move-down and restore-default controls in the administrator master-data workspace.
- Kept role defaults inside the versioned configuration draft and publication flow while recording personal overrides through existing employee audit events.
- Rejected role and employee entry selections outside their effective permissions, removed stale selections when permissions change and limited visible high-frequency entries to four.
- Applied configured order consistently to desktop sidebars, mobile bottom navigation and role home shortcuts.
- Added contract, configuration-version, authorization, employee-audit, role-model and browser coverage for configurable navigation.

## 1.0.0-rc.63 - 2026-07-31

- Applied role-focused navigation to the desktop sidebar instead of limiting the simplification to the home page and mobile bottom bar.
- Kept home and each role's two to four primary modules visible while moving all other authorized modules into an explicit expandable section.
- Preserved full authorization and direct metric, task, voice and programmatic navigation to secondary modules.
- Automatically expanded secondary navigation when a low-frequency module became active and collapsed it again after returning to primary work.
- Hardened mobile drawer navigation so complete authorized modules remain reachable without repeated menu clicks or off-screen controls.
- Added desktop manager navigation regression coverage and shared browser helpers for primary and secondary role navigation.

## 1.0.0-rc.62 - 2026-07-31

- Separated each role's primary mobile navigation from its complete authorized module set so frequent work stays within two to four visible entries without removing legitimate access.
- Added a fixed role-aware mobile navigation bar with a compact overflow entry for infrequent authorized modules.
- Focused execution roles on their own occupied, reserved or attention-required tables while keeping other active and empty tables available through explicit expansion controls.
- Reduced mobile header, metric, action and empty-state height so the current task, responsible tables and support actions remain visible with less scrolling.
- Added dedicated stage, technical and marketing role profiles, navigation priorities and operational metrics.
- Hid inventory, payment and member-benefit controls that the signed-in employee cannot execute while retaining server-side permission enforcement.
- Corrected server responsibility metrics so assigned empty tables no longer inflate the active-table count.
- Added unit and browser regression coverage for role entry limits, mobile overflow, table focus and permission-specific control visibility.

## 1.0.0-rc.61 - 2026-07-31

- Required staff to select and confirm an open table before entering full-screen assisted ordering.
- Locked the confirmed table throughout ordering, blocked silent table switching and required the signed-in employee's PIN to exit before selecting another table.
- Cleared the unsubmitted cart and table selection after a verified exit, while allowing table-specific shortcuts to prefill but not bypass confirmation.
- Changed guest mood selections from service tasks into visit-scoped table context so staff can see the signal without receiving duplicate work.
- Added structured collaboration guidance and automatic reveal behavior when an employee action requires a manager or another role.
- Expanded customer behavior, unreasonable-request, simulated-payment and complex-refund regression evidence without allowing those requests to bypass price, gift, refund or authorization controls.
- Added browser coverage for table locking, PIN-protected reselection, complimentary ordering, payment handoff, responsive layouts and cross-role fulfillment.

## 1.0.0-rc.60 - 2026-07-30

- Added explicit “immediate payment” and “table tab” choices to staff-assisted ordering; table-tab orders enter fulfillment without creating a payment intent and remain collectible before table close.
- Added auditable refund outcomes for cancelling billed items, retaining fulfilled items as service recovery, or reopening the exact refunded receivable for a replacement payment.
- Linked replacement payments to their source refund, blocked duplicate active recollection, blocked table close until recollection succeeds and allowed a safe retry after a failed or expired recollection attempt.
- Preserved human refund approval, requester/approver separation, configured approval limits and provider or physical-POS confirmation requirements.
- Fixed quick-selection answers being scored correctly but then hidden by a price-midpoint comparison layout that kept the same product in the primary position.
- Made the highest rule-ranked eligible bundle the visible primary recommendation while retaining a lower-priced comparison when available.
- Limited the “more complete” role to an explicitly configured upgrade and labelled other higher-priced choices as alternatives instead of inventing an upgrade.
- Added production-like two-person recommendation coverage proving relaxed/refreshing and ritual/layered answers produce different primary products and comparison sets.
- Strengthened the guest browser flow to assert the rendered recommendation names change after materially different quick-selection answers.

## 1.0.0-rc.59 - 2026-07-30

- Made menu search immediately available on every guest ordering view, with a visually distinct search shortcut and global matching across product names, SKUs, categories, specifications, descriptions and tags.
- Added an optional one-tap opening scene for walk-in tables covering date, friends, brothers, besties, business and celebration.
- Persisted the selected scene as an immutable visit-scoped table-operation snapshot, exposed it to the guest session and used it together with party size in deterministic menu recommendation ranking.
- Extended the server-side AI `table.open` tool so natural commands such as “L01两位约会开台” preserve the same scene instead of bypassing recommendation context.
- Kept opening fully functional when staff skip the scene, retained the scene across table transfer through the table session and prevented previous-visit context from leaking into a reopened table.
- Replaced brittle browser assertions tied to retired product names with behavior-based recommendation, search and product-detail acceptance.

## 1.0.0-rc.58 - 2026-07-30

- Hid refund approval actions unless the current employee is not the requester, has approval permission and has a sufficient configured refund limit.
- Added explicit current-limit and eligible-approver guidance for refunds that exceed the signed-in employee's authority.
- Added regression coverage for requester separation, zero-limit administrators and sufficient-limit owners.
- Replaced a TypeScript parameter-property declaration in the hardware business error with equivalent explicit fields so strict TypeScript 6 production builds remain reproducible.

## 1.0.0-rc.57 - 2026-07-30

- Restored actionable refund review in the staging payment simulator while preserving requester/approver separation, approval limits and explicit human confirmation.
- Added clear pending-refund and eligible-approver guidance instead of generic quantity validation errors or silent unavailable actions.
- Prevented administrators without finance permissions from seeing or executing cash-collection actions in payment pages and AI plans.
- Classified cash collection slips as protected human finance workflows, including natural-language requests to create or generate them.
- Removed acknowledged reservation incidents from the active AI duty-manager warning and planning context while retaining them in handover records.
- Added browser and API regression coverage for administrator cash-command rejection, refund duplication, reservation resolution and role-aware payment controls.

## 1.0.0-rc.56 - 2026-07-29

- Rebuilt public reservation seating around proportional zone frames so floor-plan crops and table overlays remain aligned on mobile without horizontal scrolling.
- Corrected S01-S07 overlay identifiers and separated the indoor floor from the W01-W17 outdoor area.
- Added an indoor overview, a focused stage-side view and an outdoor view with compact density-aware status markers.
- Reduced reservation header and instruction height, kept table details and primary actions in the mobile viewport, and automatically revealed the selected table's availability, deposit and minimum-spend details.
- Extended 390x844 browser coverage for S-table visibility, indoor/outdoor isolation, map bounds and selected-table detail visibility.

## 1.0.0-rc.55 - 2026-07-29

- Replaced the public reservation form with a mobile-first three-step flow for date and party size, direct store assignment or self-selected seating, and final contact confirmation.
- Connected self-selected reservations to the official 61-table venue directory with live availability, occupied-table status, server-side collision protection and table release after cancellation.
- Added focused stage, indoor and outdoor map views, visible deposit and minimum-spend information, and fixed bottom actions without horizontal mobile overflow.
- Added manager task supervision actions for assisted completion, takeover and safe reassignment while preserving the original task, responsibility history and immutable audit events.
- Added database migration 021 for reservation assignment mode and requested-table projections, plus public-access, cross-client and manager-workflow regression coverage.

## 1.0.0-rc.54 - 2026-07-28

- Moved walk-in opening controls into the selected table area so employees choose party size and sales ownership without leaving the floor context.
- Kept employees on the live floor after a successful opening and automatically collapsed the completed selection.
- Separated store-wide management visibility from configured table-operating responsibility.
- Hid unassigned areas from the employee floor and enforced the same responsibility boundary for direct API and AI-assisted table openings.
- Updated shared menu-search browser acceptance to allow multiple relevant products while preserving exact specification search.

## 1.0.0-rc.53 - 2026-07-28

- Decoupled walk-in seating from public reservation-area preferences so formal venue tables can open even when their physical area is not a customer-selectable reservation option.
- Changed table capacity from a hard seating limit to an operational recommendation for walk-ins, reservations and waitlist guests.
- Added visible extra-seat feedback and immutable capacity, actual-party-size and extra-seat evidence to table-opening audits.
- Reset the suggested party size when employees switch tables to prevent the previous table's headcount from carrying into the next operation.

## 1.0.0-rc.52 - 2026-07-28

- Added configurable L0-L3 service workflows for zero-action guest context, one-tap quick service, two-step accountable tasks and controlled high-risk transactions.
- Added duplicate request merging, actual-completer evidence and safe backup or cross-area completion for configured low-risk services.
- Simplified table-context ordering, complimentary ordering, account access and busy-shift task presentation.
- Split fulfillment into ready-to-serve, made-to-order, service-only and no-fulfillment paths with combined completion and delivery for multi-role staff.
- Added normalized service and fulfillment projection fields plus migration 020.
- Retired I01-I03 and the legacy interactive area from runtime operations while retaining archived history for analysis.

## 1.0.0-rc.51 - 2026-07-28

- Restored the normal-order and complimentary-order controls as a consistent pair in staff-assisted ordering.
- Added explicit configuration guidance when an employee can see the complimentary-order control but lacks a valid personal authority.
- Extended known built-in M-BOX commerce authorities once so manager, supervisor and owner permissions no longer expire with the original seed shift.
- Preserved administrator-configured limits, product scopes, cumulative controls and later validity changes after the one-time migration.
- Allowed the system administrator to configure audited commerce authorities without granting payment or complimentary-order execution rights.
- Added browser coverage for 李艳, an authorized server and an unauthorized server, including the zero-payment complimentary workflow.

## 1.0.0-rc.50 - 2026-07-28

- Added the venue-owned 2026 floor plan and a configurable 61-table catalogue covering VIP, L, A, B, C, S, special and outdoor areas.
- Corrected the duplicated W5 and W10 labels in the supplied visual source to unique W06 and W11 table codes.
- Added a non-destructive layout migration that preserves occupied and reserved tables, retains legacy I tables until idle and expands staff area assignments.
- Integrated the previously unshipped configurable employee gift-policy controls and protected fullscreen staff-assisted ordering.
- Updated the service worker media policy and responsive layout presentation for the new floor-plan asset.

## 1.0.0-rc.49 - 2026-07-28

- Fixed configuration draft saves when legacy service types omit the optional guest-visibility field.
- Preserved the distinction between an omitted visibility setting and an explicit true or false value without introducing non-serializable runtime fields.
- Added a regression test that saves the same configuration shape used by live operations and verifies the complete runtime state remains PostgreSQL-serializable.

## 1.0.0-rc.48 - 2026-07-28

- Fixed the guest all-drinks view so category-compatible products remain visible even when legacy or imported records are missing a beverage-family value.
- Added deterministic beverage-family inference plus server-side validation that prevents new guest-visible drink products from being published without a specific drink type.
- Replaced the misleading empty menu shown for expired or revoked table sessions with a dedicated full-width rescan state.
- Constrained the guest ordering shell and menu workspace to the mobile viewport, with WeChat Android browser coverage for category changes and horizontal overflow.
- Made Playwright API and web ports configurable so concurrent worktrees can run isolated browser verification.

## 1.0.0-rc.47 - 2026-07-27

- Added an optional order-level fulfillment note to guest and staff-assisted ordering, with a 300-character server-side limit and idempotency conflict protection.
- Propagated one immutable note snapshot through the order, KDS tasks, delivery task, print jobs, cashier table account and guest order history.
- Highlighted important notes at every responsible handoff so bar, kitchen, runner, cashier and manager can see the same instruction without relying on verbal relay.
- Added integration coverage for guest ordering, staff-assisted ordering, KDS creation, print jobs and delivery task propagation.

## 1.0.0-rc.46 - 2026-07-27

- Added the customer menu sales path with three comparable tonight recommendations, optional quick selection, restrained shake discovery, normal category browsing, search and product details.
- Added a versioned 81-product V2/V3 menu catalog, real cocktail and bottle costs, conservative food/component cost caps and automatic bundle cost rollups.
- Added one-time catalog migration with SKU upsert, valid bundle references, audit evidence and protection for later administrator changes.
- Expanded bundle orders into auditable fulfillment component lines without double-counting customer revenue, discounts or performance attribution.
- Added guest recommendation behavior events for impressions, answers, reranking, product details, acceptance and cart abandonment.
- Improved menu and product administration, mobile quantity controls, combination presentation and customer/staff ordering layouts.

## 1.0.0-rc.45 - 2026-07-26

- Added permission-scoped conversational operations analytics for natural-language management queries without exposing unrestricted SQL.
- Added migration `018_analytics_query_foundation.sql` and normalized analytics indexes for business-day, table, product, customer and employee dimensions.
- Made high-frequency guest, reservation and waitlist actions respond immediately while preserving asynchronous submission, idempotency and failure recovery.
- Refined customer haptics so browsing and quantity changes remain quiet while deliberate service, order, song and payment confirmations use restrained feedback.
- Added release metadata gates that keep package, lockfile, release notes, changelog and Git tags aligned before a release can pass CI.
- Added tag-triggered CI and automatic GitHub pre-release creation after all checks, browser flows, database verification and container build succeed.

## 1.0.0-rc.1 - 2026-07-14

- Delivered configurable service SOPs, table responsibility routing, proactive not-ordered care, complaints, customer feedback, and SLA escalation.
- Delivered order/KDS/table ledger, configurable discount and gift authority, payment/refund evidence, physical POS reporting, member benefits, notifications, paid songs, reservations, inventory, and bottle storage.
- Added signed table QR sessions, production employee sessions, WeChat identity boundary, mini-program customer flows, and responsive PC/tablet/mobile operation surfaces.
- Added PostgreSQL migrations with forced RLS, CAS aggregate storage, immutable revision journal, migration checksums, backup/restore, non-root container, CI, metrics, and readiness probes.
- Added inventory consumption for managed sale and gift orders with transaction rollback and idempotent replay.

This is a release candidate for controlled staging and store shadow operation. Payment-provider live money tests, WeChat review, cloud TLS/PITR, external security assessment, formal master-data import, and store acceptance remain release gates.
