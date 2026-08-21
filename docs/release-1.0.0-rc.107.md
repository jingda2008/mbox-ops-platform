# M-BOX 1.0.0-rc.107

## Scope

This candidate supersedes rc.106 and carries forward the safe prior-business-
day table closure. It updates the normalized staff web, service and deployment
scripts, uses database migrations `001` through `098`, and excludes the WeChat
mini-program package.

## Cutover correction

- The release first verifies the candidate's ready state and all staff/customer
  deep routes over the private network.
- At cutover, Caddy is routed to that verified candidate by a fixed private
  address while the previous application remains running and recoverable.
- The public release identity, HTML shells and JavaScript assets must then pass
  before the previous container is stopped or renamed.
- Shell/asset propagation uses the same bounded retry window as readiness; a
  persistent failure still triggers automatic restoration of the prior image.
- After the canonical container name is established, public verification runs
  again, followed by the independent external operator verification.

## Previous failed attempt

rc.106 passed CI and immutable release construction but its production attempt
failed the post-cutover public shell check and automatically restored rc.104.
The failure occurred after backup/configuration work and cutover began; no new
database migration was present. rc.107 does not rewrite that history.

## Verification boundary

The candidate requires release-order/failure tests, normalized server/web type
checks, production build, quality metadata checks, tag CI, immutable image
evidence and successful production public verification. Store-side operating
acceptance and real payment evidence remain separate requirements.
