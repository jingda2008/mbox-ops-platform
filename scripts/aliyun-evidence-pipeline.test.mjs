import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('OSS lifecycle keeps only bounded MBOX prefixes and never enables WORM', async () => {
  const lifecycle = await read('../deploy/aliyun/evidence/oss-lifecycle.xml')
  assert.match(lifecycle, /<Prefix>mbox\/evidence\/temp\/<\/Prefix>[\s\S]*?<Days>14<\/Days>/)
  assert.match(lifecycle, /<Prefix>mbox\/evidence\/rc\/<\/Prefix>[\s\S]*?<Days>90<\/Days>/)
  assert.match(lifecycle, /<Prefix>mbox\/backups\/<\/Prefix>[\s\S]*?<Days>90<\/Days>/)
  assert.match(lifecycle, /<Prefix>mbox\/images\/<\/Prefix>/)
  assert.doesNotMatch(lifecycle, /WORM|RetentionPeriod/i)
})

test('SLS desired state is selective, bounded and inexpensive', async () => {
  const desired = JSON.parse(await read('../deploy/aliyun/evidence/sls-desired-state.json'))
  assert.equal(desired.endpoint, 'cn-shanghai-internal.log.aliyuncs.com')
  assert.equal(desired.fullTextIndex, false)
  assert.deepEqual(desired.logstores.map((entry) => [entry.name, entry.ttlDays, entry.shards]), [
    ['runtime-errors', 7, 1],
    ['payment-audit', 90, 1],
    ['release-audit', 90, 1],
  ])
  assert.equal(desired.costControls.collectorIntervalMinutes, 2)
  assert.ok(desired.costControls.maximumPayloadBytesPerRun <= 512 * 1024)
})

test('SLS bootstrap uses the installed aliyun-cli-sls parameter names', async () => {
  const bootstrap = await read('../deploy/aliyun/bootstrap-evidence-services.sh')
  assert.match(bootstrap, /sls get-project[\s\S]*?--project "\$\{project\}"/)
  assert.match(bootstrap, /sls get-log-store[\s\S]*?--logstore "\$\{name\}"/)
  assert.match(bootstrap, /sls create-log-store[\s\S]*?--biz-mode standard/)
  assert.doesNotMatch(bootstrap, /sls get-project[^\n]*--project-name/)
  assert.doesNotMatch(bootstrap, /sls get-log-store[\s\S]{0,160}?--logstore-name/)
  assert.doesNotMatch(bootstrap, /--mode standard/)
  assert.match(bootstrap, /for _ in \$\(seq 1 24\)/)
  assert.match(bootstrap, /SLS project did not become ready within 120 seconds/)
  assert.match(bootstrap, /actual_ttl=.*\.ttl/)
  assert.match(bootstrap, /actual_shards=.*\.shardCount/)
  assert.match(bootstrap, /actual_auto_split=.*\.autoSplit/)
  assert.match(bootstrap, /SLS Logstore configuration mismatch/)
})

test('bootstrap and runtime RAM policies keep long-term access narrow', async () => {
  const bootstrap = JSON.parse(await read('../deploy/aliyun/evidence/ram-policy-bootstrap.json'))
  const runtime = JSON.parse(await read('../deploy/aliyun/evidence/ram-policy-ecs-runtime.json'))
  const bootstrapText = JSON.stringify(bootstrap)
  const runtimeText = JSON.stringify(runtime)
  assert.match(bootstrapText, /acs:log:cn-shanghai:\*:project\/\*/)
  assert.doesNotMatch(bootstrapText, /mbox-validation-139224254060\*/)
  assert.match(bootstrapText, /logstore\/runtime-errors/)
  assert.doesNotMatch(runtimeText, /CreateProject|CreateLogStore|CreateIndex|UpdateLogStore|UpdateIndex/)
  assert.doesNotMatch(runtimeText, /project\/\*/)
})

test('OSS bootstrap uses ossutil 2.x structured bucket APIs', async () => {
  const bootstrap = await read('../deploy/aliyun/bootstrap-evidence-services.sh')
  assert.doesNotMatch(bootstrap, /ossutil stat/)
  assert.match(bootstrap, /oss_options=\(--quiet --mode EcsRamRole/)
  assert.match(bootstrap, /\.Bucket\.Location/)
  assert.match(bootstrap, /api put-bucket-acl/)
  assert.match(bootstrap, /api put-bucket-encryption/)
  assert.match(bootstrap, /api put-bucket-versioning/)
  assert.match(bootstrap, /api put-bucket-lifecycle/)
  assert.match(bootstrap, /api get-bucket-lifecycle[\s\S]*?--output-format json/)
  assert.match(bootstrap, /\.LifecycleConfiguration\.Rule \/\/ \.Rule/)
  assert.match(bootstrap, /if has\("autoSplit"\) then \.autoSplit/)
  assert.doesNotMatch(bootstrap, /ossutil bucket-encryption|ossutil bucket-versioning|ossutil lifecycle/)
})

test('OSS upload is role-only, internal-only and verifies downloaded bytes and SHA256', async () => {
  const upload = await read('../deploy/aliyun/upload-oss-verified.sh')
  assert.match(upload, /auth_mode=\$\{MBOX_OSS_AUTH_MODE:-EcsRamRole\}/)
  assert.match(upload, /\*-internal\.aliyuncs\.com/)
  assert.match(upload, /long-lived cloud credential environment variables are forbidden/)
  assert.match(upload, /ossutil cp "\$\{target\}" "\$\{downloaded\}"/)
  assert.match(upload, /test "\$\{actual_size\}" = "\$\{expected_size\}"/)
  assert.match(upload, /test "\$\{actual_sha\}" = "\$\{expected_sha\}"/)
})

test('formal deployment requires OSS evidence before activation and uploads database backup first', async () => {
  const deploy = await read('../deploy/aliyun/deploy-release.sh')
  const stage = await read('../deploy/aliyun/stage-release-evidence.sh')
  const activate = await read('../deploy/aliyun/activate-release.sh')
  assert.match(deploy, /oss-ready-evidence/)
  assert.match(stage, /mbox\/evidence\/rc/)
  assert.ok(deploy.indexOf('upload-oss-verified.sh') < deploy.indexOf('activate-release.sh'))
  assert.match(activate, /mbox\/backups/)
  assert.ok(activate.indexOf('upload-oss-verified.sh') < activate.indexOf('node dist-server\/server\/migrate.js'))
})

test('selective collection is outside the request path and only three stores can be written', async () => {
  const dockerfile = await read('../Dockerfile')
  const service = await read('../deploy/aliyun/systemd/mbox-sls-collector.service')
  const collector = await read('../deploy/aliyun/collect-selective-events.sh')
  const sender = await read('../deploy/aliyun/send-sls-events.sh')
  assert.match(dockerfile, /filter-sls-events\.mjs/)
  assert.match(service, /Type=oneshot/)
  assert.match(service, /IOSchedulingClass=idle/)
  assert.match(service, /ProtectHome=read-only/)
  assert.match(collector, /docker exec -i "\$\{container\}" node "\$\{filter\}"/)
  assert.match(collector, /flock -n 9/)
  assert.match(collector, /mboxAuditEvent:"container_started"/)
  assert.match(sender, /runtime-errors\|payment-audit\|release-audit/)
  assert.match(sender, /for logstore in runtime-errors payment-audit release-audit/)
  assert.match(sender, /--logs "\$\{payloads\[@\]\}"/)
  assert.match(collector, /cp "\$\{merged\}" "\$\{queue_file\}"[\s\S]*printf '%s\\n' "\$\{now\}" > "\$\{cursor_file\}"/)
  assert.match(collector, /cp "\$\{remainder\}" "\$\{queue_file\}"/)
  assert.doesNotMatch(collector, /: > "\$\{queue_file\}"/)
  assert.doesNotMatch(sender, /requestBody|paymentPayload|phoneNumber|idCard/)
})

test('rollback audit only reports success after the restored service is verified', async () => {
  const activate = await read('../deploy/aliyun/activate-release.sh')
  assert.match(activate, /emit_release_audit rollback_started/)
  assert.match(activate, /rollback_response=.*\/api\/ready/)
  assert.match(activate, /if \[ "\$\{rollback_ok\}" = 1 \]; then[\s\S]*emit_release_audit rollback_succeeded[\s\S]*else[\s\S]*emit_release_audit rollback_failed/)
})

test('SLS sender validates and batches a dry-run event stream', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-sls-sender-'))
  const input = join(directory, 'events.jsonl')
  await writeFile(input, [
    { timestamp: '2026-08-11T00:00:00Z', eventType: 'http_5xx', logstore: 'runtime-errors' },
    { timestamp: '2026-08-11T00:00:01Z', eventType: 'payment_exception', logstore: 'payment-audit' },
    { timestamp: '2026-08-11T00:00:02Z', eventType: 'deployment_succeeded', logstore: 'release-audit' },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  try {
    const result = spawnSync('bash', [new URL('../deploy/aliyun/send-sls-events.sh', import.meta.url).pathname, input], {
      encoding: 'utf8',
      env: { ...process.env, MBOX_SLS_DRY_RUN: '1' },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /sls_send=dry-run/)
    assert.match(result.stdout, /events=3/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
