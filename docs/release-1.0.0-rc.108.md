# M-BOX 1.0.0-rc.108

## Scope

This candidate supersedes rc.107 and carries forward the safe prior-business-
day table closure. It updates the normalized staff web, service and deployment
scripts, uses database migrations `001` through `098`, and excludes the WeChat
mini-program package.

## Deployment-target correction

- A production release must explicitly supply both its SSH target and public
  HTTPS origin. The validation server is no longer a silent production default.
- Before uploading a release or writing the database, the operator connects
  read-only to the selected target and resolves both the SSH host and public
  origin from that server.
- The release is rejected unless the address sets intersect. The current
  transaction does not claim to manage an independent CDN or reverse-proxy
  server, so an external edge cannot be bypassed with an override.
- Candidate, cutover, rollback, immutable image and public shell verification
  remain unchanged and fail closed.

## Previous failed attempt

rc.107 passed tag CI and immutable release construction. Its production attempt
connected to `139.224.254.60`, while the requested operating origin
`mbox.shmbox.com` resolved publicly to `139.196.99.138`. Both happened to serve
the same rc.104 identity before deployment, so the old preflight did not expose
the topology mismatch. The public origin remained on rc.104 and the transaction
automatically restored the changed server to rc.104. No new migration existed.

## Verification boundary

The candidate requires release-order/failure tests, normalized server/web type
checks, production build, quality metadata checks, tag CI, immutable image
evidence and a successful release against the actual operating host. Store-side
operating acceptance and real payment evidence remain separate requirements.
