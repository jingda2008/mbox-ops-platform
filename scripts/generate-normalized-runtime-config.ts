import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { NORMALIZED_RUNTIME_CONFIG_VERSION } from '../server/normalized/normalized-runtime-config-contract.js'
import { parseStoreProvisionConfig } from '../server/provision-normalized-store.js'

const outputDirectory = resolve(process.argv[2] ?? 'deploy/aliyun/config')
const storeConfig = parseStoreProvisionConfig(JSON.parse(
  await readFile(resolve('deploy/normalized-store/mbox-lujiazui.store.json'), 'utf8'),
))
const provisioningFields = [
  ...(storeConfig.dailyCredentialEnv ? [storeConfig.dailyCredentialEnv] : []),
  ...storeConfig.employees.map((employee) => employee.pinEnv),
].toSorted()
const provisioningTemplate = provisioningFields.map((field) =>
  `${field}=<${field === storeConfig.dailyCredentialEnv ? 'store-daily-credential' : 'unique-four-digit-pin'}>`)

const common = [
  `MBOX_RUNTIME_CONFIG_VERSION=${NORMALIZED_RUNTIME_CONFIG_VERSION}`,
  'NODE_ENV=production',
  'PORT=8787',
  'DATABASE_URL=<postgresql-url>',
  'MBOX_TENANT_ID=<tenant-uuid>',
  'MBOX_STORE_ID=<store-uuid>',
  'MBOX_NORMALIZED_SECRET=<minimum-32-byte-secret>',
  'MBOX_CONTACT_ACTIVE_KEY_ID=contact-key-2026-01',
  'MBOX_CONTACT_ACTIVE_KEY_BASE64=<base64-encoded-32-byte-key>',
  'MBOX_CONTACT_LOOKUP_KEY_BASE64=<base64-encoded-stable-32-byte-lookup-key>',
  'MBOX_CONTACT_LEGACY_PHONE_LOOKUP_KEY_BASE64=<base64-encoded-stable-legacy-phone-lookup-key>',
  'MBOX_CONTACT_PREVIOUS_KEYS=normalized-contact-v1=<base64-key>;normalized-phone-v1=<base64-key>',
  'MBOX_METRICS_TOKEN=<minimum-32-byte-token>',
  'MBOX_DATABASE_POOL_MAX=12',
  'MBOX_WORKER_DATABASE_POOL_MAX=4',
  'MBOX_TRUST_PROXY_HOPS=1',
  'MBOX_GUEST_ORDER_DUPLICATE_WINDOW_SECONDS=45',
  'MBOX_GUEST_ORDER_CUSTOMER_LIMIT_PER_MINUTE=5',
  'MBOX_GUEST_ORDER_TABLE_LIMIT_PER_MINUTE=20',
  ...provisioningTemplate,
]

const validation = [
  ...common,
  'MBOX_DEPLOYMENT_TIER=validation',
  'MBOX_WECHAT_ENABLED=false',
  'MBOX_PAYMENT_MODE=disabled',
  'MBOX_AI_MODE=disabled',
  'MBOX_PRINT_MODE=disabled',
  'MBOX_HEADSET_MODE=disabled',
  'MBOX_GUEST_PAYMENT_MODE=simulation',
  'MBOX_INVENTORY_ENFORCEMENT_MODE=audit_only',
  'MBOX_START_WORKERS=false',
]

const production = [
  ...common,
  'MBOX_DEPLOYMENT_TIER=production',
  'MBOX_WECHAT_ENABLED=true',
  'MBOX_WECHAT_APP_ID=<mini-program-app-id>',
  'MBOX_WECHAT_APP_SECRET=<mini-program-app-secret>',
  'MBOX_WECHAT_STATE_SECRET=<minimum-32-byte-wechat-state-secret>',
  'MBOX_WECHAT_ENCRYPTION_KEY_VERSION=1',
  'MBOX_WECHAT_ENCRYPTION_KEY_BASE64=<base64-encoded-32-byte-key>',
  'MBOX_WECHAT_SERVICE_TEMPLATE_ID=<wechat-service-template-id>',
  'MBOX_WECHAT_NOTIFICATION_POLICY_VERSION=<approved-notification-policy-version>',
  'MBOX_PAYMENT_MODE=production',
  'MBOX_PAYMENT_PROVIDER=postar',
  'POSTAR_AGENCY_ID=<agency-id>',
  'POSTAR_MERCHANT_ID=<merchant-id>',
  'POSTAR_PUBLIC_KEY=<provider-public-key>',
  'POSTAR_CALLBACK_URL=https://pay.shmbox.com/api/payments/providers/postar/callback',
  'POSTAR_HTTP_TIMEOUT_MS=10000',
  'POSTAR_WECHAT_APP_ID=<official-account-or-mini-program-app-id>',
  'POSTAR_WECHAT_TRADE_TYPE=<5-or-8>',
  'MBOX_AI_MODE=disabled',
  'MBOX_PRINT_MODE=disabled',
  'MBOX_HEADSET_MODE=disabled',
  'MBOX_GUEST_PAYMENT_MODE=wechat_jsapi',
  'MBOX_INVENTORY_ENFORCEMENT_MODE=strict',
  'MBOX_START_WORKERS=true',
  'MBOX_WORKER_ID=<unique-worker-id>',
  'MBOX_WORKER_ADAPTER_MODULE=<absolute-adapter-path>',
]

const requiredFields = {
  schemaVersion: 1,
  configVersion: NORMALIZED_RUNTIME_CONFIG_VERSION,
  modes: ['disabled', 'test', 'uat', 'production'],
  alwaysRequiredInOptimizedRuntime: [
    'MBOX_RUNTIME_CONFIG_VERSION', 'NODE_ENV', 'MBOX_DEPLOYMENT_TIER', 'DATABASE_URL',
    'MBOX_TENANT_ID', 'MBOX_STORE_ID', 'MBOX_NORMALIZED_SECRET', 'MBOX_METRICS_TOKEN',
    'MBOX_CONTACT_ACTIVE_KEY_ID','MBOX_CONTACT_ACTIVE_KEY_BASE64',
    'MBOX_CONTACT_LOOKUP_KEY_BASE64','MBOX_CONTACT_LEGACY_PHONE_LOOKUP_KEY_BASE64',
    'MBOX_CONTACT_PREVIOUS_KEYS',
    'MBOX_TRUST_PROXY_HOPS',
    'MBOX_PAYMENT_MODE', 'MBOX_AI_MODE', 'MBOX_PRINT_MODE', 'MBOX_HEADSET_MODE',
    'MBOX_GUEST_PAYMENT_MODE', 'MBOX_INVENTORY_ENFORCEMENT_MODE', 'MBOX_START_WORKERS',
    'MBOX_WECHAT_ENABLED',
  ],
  conditional: {
    wechatIdentity: [
      'MBOX_WECHAT_APP_ID', 'MBOX_WECHAT_APP_SECRET', 'MBOX_WECHAT_STATE_SECRET',
      'MBOX_WECHAT_ENCRYPTION_KEY_VERSION', 'MBOX_WECHAT_ENCRYPTION_KEY_BASE64',
    ],
    wechatServiceNotification: [
      'MBOX_WECHAT_SERVICE_TEMPLATE_ID', 'MBOX_WECHAT_NOTIFICATION_POLICY_VERSION',
    ],
    payment: ['MBOX_PAYMENT_PROVIDER', 'POSTAR_AGENCY_ID', 'POSTAR_MERCHANT_ID', 'POSTAR_PUBLIC_KEY', 'POSTAR_CALLBACK_URL'],
    ai: ['MBOX_AI_PROVIDER', 'MBOX_AI_ENDPOINT', 'MBOX_AI_MODEL', 'MBOX_AI_API_KEY'],
    printing: ['MBOX_PRINT_ENDPOINT'],
    headset: ['MBOX_HEADSET_ENDPOINT'],
    storeProvisioning: provisioningFields,
  },
}

await mkdir(outputDirectory, { recursive: true })
await Promise.all([
  writeFile(resolve(outputDirectory, 'validation.env.template'), `${validation.join('\n')}\n`),
  writeFile(resolve(outputDirectory, 'production.env.template'), `${production.join('\n')}\n`),
  writeFile(resolve(outputDirectory, 'required-fields.json'), `${JSON.stringify(requiredFields, null, 2)}\n`),
])
