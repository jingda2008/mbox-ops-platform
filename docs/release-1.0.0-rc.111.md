# M-BOX 1.0.0-rc.111

## Scope

This candidate carries the merged normalized staff, service and database scope
through migration `098`, including the staff brand-green visual update. It does
not build, upload or overwrite the WeChat mini-program package.

## Release correction

- Handles both valid forms produced by the frozen Docker archive: an OCI image
  index selecting linux/amd64, or a directly tagged single-platform manifest.
- Reads the platform configuration digest from the selected manifest and still
  requires it to equal Docker's loaded immutable image ID.
- Rejects unknown media types and retains the separate archive/reference digest
  and platform image identity introduced by rc.110.

## Incident boundary

The rc.110 tag workflow completed the application, database, browser and
performance gates, then stopped while packaging the deployment image because
the reference blob was a direct manifest rather than an OCI index. No rc.110
release bundle was deployed. Production therefore remained on rc.104 and
schema 098.

## Production route

The public origin remains `https://mbox.shmbox.com`. Deployment reaches the
production origin through the payment-server jump path to `10.100.80.223:22`.
The payment server relays immutable OSS evidence using its short-lived RAM role;
no cloud credential is added to the application host or runtime container.

## Verification boundary

The candidate requires focused release tests, the complete local check, pull-
request CI, tag CI, immutable bundle verification, evidence relay, candidate
private/deep-route verification and final public readiness. Any digest or
target-identity mismatch remains fail-closed.
