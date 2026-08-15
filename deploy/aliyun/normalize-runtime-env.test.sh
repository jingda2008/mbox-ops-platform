#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
env_file=$(mktemp)
trap 'rm -f "${env_file}"' EXIT
cat > "${env_file}" <<'ENV'
NODE_ENV=production
DATABASE_URL=postgresql://private:secret@database/mbox
MBOX_TENANT_ID=11111111-1111-4111-8111-111111111111
MBOX_STORE_ID=22222222-2222-4222-8222-222222222222
MBOX_NORMALIZED_SECRET=0123456789abcdef0123456789abcdef
MBOX_METRICS_TOKEN=0123456789abcdef0123456789abcdef
MBOX_POSTAR_ENABLED=false
MBOX_POSTAR_MERCHANT_ID=inactive
MBOX_ASSISTANT_PROVIDER=disabled
MBOX_QWEN_API_KEY=old-unused-key
MBOX_GUEST_PAYMENT_MODE=simulation
MBOX_INVENTORY_ENFORCEMENT_MODE=audit_only
MBOX_START_WORKERS=false
MBOX_STORE_DAILY_CREDENTIAL=MBOX521
MBOX_EMPLOYEE_PIN_LIYAN=5210
MBOX_EMPLOYEE_PIN_TOM=5211
MBOX_EMPLOYEE_PIN_bad=9999
MBOX_UNRELATED_LEGACY_FIELD=remove-me
ENV
chmod 0600 "${env_file}"
"${root}/deploy/aliyun/normalize-runtime-env.sh" "${env_file}" validation
grep -qx 'MBOX_RUNTIME_CONFIG_VERSION=normalized-runtime-config/v1' "${env_file}"
grep -qx 'MBOX_PAYMENT_MODE=disabled' "${env_file}"
grep -qx 'MBOX_AI_MODE=disabled' "${env_file}"
grep -qx 'DATABASE_URL=postgresql://private:secret@database/mbox' "${env_file}"
grep -qx 'MBOX_STORE_DAILY_CREDENTIAL=MBOX521' "${env_file}"
grep -qx 'MBOX_EMPLOYEE_PIN_LIYAN=5210' "${env_file}"
grep -qx 'MBOX_EMPLOYEE_PIN_TOM=5211' "${env_file}"
if grep -Eq 'MBOX_POSTAR_|MBOX_QWEN_|MBOX_UNRELATED_' "${env_file}"; then
  echo 'legacy field survived canonicalization' >&2
  exit 1
fi
if grep -q 'MBOX_EMPLOYEE_PIN_bad=' "${env_file}"; then
  echo 'invalid dynamic provisioning field survived canonicalization' >&2
  exit 1
fi

postar_env_file=$(mktemp)
trap 'rm -f "${env_file}" "${postar_env_file}"' EXIT
cat > "${postar_env_file}" <<'ENV'
NODE_ENV=production
DATABASE_URL=postgresql://private:secret@database/mbox
MBOX_TENANT_ID=11111111-1111-4111-8111-111111111111
MBOX_STORE_ID=22222222-2222-4222-8222-222222222222
MBOX_NORMALIZED_SECRET=0123456789abcdef0123456789abcdef
MBOX_METRICS_TOKEN=0123456789abcdef0123456789abcdef
MBOX_PAYMENT_MODE=test
MBOX_PAYMENT_PROVIDER=postar
POSTAR_AGENCY_ID=agency
POSTAR_MERCHANT_ID=merchant
POSTAR_PUBLIC_KEY=public-key
POSTAR_CALLBACK_URL=https://example.test/api/payments/providers/postar/callback
MBOX_GUEST_PAYMENT_MODE=wechat_native_qr
MBOX_AI_MODE=disabled
MBOX_PRINT_MODE=disabled
MBOX_HEADSET_MODE=disabled
MBOX_START_WORKERS=false
ENV
chmod 0600 "${postar_env_file}"
"${root}/deploy/aliyun/normalize-runtime-env.sh" "${postar_env_file}" validation
grep -qx 'MBOX_PAYMENT_MODE=test' "${postar_env_file}"
grep -qx 'MBOX_PAYMENT_PROVIDER=postar' "${postar_env_file}"
grep -qx 'MBOX_GUEST_PAYMENT_MODE=wechat_native_qr' "${postar_env_file}"
grep -qx 'POSTAR_MERCHANT_ID=merchant' "${postar_env_file}"
