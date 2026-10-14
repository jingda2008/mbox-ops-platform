# Alibaba public website runtime

This runtime is separate from the staff/backend application. Prepare an empty release directory with `node website/aliyun/prepare-runtime.mjs /absolute/empty/release`, install the locked dependencies with `npm ci --omit=dev`, then run `node --test server.test.mjs`. Run `PUBLIC_ORIGIN=https://www.shmbox.com node server.mjs` behind the existing host-scoped Caddy proxy. No staff secrets or database configuration belong here.

The SSR menu reads the public backend endpoint with a five-minute cache. It uses the same gateway as the legacy website; no employee credentials are forwarded. Static overrides retain the old-origin reservation recovery link in seven languages. Legacy Sites uses its own source and redirects marketing routes only.

Production 2026-10-14: `mbox-public-site-www-v14`, release `/opt/mbox-public-site/releases/20261014-www-canonical-v14`, loopback 8795. Caddy changed only its www public-site upstream. Original public container and `/opt/mbox-public-site/Caddyfile.before-www-v14` remain for rollback. Staff application was not restarted or redeployed.
