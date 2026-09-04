#!/usr/bin/env bash
set -euo pipefail

env_file=${1:?environment file is required}
deployment_tier=${2:?deployment tier is required}
test -f "${env_file}"
case "${deployment_tier}" in validation|production) ;; *) exit 1 ;; esac

get_env() {
  awk -F= -v key="$1" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "${env_file}"
}

set_env() {
  local key=$1 value=$2 temporary
  temporary=$(mktemp "${env_file}.XXXXXX")
  awk -F= -v key="${key}" '$1 != key {print}' "${env_file}" > "${temporary}"
  printf '%s=%s\n' "${key}" "${value}" >> "${temporary}"
  chmod 0600 "${temporary}"
  mv "${temporary}" "${env_file}"
}

delete_env() {
  local temporary
  temporary=$(mktemp "${env_file}.XXXXXX")
  awk -F= -v key="$1" '$1 != key {print}' "${env_file}" > "${temporary}"
  chmod 0600 "${temporary}"
  mv "${temporary}" "${env_file}"
}

set_env MBOX_RUNTIME_CONFIG_VERSION normalized-runtime-config/v1
set_env MBOX_DEPLOYMENT_TIER "${deployment_tier}"
# The managed release topology has exactly one reverse-proxy hop: Caddy -> app.
# Trusting zero hops sends Caddy's container address to risk-sensitive payment
# providers; trusting more than one would let an untrusted forwarded value win.
set_env MBOX_TRUST_PROXY_HOPS 1

legacy_payment_enabled=$(get_env MBOX_POSTAR_ENABLED)
payment_provider=$(get_env MBOX_PAYMENT_PROVIDER)
if [ "${payment_provider}" = postar ] || [ "${legacy_payment_enabled}" = true ]; then
  payment_mode=$(get_env MBOX_PAYMENT_MODE)
  case "${payment_mode}" in test|uat|production) ;;
    *)
      payment_mode=$(get_env POSTAR_ENVIRONMENT)
      [ -n "${payment_mode}" ] || payment_mode=$(get_env MBOX_POSTAR_ENVIRONMENT)
      ;;
  esac
  set_env MBOX_PAYMENT_MODE "${payment_mode:-uat}"
  set_env MBOX_PAYMENT_PROVIDER postar
  for suffix in AGENCY_ID MERCHANT_ID PUBLIC_KEY CALLBACK_URL HTTP_TIMEOUT_MS; do
    canonical="POSTAR_${suffix}"
    value=$(get_env "${canonical}")
    [ -n "${value}" ] || value=$(get_env "MBOX_POSTAR_${suffix}")
    [ -z "${value}" ] || set_env "${canonical}" "${value}"
  done
else
  set_env MBOX_PAYMENT_MODE disabled
  for key in MBOX_PAYMENT_PROVIDER POSTAR_AGENCY_ID POSTAR_MERCHANT_ID POSTAR_PUBLIC_KEY POSTAR_CALLBACK_URL POSTAR_HTTP_TIMEOUT_MS POSTAR_WECHAT_APP_ID POSTAR_WECHAT_TRADE_TYPE; do
    delete_env "${key}"
  done
fi

if [ "$(get_env MBOX_ASSISTANT_PROVIDER)" = qwen ]; then
  set_env MBOX_AI_MODE uat
  set_env MBOX_AI_PROVIDER qwen
  set_env MBOX_AI_ENDPOINT "$(get_env MBOX_QWEN_ENDPOINT)"
  set_env MBOX_AI_MODEL "$(get_env MBOX_QWEN_MODEL)"
  set_env MBOX_AI_API_KEY "$(get_env MBOX_QWEN_API_KEY)"
else
  set_env MBOX_AI_MODE disabled
  for key in MBOX_AI_PROVIDER MBOX_AI_ENDPOINT MBOX_AI_MODEL MBOX_AI_API_KEY; do delete_env "${key}"; done
fi
set_env MBOX_PRINT_MODE disabled
set_env MBOX_HEADSET_MODE disabled

for key in DEPLOYMENT_TIER MBOX_POSTAR_ENABLED MBOX_POSTAR_ENVIRONMENT MBOX_POSTAR_AGENCY_ID MBOX_POSTAR_MERCHANT_ID MBOX_POSTAR_PUBLIC_KEY MBOX_POSTAR_CALLBACK_URL MBOX_POSTAR_HTTP_TIMEOUT_MS; do
  delete_env "${key}"
done

for key in MBOX_ASSISTANT_PROVIDER MBOX_QWEN_API_KEY MBOX_QWEN_MODEL MBOX_QWEN_ENDPOINT MBOX_ASSISTANT_HTTP_TIMEOUT_MS; do
  delete_env "${key}"
done

# Produce a canonical file, not a modified legacy file. Values stay byte-for-byte
# in the protected file and are never printed by this tool.
canonical=$(mktemp "${env_file}.canonical.XXXXXX")
awk -F= '
  BEGIN {
    split("NODE_ENV PORT HOST DATABASE_URL MBOX_RUNTIME_CONFIG_VERSION MBOX_DEPLOYMENT_TIER MBOX_TENANT_ID MBOX_STORE_ID MBOX_NORMALIZED_SECRET MBOX_CONTACT_ACTIVE_KEY_ID MBOX_CONTACT_ACTIVE_KEY_BASE64 MBOX_CONTACT_LOOKUP_KEY_BASE64 MBOX_CONTACT_LEGACY_PHONE_LOOKUP_KEY_BASE64 MBOX_CONTACT_PREVIOUS_KEYS MBOX_METRICS_TOKEN MBOX_DATABASE_POOL_MAX MBOX_WORKER_DATABASE_POOL_MAX MBOX_GUEST_PAYMENT_MODE MBOX_TRUST_PROXY_HOPS MBOX_INVENTORY_ENFORCEMENT_MODE MBOX_GUEST_ORDER_DUPLICATE_WINDOW_SECONDS MBOX_GUEST_ORDER_CUSTOMER_LIMIT_PER_MINUTE MBOX_GUEST_ORDER_TABLE_LIMIT_PER_MINUTE MBOX_WECHAT_ENABLED MBOX_WECHAT_APP_ID MBOX_WECHAT_APP_SECRET MBOX_WECHAT_STATE_SECRET MBOX_WECHAT_ENCRYPTION_KEY_VERSION MBOX_WECHAT_ENCRYPTION_KEY_BASE64 MBOX_WECHAT_SERVICE_TEMPLATE_ID MBOX_WECHAT_NOTIFICATION_POLICY_VERSION MBOX_ALIPAY_APP_ID MBOX_ALIPAY_AES_KEY MBOX_PAYMENT_MODE MBOX_PAYMENT_PROVIDER POSTAR_AGENCY_ID POSTAR_MERCHANT_ID POSTAR_PUBLIC_KEY POSTAR_CALLBACK_URL POSTAR_HTTP_TIMEOUT_MS POSTAR_WECHAT_APP_ID POSTAR_WECHAT_TRADE_TYPE MBOX_AI_MODE MBOX_AI_PROVIDER MBOX_AI_ENDPOINT MBOX_AI_MODEL MBOX_AI_API_KEY MBOX_PRINT_MODE MBOX_PRINT_ENDPOINT MBOX_HEADSET_MODE MBOX_HEADSET_ENDPOINT MBOX_START_WORKERS MBOX_WORKER_ID MBOX_WORKER_INTERVAL_MS MBOX_WORKER_ADAPTER_MODULE MBOX_STATIC_DIR MBOX_PUBLIC_URL MBOX_RELEASE_SHA MBOX_RELEASE_IMAGE_DIGEST APP_COMMIT_SHA MBOX_EXPECTED_RELEASE_SHA MBOX_EXPECTED_IMAGE_DIGEST", keys, " ")
    for (i in keys) allowed[keys[i]] = 1
  }
  allowed[$1] || $1 == "MBOX_STORE_DAILY_CREDENTIAL" || $1 ~ /^MBOX_EMPLOYEE_PIN_[A-Z0-9_]+$/ {print}
' "${env_file}" > "${canonical}"
chmod 0600 "${canonical}"
mv "${canonical}" "${env_file}"
