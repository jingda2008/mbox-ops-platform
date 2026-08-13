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
    'MBOX_PAYMENT_MODE', 'MBOX_AI_MODE', 'MBOX_PRINT_MODE', 'MBOX_HEADSET_MODE',
    'MBOX_GUEST_PAYMENT_MODE', 'MBOX_INVENTORY_ENFORCEMENT_MODE', 'MBOX_START_WORKERS',
  ],
  conditional: {
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
