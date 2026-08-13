#!/usr/bin/env bash
set -euo pipefail

container="mbox-pg-rc68-mixed-$$"
api1=""
api2=""
postgres_port="${MBOX_LOCAL_LOAD_POSTGRES_PORT:-}"
api_port_1="${MBOX_LOCAL_LOAD_API_PORT_1:-}"
api_port_2="${MBOX_LOCAL_LOAD_API_PORT_2:-}"
artifact_dir="${MBOX_LOCAL_LOAD_ARTIFACT_DIR:-artifacts/runtime-quality-mixed}"
postgres_image="${MBOX_LOAD_POSTGRES_IMAGE:-postgres:16-alpine}"
load_lock=".runtime/rc68-load.lock"
owns_load_lock=0
load_run_id="${MBOX_LOAD_RUN_ID:-standalone-$$}"
load_reference_time="${MBOX_LOAD_REFERENCE_TIME:-$(node scripts/load-reference-time.mjs)}"
load_operational_time="${MBOX_LOAD_OPERATIONAL_TIME:-$(node -e 'process.stdout.write(new Date().toISOString())')}"

cleanup() {
  if [ -n "$api1" ]; then kill -TERM "$api1" 2>/dev/null || true; fi
  if [ -n "$api2" ]; then kill -TERM "$api2" 2>/dev/null || true; fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  if [ "$owns_load_lock" = "1" ]; then rmdir "$load_lock" 2>/dev/null || true; fi
}
trap cleanup EXIT

mkdir -p .runtime
if [ "${MBOX_LOAD_LOCK_HELD:-0}" != "1" ]; then
  if ! mkdir "$load_lock" 2>/dev/null; then
    echo "another RC68 load run owns $load_lock" >&2
    exit 1
  fi
  owns_load_lock=1
fi

# Never measure stale dist-server output from a previous source revision. A
# release SHA can be injected at runtime, so it does not prove that dist-server
# was built from the current (possibly dirty) source tree.
build_marker=".runtime/rc68-load-build-source.json"
current_build_fingerprint="$(node scripts/build-source-fingerprint.mjs)"
current_build_environment="$(node scripts/build-source-fingerprint.mjs --environment)"
if [ "${MBOX_LOCAL_LOAD_SKIP_BUILD:-0}" = "1" ]; then
  if ! node scripts/build-source-fingerprint.mjs --verify "$build_marker" >/dev/null 2>&1; then
    echo "refusing stale build: source, build environment, output, or provenance tool does not match $build_marker" >&2
    exit 1
  fi
else
  npm run build:legacy >/tmp/mbox-rc68-mixed-build.log
  node scripts/build-source-fingerprint.mjs --write "$build_marker" \
    --expected-source "$current_build_fingerprint" \
    --expected-environment "$current_build_environment" >/dev/null
fi
load_source_sha="$(git rev-parse HEAD)"

allocate_port() {
  node -e 'const net=require("node:net");const server=net.createServer();server.listen(0,"127.0.0.1",()=>{process.stdout.write(String(server.address().port));server.close()})'
}
if [ -z "$api_port_1" ]; then api_port_1="$(allocate_port)"; fi
if [ -z "$api_port_2" ]; then api_port_2="$(allocate_port)"; fi
while [ "$api_port_2" = "$api_port_1" ]; do api_port_2="$(allocate_port)"; done

postgres_publish=(--publish "127.0.0.1::5432")
if [ -n "$postgres_port" ]; then postgres_publish=(--publish "127.0.0.1:$postgres_port:5432"); fi
docker run -d --name "$container" \
  -e POSTGRES_USER=mbox -e POSTGRES_PASSWORD=mbox_test -e POSTGRES_DB=mbox_load \
  "${postgres_publish[@]}" "$postgres_image" >/dev/null
if [ -z "$postgres_port" ]; then
  postgres_port="$(docker port "$container" 5432/tcp | sed -E 's/^.*:([0-9]+)$/\1/' | tail -n 1)"
  if ! [[ "$postgres_port" =~ ^[0-9]+$ ]]; then echo "postgres dynamic port unavailable" >&2; exit 1; fi
fi
for attempt in $(seq 1 60); do
  # pg_isready can succeed while the image entrypoint is still creating the
  # requested database. Prove the exact database is queryable before migrating.
  if docker exec "$container" psql -U mbox -d mbox_load -Atqc "SELECT 1" >/dev/null 2>&1; then break; fi
  if [ "$attempt" = 60 ]; then echo "postgres not ready" >&2; exit 1; fi
  sleep 0.5
done

docker exec "$container" psql -U mbox -d mbox_load -v ON_ERROR_STOP=1 -c \
  "CREATE ROLE mbox_app LOGIN PASSWORD 'mbox_app_test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"
export DATABASE_URL="postgresql://mbox:mbox_test@127.0.0.1:$postgres_port/mbox_load"
npm run db:migrate >/tmp/mbox-rc68-mixed-migrate.log
docker exec "$container" psql -U mbox -d mbox_load -v ON_ERROR_STOP=1 -c \
  "GRANT USAGE ON SCHEMA mbox TO mbox_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mbox TO mbox_app; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA mbox TO mbox_app;"

MBOX_LOAD_REFERENCE_TIME="$load_reference_time" \
MBOX_LOAD_OPERATIONAL_TIME="$load_operational_time" \
  node scripts/prepare-rc68-load-state.mjs >/tmp/mbox-rc68-mixed-prepare.log
MBOX_CONFIRM_PROVISION=PROVISION \
MBOX_INITIAL_STATE_PATH=.runtime/rc68-load-state.json \
MBOX_TENANT_ID=11111111-1111-4111-8111-111111111111 \
MBOX_STORE_UUID=22222222-2222-4222-8222-222222222222 \
MBOX_TENANT_CODE=local-load MBOX_TENANT_NAME='Local Load' MBOX_STORE_CODE=mbox-lujiazui \
node dist-server/server/provision-runtime.js >/tmp/mbox-rc68-mixed-provision.log

rm -rf "$artifact_dir"
mkdir -p "$artifact_dir"
database_pool_max=10
mutation_queue_max=100
mutation_queue_wait_ms=15000
state_read_cache_ms=3000
MBOX_LOAD_PHASE="${MBOX_LOAD_PHASE:-all}" \
MBOX_LOAD_INSTANCES=2 \
MBOX_LOAD_POSTGRES_IMAGE="$postgres_image" \
MBOX_LOAD_POSTGRES_PORT="$postgres_port" \
MBOX_LOAD_API_PORT_1="$api_port_1" \
MBOX_LOAD_API_PORT_2="$api_port_2" \
MBOX_LOAD_RUN_ID="$load_run_id" \
MBOX_LOAD_REFERENCE_TIME="$load_reference_time" \
MBOX_LOAD_OPERATIONAL_TIME="$load_operational_time" \
MBOX_DATABASE_POOL_MAX="$database_pool_max" \
MBOX_DATABASE_MUTATION_QUEUE_MAX="$mutation_queue_max" \
MBOX_DATABASE_MUTATION_QUEUE_WAIT_MS="$mutation_queue_wait_ms" \
MBOX_STATE_READ_CACHE_MS="$state_read_cache_ms" \
MBOX_LOAD_ENVIRONMENT_MANIFEST_PATH="$artifact_dir/environment-manifest.json" \
  node scripts/write-load-environment-manifest.mjs >/dev/null
common_env=(
  MBOX_RUNTIME_MODE=staging
  MBOX_LOAD_RUN_ID="$load_run_id"
  MBOX_REPOSITORY=postgres
  MBOX_TENANT_ID=11111111-1111-4111-8111-111111111111
  MBOX_STORE_UUID=22222222-2222-4222-8222-222222222222
  MBOX_SESSION_SECRET=rc68-ci-session-secret-0123456789abcdef
  MBOX_QR_SECRET=rc68-qr-secret-0123456789abcdef0123456789abcdef
  MBOX_METRICS_TOKEN=rc68-ci-metrics-token-0123456789abcdef
  MBOX_CORS_ORIGINS=http://127.0.0.1:5173
  MBOX_PILOT_ACCESS_CODE=MBOX521
  'MBOX_PILOT_EMPLOYEE_PINS_JSON={"emp-operations-director":"7001","emp-admin":"7002","emp-host":"7003","emp-mia":"7004","emp-chen":"7005","emp-qing":"7006","emp-cashier":"7007","emp-lin":"7008","emp-wu":"7009","emp-jie":"7010","emp-han":"7011","emp-tao":"7012"}'
  'MBOX_LOAD_STAFF_PINS_JSON={"emp-operations-director":"7001","emp-admin":"7002","emp-host":"7003","emp-mia":"7004","emp-chen":"7005","emp-qing":"7006","emp-cashier":"7007","emp-lin":"7008","emp-wu":"7009","emp-jie":"7010","emp-han":"7011","emp-tao":"7012"}'
  MBOX_DATABASE_POOL_MAX="$database_pool_max"
  MBOX_DATABASE_MUTATION_QUEUE_MAX="$mutation_queue_max"
  MBOX_DATABASE_MUTATION_QUEUE_WAIT_MS="$mutation_queue_wait_ms"
  MBOX_STATE_READ_CACHE_MS="$state_read_cache_ms"
  MBOX_RELEASE_SHA="$load_source_sha"
  MBOX_RELEASE_IMAGE_DIGEST=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
)
app_database_url="postgresql://mbox_app:mbox_app_test@127.0.0.1:$postgres_port/mbox_load"

env "${common_env[@]}" DATABASE_URL="$app_database_url" API_PORT="$api_port_1" \
  node dist-server/server/index.js > "$artifact_dir/instance-1.log" 2>&1 &
api1=$!
env "${common_env[@]}" DATABASE_URL="$app_database_url" API_PORT="$api_port_2" \
  node dist-server/server/index.js > "$artifact_dir/instance-2.log" 2>&1 &
api2=$!

for endpoint in "$api_port_1:$api1:$artifact_dir/instance-1.log" "$api_port_2:$api2:$artifact_dir/instance-2.log"; do
  IFS=: read -r port pid log_path <<<"$endpoint"
  for attempt in $(seq 1 120); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "api $port exited before readiness" >&2
      tail -100 "$log_path" >&2 || true
      exit 1
    fi
    ready_payload="$(curl --silent --show-error "http://127.0.0.1:$port/api/ready" 2>/dev/null || true)"
    if READY_PAYLOAD="$ready_payload" EXPECTED_SHA="$load_source_sha" node -e '
      try {
        const payload = JSON.parse(process.env.READY_PAYLOAD || "null")
        process.exit(payload?.status === "ready" && payload?.releaseSha === process.env.EXPECTED_SHA ? 0 : 1)
      } catch { process.exit(1) }
    '; then break; fi
    if [ "$attempt" = 120 ]; then echo "api $port not ready for source $load_source_sha" >&2; exit 1; fi
    sleep 0.5
  done
done

set +e
env "${common_env[@]}" \
  MBOX_LOAD_PHASE="${MBOX_LOAD_PHASE:-all}" \
  MBOX_LOAD_BASE_URLS="http://127.0.0.1:$api_port_1,http://127.0.0.1:$api_port_2" \
  MBOX_LOAD_REPORT_PATH="$artifact_dir/client-observed-load.json" \
  npm run --silent test:load:rc68 >"$artifact_dir/client-load-console.log" 2>&1
load_status=$?
cat "$artifact_dir/client-load-console.log"
phase="${MBOX_LOAD_PHASE:-all}"
browser_status=0
case "$phase" in
  staff_start)
    MBOX_BROWSER_STARTUP_MODE=staff \
    MBOX_LOAD_BASE_URLS="http://127.0.0.1:$api_port_1,http://127.0.0.1:$api_port_2" \
    MBOX_BROWSER_STARTUP_REPORT_PATH="$artifact_dir/browser-startup.json" \
      node scripts/measure-browser-startup.mjs >"$artifact_dir/browser-startup-console.log" 2>&1 || browser_status=$?
    cat "$artifact_dir/browser-startup-console.log" ;;
  reads)
    MBOX_BROWSER_STARTUP_MODE=guest \
    MBOX_LOAD_BASE_URLS="http://127.0.0.1:$api_port_1,http://127.0.0.1:$api_port_2" \
    MBOX_BROWSER_STARTUP_REPORT_PATH="$artifact_dir/browser-startup.json" \
    MBOX_QR_SECRET=rc68-qr-secret-0123456789abcdef0123456789abcdef \
      node scripts/measure-browser-startup.mjs >"$artifact_dir/browser-startup-console.log" 2>&1 || browser_status=$?
    cat "$artifact_dir/browser-startup-console.log" ;;
esac
source_drift_status=0
final_build_fingerprint="$(node scripts/build-source-fingerprint.mjs)"
if [ "$final_build_fingerprint" != "$current_build_fingerprint" ]; then
  source_drift_status=1
  printf '{"status":"invalid","reason":"source_changed_during_measurement","startedWith":"%s","endedWith":"%s"}\n' \
    "$current_build_fingerprint" "$final_build_fingerprint" > "$artifact_dir/source-drift.json"
  echo "测试期间源码发生变化；本轮性能结果只可诊断，不得作为发布证据" >&2
fi
case "$phase" in
  reads) mutation_minimum_samples=0 ;;
  staff_start) mutation_minimum_samples=50 ;;
  *) mutation_minimum_samples=100 ;;
esac
metrics_status=0
if [ "$source_drift_status" -eq 0 ]; then
  env "${common_env[@]}" \
    MBOX_MUTATION_MINIMUM_SAMPLES="${MBOX_MUTATION_MINIMUM_SAMPLES:-$mutation_minimum_samples}" \
    MBOX_METRICS_BASE_URLS="http://127.0.0.1:$api_port_1,http://127.0.0.1:$api_port_2" \
    MBOX_METRICS_REPORT_PATH="$artifact_dir/runtime-metrics.json" \
    npm run metrics:verify
  metrics_status=$?
else
  metrics_status=1
fi

kill -TERM "$api1" "$api2"
wait "$api1" "$api2" || true
api1=""
api2=""
log_gate_routes=()
log_gate_sample_args=()
case "$phase" in
  staff_start)
    log_gate_routes+=(--required-route 'POST /api/auth/pilot-login' --required-route 'GET /api/bootstrap')
    log_gate_sample_args+=(--minimum-slo-samples 120) ;;
  reads)
    log_gate_routes+=(--required-route 'GET /api/bootstrap' --required-route 'GET /api/reservations' \
      --required-route 'POST /api/auth/presence/heartbeat' --required-route 'POST /api/guest/session') ;;
  create_task_live) log_gate_routes+=(--required-route 'POST /api/tasks') ;;
  create_quick_order_live) log_gate_routes+=(--required-route 'POST /api/commerce/quick-orders') ;;
  task_action) log_gate_routes+=(--required-route 'POST /api/tasks/:taskId/actions') ;;
  kds_start|kds_complete) log_gate_routes+=(--required-route 'POST /api/commerce/kds/:taskId/actions') ;;
esac
node scripts/analyze-runtime-logs.mjs \
  --input "$artifact_dir/instance-1.log" --input "$artifact_dir/instance-2.log" \
  "${log_gate_routes[@]}" "${log_gate_sample_args[@]}" \
  --test-stage measured --test-phase "$phase" --fail-on-slo \
  > "$artifact_dir/server-observed-log-analysis.json"
logs_status=$?
set -e

if [ -f "$artifact_dir/client-observed-load.json" ]; then
  node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync(process.argv[1])); console.log(JSON.stringify({model:r.model,totals:r.totals,passed:r.passed,metrics:Object.fromEntries(Object.entries(r.byLabel).map(([k,v])=>[k,{p95Ms:v.p95Ms,p99Ms:v.p99Ms,passed:v.passed}]))},null,2))" \
    "$artifact_dir/client-observed-load.json"
fi

if [ "$load_status" -ne 0 ] || [ "$browser_status" -ne 0 ] || [ "$metrics_status" -ne 0 ] || [ "$logs_status" -ne 0 ] || [ "$source_drift_status" -ne 0 ]; then
  echo "RC68本地性能门禁失败：load=$load_status browser=$browser_status metrics=$metrics_status logs=$logs_status source_drift=$source_drift_status" >&2
  exit 1
fi
