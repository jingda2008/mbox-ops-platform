# M-BOX 1.0.0-rc.85

## Scope

This candidate prepares the normalized payment path for a controlled first
Postar transaction. It adds active query recovery, payment-domain TLS ingress
and employee guidance without enabling production payment or initiating a real
charge.

## Payment safety

- An uncertain QR or barcode payment is queried by its original payment ID and
  Beijing creation date instead of creating another payment.
- Signed query results must match the expected amount and currency.
- A successful query creates one reconciliation entry; a replay is a no-op.
- Pending results remain pending, while verified failed or closed results allow
  a new controlled payment attempt.
- Refund approval remains human-controlled. Real provider refund completion
  still requires a verified provider callback or query.

## Ingress

- `pay.shmbox.com` is added through a versioned server script rather than a
  manual Caddy edit.
- The script verifies hostname, certificate lifetime, key pairing, Caddy
  syntax and the reverse-proxied live endpoint before reporting success.
- Certificate and private-key files stay on the server, are never bundled in
  the image, and the previous Caddyfile can be restored without rebuilding.

## Acceptance boundary

Automated checks cover the code path, configuration contract and ingress
installer. This release must keep provider payment disabled until the matching
Postar public key, confirmed channel environment and explicitly authorized
one-yuan acceptance window are available. No real transaction is part of this
candidate deployment.
