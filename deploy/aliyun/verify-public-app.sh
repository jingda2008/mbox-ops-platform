#!/usr/bin/env bash
set -euo pipefail

public_url=${1:?public URL is required}
expected_sha=${2:?expected release SHA is required}
expected_digest=${3:?expected image digest is required}
expected_schema_version=${4:?expected schema version is required}
expected_tier=${5:?expected deployment tier is required}
attempts=${6:-15}
require_extended_identity=${7:-1}

public_url=${public_url%/}
[[ "${expected_sha}" =~ ^[0-9a-f]{40}$ ]]
[[ "${expected_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "${expected_schema_version}" =~ ^[0-9]+$ ]]
[[ "${attempts}" =~ ^[0-9]+$ ]]
[ "${attempts}" -ge 1 ] && [ "${attempts}" -le 30 ]
case "${require_extended_identity}" in 0|1) ;; *) exit 1 ;; esac
case "${expected_tier}" in validation|production) ;; *) exit 1 ;; esac

browser_accept='text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
browser_user_agent='Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36 MBOXReleaseVerifier/1.0'

verify_app_shell() {
  local route=$1
  local body
  local headers
  local status
  local asset
  local asset_headers
  local asset_status
  local build_identity_valid=0
  local valid=0
  body=$(mktemp)
  headers=$(mktemp)
  asset_headers=$(mktemp)

  status=$(curl -sS --max-time 5 \
    -H "Accept: ${browser_accept}" \
    -H "User-Agent: ${browser_user_agent}" \
    -D "${headers}" -o "${body}" -w '%{http_code}' \
    "${public_url}${route}" 2>/dev/null || true)
  if grep -Eq "<meta name=\"mbox-build-commit\" content=\"${expected_sha}\"[[:space:]]*/?>" "${body}"; then
    build_identity_valid=1
  elif [ "${require_extended_identity}" = 0 ] \
    && ! grep -Eq '<meta name="mbox-build-commit" content="[^"]+"[[:space:]]*/?>' "${body}"; then
    build_identity_valid=1
  fi
  if [ "${status}" = 200 ] \
    && grep -Eiq '^content-type:[[:space:]]*text/html([[:space:]]*;|[[:space:]]*$)' "${headers}" \
    && [ "${build_identity_valid}" = 1 ] \
    && grep -Fq '<div id="root"></div>' "${body}" \
    && grep -Eq '<script[^>]+type="module"[^>]+src="/assets/[^"]+\.js"' "${body}"; then
    asset=$(grep -Eo 'src="/assets/[^"]+\.js"' "${body}" \
      | head -n 1 | sed -E 's/^src="([^"]+)"$/\1/')
    asset_status=$(curl -sS --max-time 5 \
      -H 'Accept: application/javascript,text/javascript,*/*;q=0.1' \
      -H "User-Agent: ${browser_user_agent}" \
      -D "${asset_headers}" -o /dev/null -w '%{http_code}' \
      "${public_url}${asset}" 2>/dev/null || true)
    if [ "${asset_status}" = 200 ] \
      && grep -Eiq '^content-type:[[:space:]]*(application|text)/(javascript|x-javascript)' "${asset_headers}"; then
      valid=1
    fi
  fi
  rm -f "${body}" "${headers}" "${asset_headers}"
  [ "${valid}" = 1 ]
}

verify_all_app_shells() {
  local route
  local pid
  local ok=1
  local pids=()
  for route in '/' '/guest?table=W01' '/reserve' '/staff/live'; do
    verify_app_shell "${route}" &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do
    wait "${pid}" || ok=0
  done
  [ "${ok}" = 1 ]
}

target_route_failures=0
for _ in $(seq 1 "${attempts}"); do
  response=$(curl -fsS --max-time 5 \
    -H 'Accept: application/json' \
    -H 'User-Agent: mbox-release-verifier/1.0' \
    "${public_url}/api/ready" 2>/dev/null || true)
  if printf '%s' "${response}" | jq -e \
    --arg sha "${expected_sha}" \
    --arg digest "${expected_digest}" \
    --arg schemaFlavor 'normalized-core-v1' \
    --arg deploymentTier "${expected_tier}" \
    --argjson schemaVersion "${expected_schema_version}" \
    --argjson requireExtendedIdentity "${require_extended_identity}" \
    '.status == "ready"
      and .schemaFlavor == $schemaFlavor
      and (.schemaVersion | tonumber) >= $schemaVersion
      and .commitSha == $sha
      and (($requireExtendedIdentity == 0) or .releaseImageDigest == $digest)
      and (($requireExtendedIdentity == 0) or .deploymentTier == $deploymentTier)' >/dev/null 2>&1 \
    >/dev/null 2>&1; then
    verify_all_app_shells && exit 0
    target_route_failures=$((target_route_failures + 1))
    if [ "${target_route_failures}" -ge 2 ]; then
      printf 'public application shell verification failed twice for release %s\n' "${expected_sha}" >&2
      exit 1
    fi
    sleep 0.25
    continue
  fi
  observed_sha=$(printf '%s' "${response}" | jq -r '.commitSha // empty' 2>/dev/null || true)
  if [ "${observed_sha}" = "${expected_sha}" ]; then
    exit 1
  fi
  sleep 2
done

exit 1
