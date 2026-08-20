# M-BOX 1.0.0-rc.97

## Scope

This candidate supersedes `1.0.0-rc.96`. The `rc.96` tag and release workflow
passed, but the first production activation exposed a release-host boundary:
the active production worker adapter was an immutable read-only host mount and
was not passed to the zero-traffic candidate. The candidate therefore failed
closed before cutover; the previous application remained healthy.

## Production adapter correction

- Reads the configured adapter module only from the normalized runtime
  environment and requires it to live below `/app/worker-adapters`.
- Resolves exactly one read-only adapter mount from the currently active
  container and only accepts a source below an immutable release directory.
- Rejects symbolic links, non-root ownership and group/other writable adapter
  modules before database migration or provisioning.
- Copies the verified adapter directory into the new release, mounts it
  read-only in the zero-traffic and post-contract candidates, and records the
  module and deterministic tree SHA-256 in deployment evidence.

## Release failure handling

- Uses an awk-compatible maintenance-secret allowlist and continues to reject
  undeclared keys.
- Candidate health failures now enter the normal automatic rollback path and
  produce current-state evidence instead of bypassing the trap with a direct
  shell exit.

## Acceptance boundary

This release deploys the normalized staff web, server and database bundle. It
does not upload or publish a WeChat mini-program package. Real payment/refund,
real-device WeChat authorization and physical menu/inventory acceptance remain
separate evidence.
