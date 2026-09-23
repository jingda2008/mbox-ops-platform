#!/bin/bash
set -euo pipefail
test -f /.dockerenv
docker image inspect postgres:16-alpine >/dev/null
cat > /usr/local/bin/mbox-pg-client <<'WRAPPER'
#!/bin/bash
set -euo pipefail
tool=$(basename "$0")
case "$tool" in psql|pg_dump|pg_restore) ;; *) exit 64 ;; esac
exec docker run --rm -i --network host --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m --cap-drop ALL --security-opt no-new-privileges --user 0:0 --env HOME=/tmp --env PGSERVICEFILE --env PGPASSFILE --env PGOPTIONS --volume /opt/mbox:/opt/mbox --volume /root/LAB-final:/root/LAB-final --entrypoint "$tool" postgres:16-alpine "$@" 2> >(tee -a /root/LAB-final/private-logs/postgres-client-stderr.log >&2)
WRAPPER
chmod 0755 /usr/local/bin/mbox-pg-client
for tool in psql pg_dump pg_restore; do
 mv "/usr/local/bin/$tool" "/usr/local/bin/$tool.native"
 ln -s /usr/local/bin/mbox-pg-client "/usr/local/bin/$tool"
done
