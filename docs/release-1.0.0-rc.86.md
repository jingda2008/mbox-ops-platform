# M-BOX 1.0.0-rc.86

## Scope

This candidate fixes the payment-domain ingress installation failure observed
while deploying `rc.85`. It changes certificate handling and readiness
verification only. Provider payment remains disabled.

## Ingress correction

- Alibaba Cloud certificate archives may include a self-signed root certificate.
  The installer now serves only the domain certificate and intermediate chain.
- The installer waits for the reloaded TLS listener with a bounded retry instead
  of treating the first sub-second handshake as the final result.
- A failed installation restores the previous Caddyfile, domain snippet,
  certificate and private key as one unit.
- The successful result reports input, served and removed certificate counts for
  release evidence without exposing certificate contents or private keys.

## Acceptance boundary

The payment callback domain must return the live endpoint through the expected
certificate and reject unsigned callback requests. Real acquiring remains
blocked until the matching Postar public key, confirmed channel environment and
an explicitly authorized one-yuan transaction window are available.
