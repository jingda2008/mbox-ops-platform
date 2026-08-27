# M-BOX 1.0.0-rc.146

## Scope

This candidate supersedes `1.0.0-rc.145` for paid Superhigh activity recovery.
The production topology now trusts exactly one reverse-proxy hop so payment
providers receive the customer address forwarded by Caddy instead of the app
container address. A different production hop count is rejected during runtime
configuration validation.

Xingyi/Postar payment rejection details are classified into bounded internal
diagnostics and safe public outcomes for WeChat identity, network risk,
merchant configuration and provider rejection. Provider text is not returned
to customers or persisted as the public error code. An unknown result remains
query-first and cannot be treated as unpaid.

The mini-program can refresh a rejected WeChat payment identity and begin a new
registration attempt after the server has confirmed that no provider order was
accepted. The already uploaded experience version is separate from this backend
release and does not itself prove a real payment result.

## Acceptance boundary

Automated evidence covers production runtime configuration, one-hop client-IP
resolution, Xingyi/Postar rejection classification, activity-payment error
mapping, mini-program recovery copy, the normalized service suite and the
production build. This release adds no database migration; the expected schema
remains `145`.

Real WeChat JSAPI collection, provider callback/query, customer-device network,
refund settlement and daily reconciliation remain controlled production
acceptance work. A successful deployment or mini-program upload is not evidence
that a real customer payment completed.

## Production route

Deploy only through the approved release script with immutable tag and image
verification, backup/readback, candidate health, Caddy cutover, rollback
safeguards and public-route checks. Post-switch evidence must record the exact
commit, image digest, schema `145`, production tier and worker health.

## Deployment evidence

Not yet deployed. Immutable tag, CI, image, backup/readback and post-switch
evidence will be recorded only after the release gate passes.
