import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

function runChild(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

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
  assert.doesNotMatch(bootstrap, /actual_auto_split=\$\(jq -er/)
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
  assert.match(upload, /_COMPLETE\.json/)
  assert.match(upload, /_OBJECTS\.json/)
  assert.match(upload, /objectsManifestSha256/)
  const prune = await read('../deploy/aliyun/prune-oss-images.sh')
  assert.match(prune, /objectsManifestSha256/)
  assert.match(prune, /release-manifest\.json/)
  assert.match(prune, /migration-manifest\.json/)
  assert.match(prune, /SHA256SUMS/)
  assert.match(prune, /sha256sum "\$\{critical_file\}"/)
})

test('OSS object manifest gates image pruning and detects a changed critical object', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-oss-manifest-'))
  const source = join(directory, 'source')
  const fakeBin = join(directory, 'bin')
  const ossRoot = join(directory, 'oss')
  await Promise.all([mkdir(source), mkdir(fakeBin), mkdir(ossRoot)])
  const files = {
    'release-manifest.json': '{"releaseSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n',
    'migration-manifest.json': '{"schemaVersion":34}\n',
    'image.tar.gz': 'immutable-image-bytes\n',
  }
  for (const [name, content] of Object.entries(files)) await writeFile(join(source, name), content)
  await writeFile(join(source, 'SHA256SUMS'), Object.entries(files)
    .map(([name, content]) => `${sha256(content)}  ${name}`)
    .join('\n') + '\n')
  await writeFile(join(fakeBin, 'curl'), '#!/bin/sh\nprintf "mbox-runtime-role\\n"\n', { mode: 0o700 })
  await writeFile(join(fakeBin, 'ossutil'), `#!/usr/bin/env bash
set -euo pipefail
root=\${FAKE_OSS_ROOT:?}
command=\${1:?}
shift
to_path() { printf '%s/%s' "\${root}" "\${1#oss://}"; }
case "\${command}" in
  cp)
    source=\${1:?}; target=\${2:?}
    if [[ "\${source}" == oss://* ]]; then
      cp "$(to_path "\${source}")" "\${target}"
    else
      destination=$(to_path "\${target}")
      mkdir -p "$(dirname "\${destination}")"
      cp "\${source}" "\${destination}"
    fi
    ;;
  ls)
    base=$(to_path "\${1:?}")
    [ -d "\${base}" ] || exit 0
    find "\${base}" -type f -print | sort | while IFS= read -r file; do
      printf 'oss://%s\\n' "\${file#\${root}/}"
    done
    ;;
  rm) exit 0 ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 })
  const environment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    FAKE_OSS_ROOT: ossRoot,
    MBOX_OSS_BUCKET: 'm-box',
    MBOX_OSS_REGION: 'cn-shanghai',
    MBOX_OSS_ENDPOINT: 'oss-cn-shanghai-internal.aliyuncs.com',
    MBOX_OSS_AUTH_MODE: 'EcsRamRole',
  }
  delete environment.ALIBABA_CLOUD_ACCESS_KEY_ID
  delete environment.ALIBABA_CLOUD_ACCESS_KEY_SECRET
  try {
    const upload = spawnSync('bash', [
      new URL('../deploy/aliyun/upload-oss-verified.sh', import.meta.url).pathname,
      source,
      'mbox/images/release-a/',
    ], { encoding: 'utf8', env: environment })
    assert.equal(upload.status, 0, upload.stderr)
    const objectDirectory = join(ossRoot, 'm-box', 'mbox', 'images', 'release-a')
    const completion = JSON.parse(await readFile(join(objectDirectory, '_COMPLETE.json'), 'utf8'))
    const objectManifestBytes = await readFile(join(objectDirectory, '_OBJECTS.json'))
    const objectManifest = JSON.parse(objectManifestBytes)
    assert.equal(completion.objectsManifest, 'mbox/images/release-a/_OBJECTS.json')
    assert.equal(completion.objectsManifestSha256, sha256(objectManifestBytes))
    assert.equal(completion.objectCount, 4)
    assert.deepEqual(objectManifest.objects.map((entry) => entry.key).sort(), [
      'mbox/images/release-a/SHA256SUMS',
      'mbox/images/release-a/image.tar.gz',
      'mbox/images/release-a/migration-manifest.json',
      'mbox/images/release-a/release-manifest.json',
    ])

    const pruneEnvironment = { ...environment, MBOX_OSS_IMAGE_KEEP: '1', MBOX_OSS_PRUNE_APPLY: '0' }
    const valid = spawnSync('bash', [new URL('../deploy/aliyun/prune-oss-images.sh', import.meta.url).pathname], {
      encoding: 'utf8', env: pruneEnvironment,
    })
    assert.equal(valid.status, 0, valid.stderr)
    assert.match(valid.stdout, /found=1/)

    await writeFile(join(objectDirectory, 'image.tar.gz'), 'changed-after-verification\n')
    const changed = spawnSync('bash', [new URL('../deploy/aliyun/prune-oss-images.sh', import.meta.url).pathname], {
      encoding: 'utf8', env: pruneEnvironment,
    })
    assert.equal(changed.status, 0, changed.stderr)
    assert.match(changed.stdout, /image_prune_skipped_incomplete=oss:\/\/m-box\/mbox\/images\/release-a\//)
    assert.match(changed.stdout, /found=0/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('formal deployment requires OSS evidence before activation and uploads database backup first', async () => {
  const deploy = await read('../deploy/aliyun/deploy-release.sh')
  const stage = await read('../deploy/aliyun/stage-release-evidence.sh')
  const activate = await read('../deploy/aliyun/activate-release.sh')
  assert.match(deploy, /oss-ready-evidence/)
  assert.match(stage, /mbox\/evidence\/rc/)
  assert.ok(deploy.indexOf('upload-oss-verified.sh') < deploy.indexOf('activate-release.sh'))
  assert.match(activate, /mbox\/backups/)
  assert.ok(activate.indexOf('upload-oss-verified.sh') < activate.indexOf('node dist-normalized/server/migrate-normalized.js'))
  assert.doesNotMatch(activate, /node dist-server\/server\/migrate\.js/)
  assert.match(activate, /tar -xOf "\$\{archive\}" index\.json/)
  assert.match(activate, /archive_reference_media_type=/)
  assert.match(activate, /test "\$\{archive_reference_digest\}" = "\$\{expected_digest\}"/)
  assert.match(activate, /application\/vnd\.oci\.image\.index\.v1\+json/)
  assert.match(activate, /application\/vnd\.oci\.image\.manifest\.v1\+json/)
  assert.match(activate, /platform\.os == "linux" and \.platform\.architecture == "amd64"/)
  assert.match(activate, /archive_config_digest=/)
  assert.match(activate, /\.os == "linux" and \.architecture == "amd64"/)
  assert.match(activate, /actual_image_digest=.*docker image inspect/)
  assert.match(activate, /test "\$\{actual_image_digest\}" = "\$\{expected_digest\}"/)
  assert.match(activate, /set_env APP_COMMIT_SHA "\$\{release_sha\}"/)
  assert.match(activate, /set_env MBOX_DEPLOYMENT_TIER "\$\{deployment_tier\}"/)
  assert.match(activate, /configuration\.store\.sha256/)
  assert.match(activate, /provision-normalized-release\.js/)
  assert.doesNotMatch(activate, /node dist-normalized\/server\/provision-normalized-store\.js/)
  assert.doesNotMatch(activate, /node dist-normalized\/server\/provision-normalized-catalog\.js/)
  assert.match(activate, /candidate_ip=/)
  assert.match(deploy, /rollback-activated-release\.sh/)
  assert.match(deploy, /deploymentScripts/)
  assert.match(deploy, /deployment script identity is invalid/)
  assert.doesNotMatch(deploy, /< deploy\/aliyun\/activate-release\.sh/)
  const rollback = await read('../deploy/aliyun/rollback-activated-release.sh')
  assert.match(rollback, /previousReleaseSha/)
  assert.match(rollback, /verify_public_release "\$\{previous_release_sha\}"/)
  assert.match(rollback, /docker update --restart=unless-stopped "\$\{active_container\}"/)
  assert.ok(rollback.indexOf('docker start "${rollback_container}"') < rollback.indexOf('rollback_ip='))
  assert.ok(rollback.indexOf('rollback_ip=') < rollback.lastIndexOf('docker stop -t 20 "${active_container}"'))
  assert.match(activate, /\.schemaFlavor == \$schemaFlavor/)
  assert.match(activate, /\.commitSha == \$sha/)
  assert.match(activate, /\.deploymentTier == \$deploymentTier/)
  assert.doesNotMatch(activate, /\.projectionReady/)
  assert.match(activate, /\.releaseImageDigest == \$digest/)
  const smoke = await read('../scripts/verify-release-smoke.mjs')
  assert.match(smoke, /body\.schemaFlavor !== 'normalized-core-v1'/)
  assert.match(smoke, /body\.commitSha !== expectedSha/)
  assert.match(smoke, /body\.releaseImageDigest !== expectedDigest/)
  assert.match(smoke, /'\/guest\?table=W01'/)
  assert.match(smoke, /'\/reserve'/)
  assert.match(smoke, /'\/staff\/live'/)
  assert.match(smoke, /text\/html/)
  assert.match(activate, /public_verifier=.*verify-public-app\.sh/)
  assert.match(activate, /verify_public_release 15/)
  const publicVerifier = await read('../deploy/aliyun/verify-public-app.sh')
  assert.match(publicVerifier, /<div id="root"><\/div>/)
  assert.match(publicVerifier, /mbox-build-commit/)
  assert.match(publicVerifier, /\/assets\/\[\^"\]\+\\\.js/)
  assert.match(publicVerifier, /releaseImageDigest == \$digest/)
  assert.doesNotMatch(publicVerifier, /curl -k/)
  assert.doesNotMatch(smoke, /body\.projectionReady/)
  const releaseWorkflow = await read('../.github/workflows/release.yml')
  assert.match(releaseWorkflow, /createHash\('sha256'\)\.update\(fs\.readFileSync\(path\)\)\.digest\('hex'\)/)
  assert.match(releaseWorkflow, /release configuration digest mismatch/)
  assert.match(releaseWorkflow, /deployment script digest mismatch/)
  const ciWorkflow = await read('../.github/workflows/ci.yml')
  assert.match(ciWorkflow, /image_digest=\$\(tar -xOf "\$\{archive\}" index\.json/)
  assert.doesNotMatch(ciWorkflow, /image_digest=\$\(docker image inspect/)
})

test('selective collection is outside the request path and only three stores can be written', async () => {
  const dockerfile = await read('../Dockerfile')
  const normalizedDockerfile = await read('../Dockerfile.normalized')
  const installer = await read('../deploy/aliyun/install-selective-observability.sh')
  const service = await read('../deploy/aliyun/systemd/mbox-sls-collector.service')
  const collector = await read('../deploy/aliyun/collect-selective-events.sh')
  const sender = await read('../deploy/aliyun/send-sls-events.sh')
  assert.match(dockerfile, /filter-sls-events\.mjs/)
  assert.match(normalizedDockerfile, /filter-sls-events\.mjs/)
  assert.match(installer, /node --check "\$\{filter_path\}"/)
  assert.match(installer, /normalized image is missing \$\{filter_path\}/)
  assert.match(installer, /selective observability installation failed:/)
  assert.match(service, /Type=oneshot/)
  assert.match(service, /IOSchedulingClass=idle/)
  assert.match(service, /ProtectHome=read-only/)
  assert.match(collector, /docker exec -i "\$\{container\}" node "\$\{filter\}"/)
  assert.match(collector, /flock -n 9/)
  assert.match(collector, /mboxAuditEvent:"container_started"/)
  assert.match(sender, /runtime-errors\|payment-audit\|release-audit/)
  assert.match(sender, /for logstore in runtime-errors payment-audit release-audit/)
  assert.match(sender, /payload_list=.*jq -cs 'map\(tojson\)'/)
  assert.match(sender, /--logs "\$\{payload_list\}"/)
  assert.match(collector, /cp "\$\{merged\}" "\$\{queue_file\}"[\s\S]*printf '%s\\n' "\$\{now\}" > "\$\{cursor_file\}"/)
  assert.match(collector, /cp "\$\{remainder\}" "\$\{queue_file\}"/)
  assert.doesNotMatch(collector, /: > "\$\{queue_file\}"/)
  assert.doesNotMatch(sender, /requestBody|paymentPayload|phoneNumber|idCard/)
  assert.match(sender, /sanitize\(\["logstore","timestamp","eventType"/)
  assert.match(sender, /"\$\{sanitized_input\}"/)
})

test('selective observability installer fails visibly before systemd changes when the image asset is missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-observability-installer-'))
  const fakeBin = join(directory, 'bin')
  const marker = join(directory, 'systemctl-invoked')
  await mkdir(fakeBin, { recursive: true })
  const executable = { mode: 0o700 }
  await Promise.all([
    writeFile(join(fakeBin, 'id'), '#!/bin/sh\nprintf "0\\n"\n', executable),
    writeFile(join(fakeBin, 'curl'), '#!/bin/sh\nprintf "mbox-runtime-role\\n"\n', executable),
    writeFile(join(fakeBin, 'docker'), `#!/bin/sh\nif [ "$1" = "container" ] && [ "$2" = "inspect" ]; then exit 0; fi\nif [ "$1" = "exec" ]; then exit 1; fi\nexit 0\n`, executable),
    writeFile(join(fakeBin, 'aliyun'), '#!/bin/sh\nexit 0\n', executable),
    writeFile(join(fakeBin, 'jq'), '#!/bin/sh\nexit 0\n', executable),
    writeFile(join(fakeBin, 'flock'), '#!/bin/sh\nexit 0\n', executable),
    writeFile(join(fakeBin, 'systemctl'), '#!/bin/sh\nprintf "called\\n" > "$MBOX_SYSTEMCTL_MARKER"\nexit 0\n', executable),
  ])
  try {
    const result = spawnSync('bash', [new URL('../deploy/aliyun/install-selective-observability.sh', import.meta.url).pathname], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        MBOX_INSTALL_ROOT: join(directory, 'install'),
        MBOX_SYSTEMCTL_MARKER: marker,
      },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /normalized image is missing \/app\/scripts\/filter-sls-events\.mjs/)
    assert.doesNotMatch(result.stdout, /selective_observability=installed/)
    const markerExists = await access(marker).then(() => true, () => false)
    assert.equal(markerExists, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rollback audit only reports success after the restored service is verified', async () => {
  const activate = await read('../deploy/aliyun/activate-release.sh')
  assert.match(activate, /emit_release_audit rollback_started/)
  assert.match(activate, /"\$\{public_verifier\}" "\$\{public_url\}" "\$\{previous_release_sha\}"/)
  assert.match(activate, /previous_release_digest/)
  assert.match(activate, /docker update --restart=unless-stopped "\$\{active_container\}"/)
  assert.match(activate, /if \[ "\$\{rollback_ok\}" = 1 \]; then[\s\S]*emit_release_audit rollback_succeeded[\s\S]*else[\s\S]*emit_release_audit rollback_failed/)
  assert.match(activate, /trap 'rollback_on_error 130' INT/)
  assert.match(activate, /trap 'rollback_on_error 143' TERM/)
  assert.match(activate, /active_sha=.*docker inspect/)
  assert.match(activate, /active_digest=.*docker inspect/)
  assert.match(activate, /\[ "\$\{active_sha\}" = "\$\{release_sha\}" \]/)
  assert.match(activate, /\[ "\$\{active_digest\}" = "\$\{expected_digest\}" \]/)
  assert.doesNotMatch(activate, /old_renamed=|promoted=|traffic_switched=/)
  assert.match(activate, /Reload the canonical upstream unconditionally/)
  const externalRollback = await read('../deploy/aliyun/rollback-activated-release.sh')
  assert.match(externalRollback, /active_sha=.*docker inspect/)
  assert.match(externalRollback, /active_digest=.*docker inspect/)
  assert.match(externalRollback, /\[ "\$\{active_sha\}" = "\$\{previous_release_sha\}" \]/)
  assert.doesNotMatch(externalRollback, /failed_renamed=|rollback_promoted=|traffic_switched=/)
})

test('external rollback starts and verifies the previous SHA before candidate-IP cutover and stopping the failed release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-external-rollback-'))
  const installRoot = join(directory, 'install')
  const failedRelease = join(installRoot, 'releases', 'failed')
  const previousRelease = join(installRoot, 'releases', 'previous')
  const fakeBin = join(directory, 'bin')
  const dockerLog = join(directory, 'docker.log')
  const failedSha = 'a'.repeat(40)
  const previousSha = 'b'.repeat(40)
  const failedDigest = `sha256:${'c'.repeat(64)}`
  const previousDigest = `sha256:${'d'.repeat(64)}`
  const deploymentScriptNames = [
    'deploy-release.sh',
    'activate-release.sh', 'rollback-activated-release.sh', 'verify-public-app.sh',
    'stage-release-evidence.sh', 'upload-oss-verified.sh', 'send-sls-events.sh',
    'prune-oss-images.sh',
  ]
  await Promise.all([
    mkdir(failedRelease, { recursive: true }),
    mkdir(previousRelease, { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
  ])
  await writeFile(join(failedRelease, 'deployment-manifest.json'), JSON.stringify({
    rollbackContainer: 'mbox-app-rollback-previous',
    releaseSha: failedSha,
    tier: 'validation',
    previousReleaseSha: previousSha,
    previousReleaseDir: previousRelease,
  }))
  await writeFile(join(previousRelease, 'release-manifest.json'), JSON.stringify({
    releaseSha: previousSha, imageDigest: previousDigest, migration: { count: 40 },
  }))
  await writeFile(join(previousRelease, 'deployment-manifest.json'), JSON.stringify({ tier: 'validation' }))
  await writeFile(join(previousRelease, 'app.env'), 'MBOX_ENV=test\n')
  await writeFile(join(failedRelease, 'verify-public-app.sh'), `#!/bin/sh
printf '%s\n' "$*" >> "$MBOX_PUBLIC_VERIFY_LOG"
exit 0
`, { mode: 0o700 })
  for (const scriptName of deploymentScriptNames.filter((name) => name !== 'verify-public-app.sh')) {
    await writeFile(join(failedRelease, scriptName), `#!/bin/sh\nprintf '${scriptName}\\n'\n`, { mode: 0o700 })
  }
  const deploymentScripts = Object.fromEntries(await Promise.all(deploymentScriptNames.map(async (scriptName) => [
    scriptName.replace(/\.sh$/, '').replaceAll('-', '_'),
    { file: scriptName, sha256: sha256(await readFile(join(failedRelease, scriptName))) },
  ])))
  await writeFile(join(failedRelease, 'release-manifest.json'), JSON.stringify({
    releaseSha: failedSha, imageDigest: failedDigest, migration: { count: 40 }, deploymentScripts,
  }))
  await writeFile(join(fakeBin, 'curl'), `#!/bin/sh
printf '{"status":"ready","commitSha":"${previousSha}","releaseImageDigest":"${previousDigest}","schemaFlavor":"normalized-core-v1","schemaVersion":40,"deploymentTier":"validation"}\n'
`, { mode: 0o700 })
  await writeFile(join(fakeBin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${MBOX_DOCKER_LOG:?}"
if [ "$1" = network ]; then exit 0; fi
if [ "$1" = inspect ]; then
  name=$2
  arguments="$*"
  if [[ "\${arguments}" == *org.opencontainers.image.revision* ]]; then
    if [ "\${name}" = mbox-app ]; then printf '${failedSha}\\n'; else printf '${previousSha}\\n'; fi
  elif [[ "\${arguments}" == *'{{.Image}}'* ]]; then
    if [ "\${name}" = mbox-app ]; then printf '${failedDigest}\\n'; else printf '${previousDigest}\\n'; fi
  elif [[ "\${arguments}" == *NetworkSettings.Networks* ]]; then
    printf '172.18.0.9\\n'
  elif [[ "\${arguments}" == *State.Health* ]]; then
    printf 'healthy\\n'
  fi
  exit 0
fi
if [ "$1" = exec ] && [ "$2" = mbox-app-rollback-previous ]; then
  printf '{"status":"ready","commitSha":"${previousSha}"}\\n'
  exit 0
fi
if [ "$1" = exec ] && [ "$2" = mbox-caddy ] && [ "$3" = cat ]; then
  printf ':443 { reverse_proxy mbox-app:8787 }\\n'
  exit 0
fi
if [ "$1" = rename ] && [ "$2" = mbox-app ] && [ "\${MBOX_DOCKER_FAIL_RENAME_ACTIVE:-0}" = 1 ]; then
  exit 19
fi
exit 0
`, { mode: 0o700 })
  const environment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    MBOX_INSTALL_ROOT: installRoot,
    MBOX_DOCKER_LOG: dockerLog,
    MBOX_PUBLIC_VERIFY_LOG: join(directory, 'public-verify.log'),
  }
  try {
    const result = spawnSync('bash', [
      new URL('../deploy/aliyun/rollback-activated-release.sh', import.meta.url).pathname,
      failedRelease,
      'https://mbox.example.test',
    ], { encoding: 'utf8', env: environment })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, new RegExp(`restored_sha=${previousSha}`))
    const operations = (await readFile(dockerLog, 'utf8')).trim().split('\n')
    const startPrevious = operations.indexOf('start mbox-app-rollback-previous')
    const candidateReload = operations.findIndex((entry) => entry.includes('reload --config /tmp/Caddyfile.rollback-candidate'))
    const stopFailed = operations.indexOf('stop -t 20 mbox-app')
    assert.ok(startPrevious >= 0)
    assert.ok(candidateReload > startPrevious)
    assert.ok(stopFailed > candidateReload)
    const publicChecks = await readFile(environment.MBOX_PUBLIC_VERIFY_LOG, 'utf8')
    assert.match(publicChecks, new RegExp(`${previousSha} ${previousDigest.replace(':', '\\:')} 40 validation 15`))
    assert.equal(await readlink(join(installRoot, 'current')), previousRelease)
    assert.equal(await readlink(join(installRoot, '.env')), join(previousRelease, 'app.env'))

    await writeFile(dockerLog, '')
    const failedRename = spawnSync('bash', [
      new URL('../deploy/aliyun/rollback-activated-release.sh', import.meta.url).pathname,
      failedRelease,
      'https://mbox.example.test',
    ], { encoding: 'utf8', env: { ...environment, MBOX_DOCKER_FAIL_RENAME_ACTIVE: '1' } })
    assert.notEqual(failedRename.status, 0)
    assert.doesNotMatch(failedRename.stdout, /rollback=complete/)
    const recoveryOperations = (await readFile(dockerLog, 'utf8')).trim().split('\n')
    const stoppedFailed = recoveryOperations.indexOf('stop -t 20 mbox-app')
    const restartedFailed = recoveryOperations.indexOf('start mbox-app', stoppedFailed + 1)
    assert.ok(stoppedFailed >= 0)
    assert.ok(restartedFailed > stoppedFailed)
    assert.ok(recoveryOperations.indexOf('update --restart=unless-stopped mbox-app', restartedFailed + 1) > restartedFailed)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('SLS sender validates and batches a dry-run event stream', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-sls-sender-'))
  const input = join(directory, 'events.jsonl')
  await writeFile(input, [
    { timestamp: '2026-08-11T00:00:00Z', eventType: 'http_5xx', severity: 'error', logstore: 'runtime-errors' },
    { timestamp: '2026-08-11T00:00:01Z', eventType: 'payment_exception', severity: 'error', logstore: 'payment-audit' },
    { timestamp: '2026-08-11T00:00:02Z', eventType: 'deployment_succeeded', severity: 'info', logstore: 'release-audit' },
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

test('SLS sender strips undeclared fields before a dry-run batch is accepted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-sls-whitelist-'))
  const input = join(directory, 'events.jsonl')
  await writeFile(input, `${JSON.stringify({
    timestamp: '2026-08-13T00:00:00Z', eventType: 'payment_exception',
    severity: 'error', logstore: 'payment-audit', route: '/api/payments', phoneNumber: 'REDACTED', arbitrary: 'not-forwarded',
  })}\n`)
  try {
    const result = spawnSync('bash', [new URL('../deploy/aliyun/send-sls-events.sh', import.meta.url).pathname, input], {
      encoding: 'utf8', env: { ...process.env, MBOX_SLS_DRY_RUN: '1' },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /events=1/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('SLS sender removes route queries and undeclared fields at the final send boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-sls-value-sanitizer-'))
  const input = join(directory, 'events.jsonl')
  const fakeBin = join(directory, 'bin')
  const capture = join(directory, 'aliyun-args.txt')
  await mkdir(fakeBin)
  await writeFile(join(fakeBin, 'aliyun'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$MBOX_SLS_CAPTURE"\n', { mode: 0o700 })
  await writeFile(input, `${JSON.stringify({
    timestamp: '2026-08-13T00:00:00Z', eventType: 'payment_exception', severity: 'error',
    logstore: 'payment-audit', route: '/api/payments?token=redacted-query-value',
    code: 'PAYMENT_TIMEOUT', phoneNumber: '13800138000', arbitrary: 'discard-me',
  })}\n`)
  const environment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    MBOX_SLS_CAPTURE: capture,
    MBOX_SLS_DRY_RUN: '0',
  }
  delete environment.ALIBABA_CLOUD_ACCESS_KEY_ID
  delete environment.ALIBABA_CLOUD_ACCESS_KEY_SECRET
  try {
    const result = spawnSync('bash', [new URL('../deploy/aliyun/send-sls-events.sh', import.meta.url).pathname, input], {
      encoding: 'utf8', env: environment,
    })
    assert.equal(result.status, 0, result.stderr)
    const args = (await readFile(capture, 'utf8')).trim().split('\n')
    const logs = JSON.parse(args[args.indexOf('--logs') + 1]).map((entry) => JSON.parse(entry))
    assert.equal(logs.length, 1)
    assert.equal(logs[0].route, '/api/payments')
    assert.equal('phoneNumber' in logs[0], false)
    assert.equal('arbitrary' in logs[0], false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('SLS sender rejects sensitive values without echoing them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-sls-value-reject-'))
  const input = join(directory, 'events.jsonl')
  const secret = `sk-${'x'.repeat(24)}`
  await writeFile(input, `${JSON.stringify({
    timestamp: '2026-08-13T00:00:00Z', eventType: 'deployment_failed', severity: 'error',
    logstore: 'release-audit', outcome: secret,
  })}\n`)
  try {
    const result = spawnSync('bash', [new URL('../deploy/aliyun/send-sls-events.sh', import.meta.url).pathname, input], {
      encoding: 'utf8', env: { ...process.env, MBOX_SLS_DRY_RUN: '1' },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /sensitive SLS value rejected/)
    assert.equal(result.stderr.includes(secret), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('release smoke fails closed on a missing digest and reports the observed digest on success', async () => {
  const releaseSha = 'a'.repeat(40)
  const releaseDigest = `sha256:${'b'.repeat(64)}`
  let responseDigest
  let blockedBrowserRoute = null
  let invalidShellRoute = null
  let blockAsset = false
  let transientAssetFailures = 0
  let breakRuntime = false
  const server = createServer((request, response) => {
    if (request.url === '/assets/app.js') {
      const transientFailure = transientAssetFailures > 0
      if (transientFailure) transientAssetFailures -= 1
      response.statusCode = blockAsset ? 404 : transientFailure ? 503 : 200
      response.setHeader('content-type', blockAsset || transientFailure ? 'text/plain' : 'application/javascript; charset=utf-8')
      response.end(blockAsset || transientFailure ? 'missing' : breakRuntime
        ? 'throw new Error("broken runtime")'
        : 'const root=document.querySelector("#root");const main=document.createElement("main");main.textContent="M-BOX";root.append(main)')
      return
    }
    if (request.url !== '/api/ready') {
      if (request.url === blockedBrowserRoute) {
        response.statusCode = 404
        response.end('missing')
        return
      }
      if (request.headers.accept?.includes('text/html')) {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(request.url === invalidShellRoute
          ? `<!doctype html><html><head><meta name="mbox-build-commit" content="${releaseSha}" /></head><title>M-BOX</title></html>`
          : `<!doctype html><html><head><meta name="mbox-build-commit" content="${releaseSha}" /></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`)
        return
      }
      response.statusCode = 404
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: { code: 'ROUTE_NOT_FOUND' } }))
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      status: 'ready', commitSha: releaseSha, releaseImageDigest: responseDigest,
      schemaFlavor: 'normalized-core-v1', schemaVersion: 34, deploymentTier: 'validation',
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const environment = {
    ...process.env,
    MBOX_RELEASE_SMOKE_URL: `http://127.0.0.1:${address.port}`,
    MBOX_RELEASE_EXPECTED_SHA: releaseSha,
    MBOX_RELEASE_EXPECTED_DIGEST: releaseDigest,
    MBOX_RELEASE_EXPECTED_SCHEMA_VERSION: '34',
    MBOX_RELEASE_EXPECTED_TIER: 'validation',
    MBOX_RELEASE_SMOKE_ATTEMPTS: '1',
    MBOX_RELEASE_SMOKE_WAIT_MS: '1',
  }
  try {
    const missing = await runChild(process.execPath, [new URL('./verify-release-smoke.mjs', import.meta.url).pathname], {
      env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /releaseImageDigest=missing/)
    responseDigest = releaseDigest
    blockedBrowserRoute = '/staff/live'
    const missingBrowserRoute = await runChild(process.execPath, [new URL('./verify-release-smoke.mjs', import.meta.url).pathname], {
      env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.notEqual(missingBrowserRoute.status, 0)
    assert.match(missingBrowserRoute.stderr, /\/staff\/live=HTTP 404/)
    blockedBrowserRoute = null
    invalidShellRoute = '/reserve'
    const invalidShell = await runChild(process.execPath, [new URL('./verify-release-smoke.mjs', import.meta.url).pathname], {
      env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.notEqual(invalidShell.status, 0)
    assert.match(invalidShell.stderr, /\/reserve=root mount missing/)
    invalidShellRoute = null
    blockAsset = true
    const missingAsset = await runChild(process.execPath, [new URL('./verify-release-smoke.mjs', import.meta.url).pathname], {
      env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.notEqual(missingAsset.status, 0)
    assert.match(missingAsset.stderr, /\/assets\/app\.js=HTTP 404/)
    blockAsset = false
    transientAssetFailures = 1
    const recoveredAsset = await runChild(process.execPath, [new URL('./verify-release-smoke.mjs', import.meta.url).pathname], {
      env: { ...environment, MBOX_RELEASE_SMOKE_ATTEMPTS: '2' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.equal(recoveredAsset.status, 0, recoveredAsset.stderr)
    transientAssetFailures = 1
    const shellRecoveredAsset = await runChild('bash', [
      new URL('../deploy/aliyun/verify-public-app.sh', import.meta.url).pathname,
      environment.MBOX_RELEASE_SMOKE_URL, releaseSha, releaseDigest, '34', 'validation', '2', '1',
    ], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(shellRecoveredAsset.status, 0, shellRecoveredAsset.stderr)
    const passed = await runChild(process.execPath, [new URL('./verify-release-smoke.mjs', import.meta.url).pathname], {
      env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.equal(passed.status, 0, passed.stderr)
    const result = JSON.parse(passed.stdout)
    assert.equal(result.digest, releaseDigest)
    assert.deepEqual(result.browserRoutes, ['/', '/guest?table=W01', '/reserve', '/staff/live'])

    const renderedVerifier = new URL('./verify-release-browser.mjs', import.meta.url).pathname
    const renderedPassed = await runChild(process.execPath, [renderedVerifier], {
      env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.equal(renderedPassed.status, 0, renderedPassed.stderr)
    breakRuntime = true
    const renderedBroken = await runChild(process.execPath, [renderedVerifier], {
      env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.notEqual(renderedBroken.status, 0)
    assert.match(renderedBroken.stderr, /broken runtime/)
    breakRuntime = false

    const shellVerifier = new URL('../deploy/aliyun/verify-public-app.sh', import.meta.url).pathname
    const shellPassed = await runChild('bash', [
      shellVerifier, environment.MBOX_RELEASE_SMOKE_URL, releaseSha, releaseDigest, '34', 'validation', '1', '1',
    ], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(shellPassed.status, 0, shellPassed.stderr)
    blockAsset = true
    const shellMissingAsset = await runChild('bash', [
      shellVerifier, environment.MBOX_RELEASE_SMOKE_URL, releaseSha, releaseDigest, '34', 'validation', '1', '1',
    ], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    assert.notEqual(shellMissingAsset.status, 0)
    blockAsset = false

    const invalidBounds = await runChild(process.execPath, [new URL('./verify-release-smoke.mjs', import.meta.url).pathname], {
      env: { ...environment, MBOX_RELEASE_SMOKE_ATTEMPTS: '31' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.notEqual(invalidBounds.status, 0)
    assert.match(invalidBounds.stderr, /attempts must be an integer from 1 to 30/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
