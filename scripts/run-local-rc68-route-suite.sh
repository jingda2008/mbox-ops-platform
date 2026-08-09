#!/usr/bin/env bash
set -u

root_artifact_dir="${MBOX_LOCAL_LOAD_SUITE_ARTIFACT_DIR:-artifacts/runtime-quality}"
phases=(staff_start reads create_task_live create_quick_order_live task_action kds_start kds_complete)
phase_dirs=()
failed=0
load_lock=".runtime/rc68-load.lock"
mkdir -p .runtime
if ! mkdir "$load_lock" 2>/dev/null; then
  echo "another RC68 load run owns $load_lock" >&2
  exit 1
fi
trap 'rmdir "$load_lock" 2>/dev/null || true' EXIT
suite_run_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"

# The first phase builds and records an input fingerprint. Later phases reuse
# that output only while the source fingerprint remains identical.
rm -rf "$root_artifact_dir"
mkdir -p "$root_artifact_dir"

for index in "${!phases[@]}"; do
  phase="${phases[$index]}"
  phase_dir="$root_artifact_dir/$phase"
  skip_build=1
  if [ "$index" = "0" ]; then skip_build=0; fi
  echo "[rc68-route-suite] phase=$phase"
  MBOX_LOAD_PHASE="$phase" \
  MBOX_LOAD_RUN_ID="$suite_run_id" \
  MBOX_LOAD_LOCK_HELD=1 \
  MBOX_LOCAL_LOAD_SKIP_BUILD="$skip_build" \
  MBOX_LOCAL_LOAD_ARTIFACT_DIR="$phase_dir" \
    bash scripts/run-local-rc68-load.sh || failed=1
  if [ -f "$phase_dir/client-observed-load.json" ]; then
    phase_dirs+=(--phase-dir "$phase_dir")
  fi
done

node scripts/merge-rc68-load-reports.mjs \
  "${phase_dirs[@]}" \
  --expected-commit "$(git rev-parse HEAD)" \
  --output "$root_artifact_dir/client-observed-load.json" || failed=1

if [ "$failed" -ne 0 ]; then
  echo "RC68独立路由套件未通过；证据已保留在 $root_artifact_dir" >&2
  exit 1
fi
