# M-BOX 1.0.0-rc.87

## Scope

This candidate fixes the payment-domain ingress bind-mount failure observed
after deploying `rc.86`. It changes Caddy configuration activation and rollback
only. Provider payment remains disabled.

## Ingress correction

- The installer overwrites the bind-mounted Caddyfile in place instead of
  replacing its inode, so the running Caddy container sees the new import.
- Before validation and reload, the installer compares the host candidate
  SHA256 with the Caddy container's visible Caddyfile SHA256.
- Rollback uses the same inode-preserving write and visibility gate.
- Certificate-chain normalization, private-key protection, bounded readiness
  probing and automatic restore from `rc.86` remain in force.

## Acceptance boundary

The payment callback domain must return the live endpoint through the expected
certificate and reject unsigned callback requests. Real acquiring remains
blocked until the matching Postar public key, confirmed channel environment and
an explicitly authorized one-yuan transaction window are available.
