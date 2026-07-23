# Alibaba Cloud validation ingress

`Caddyfile.validation-ip` is a validation-only HTTPS entry point for the
Shanghai ECS instance. It requests a Let's Encrypt short-lived certificate for
the public IPv4 address and renews it automatically.

The IP address must stay allocated to this instance, and inbound TCP ports 80
and 443 must remain open so ACME renewal can complete. Caddy data must persist
across container replacements.

This is not the commercial domain configuration. Before production launch:

1. complete ICP filing for the owned domain;
2. point the filed domain to the production ingress;
3. replace the IP site address with the filed domain;
4. update `MBOX_PUBLIC_BASE_URL`, `MBOX_GUEST_BASE_URL`,
   `MBOX_CORS_ORIGINS`, payment callbacks, WeChat legal domains and permanent
   table QR files;
5. verify certificate renewal, real payment callbacks and WeChat device flows.
