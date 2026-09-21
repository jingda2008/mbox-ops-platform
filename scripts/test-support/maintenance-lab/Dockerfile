FROM postgres:16-bookworm AS pgtools
FROM node:24-bookworm
COPY --from=pgtools /usr/lib/postgresql/16/bin/pg_dump /usr/local/bin/pg_dump
COPY --from=pgtools /usr/lib/postgresql/16/bin/pg_restore /usr/local/bin/pg_restore
COPY --from=pgtools /usr/lib/postgresql/16/bin/psql /usr/local/bin/psql
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus docker.io postgresql-client jq openssh-server rsync libnss3-tools ca-certificates curl git && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /etc/docker && printf '{"storage-driver":"vfs","iptables":true}\n' > /etc/docker/daemon.json
RUN npm install --global @playwright/test@1.61.1 && playwright install --with-deps chromium
RUN systemctl enable ssh.service docker.service && pg_dump --version
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
