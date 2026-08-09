#!/usr/bin/env bash
set -u

root_artifact_dir="${MBOX_LOCAL_LOAD_SUITE_ARTIFACT_DIR:-artifacts/runtime-quality}"
phases=(staff_start reads create_task_live create_quick_order_live task_action kds_start kds_complete)
phase_dirs=()
failed=0

# One source build is shared by all phases. Every phase still receives a fresh
# Postgres database and two fresh API processes from run-local-rc68-load.sh.
npm run build >/tmp/mbox-rc68-route-suite-build.log || exit 1
rm -rf "$root_artifact_dir"
mkdir -p "$root_artifact_dir"

for index in "${!phases[@]}"; do
  phase="${phases[$index]}"
  phase_dir="$root_artifact_dir/$phase"
  echo "[rc68-route-suite] phase=$phase"
  MBOX_LOAD_PHASE="$phase" \
  MBOX_LOCAL_LOAD_SKIP_BUILD=1 \
  MBOX_LOCAL_LOAD_ARTIFACT_DIR="$phase_dir" \
  MBOX_LOCAL_LOAD_POSTGRES_PORT="$((55434 + index))" \
  MBOX_LOCAL_LOAD_API_PORT_1="$((18791 + index * 2))" \
  MBOX_LOCAL_LOAD_API_PORT_2="$((18792 + index * 2))" \
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
