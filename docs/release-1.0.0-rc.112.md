# M-BOX 1.0.0-rc.112

## Scope

This candidate carries the merged normalized staff, service and database scope
through migration `098`, including the staff brand-green visual update. It does
not build, upload or overwrite the WeChat mini-program package.

## Release correction

- Computes immutable worker-adapter tree evidence from a sorted NUL-delimited
  stream of relative paths, Unix modes and file-content SHA-256 values.
- Uses `find`, `sort -z`, `stat` and `sha256sum`, all verified on the production
  host, rather than the unavailable GNU tar `--sort` option.
- Continues to reject symbolic links and non-file/non-directory entries before
  mounting the inherited adapter directory read-only into the candidate.

## Incident boundary

The rc.111 production attempt verified configuration, external dependencies and
OSS evidence, then stopped while preparing the inherited worker adapter because
the production host has GNU tar 1.26. The release state records no database
write and no cutover; rc.104 remained healthy with workers enabled.

## Production route

The public origin remains `https://mbox.shmbox.com`. Deployment reaches the
production origin through the payment-server jump path to `10.100.80.223:22`
and uses the payment server only as the immutable OSS evidence relay.

## Verification boundary

The candidate requires focused release tests, the complete local check, pull-
request CI, tag CI, immutable bundle verification, evidence relay, candidate
private/deep-route verification and final public readiness. The host-adapter
hash must complete before any candidate or database action.
