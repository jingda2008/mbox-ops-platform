import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const deployScript = fileURLToPath(new URL('../deploy/aliyun/deploy-release.sh', import.meta.url))
const activateScript = fileURLToPath(new URL('../deploy/aliyun/activate-release.sh', import.meta.url))
const manifestGenerator = fileURLToPath(new URL('./write-release-bundle-manifest.mjs', import.meta.url))
const bundleVerifier = fileURLToPath(new URL('./verify-release-bundle.mjs', import.meta.url))
const migrationGenerator = fileURLToPath(new URL('./generate-migration-manifest.mjs', import.meta.url))

function runBash(source, env = {}) {
  return spawnSync('bash', ['-c', source], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

async function sealDirectory(directory, filenames) {
  const lines = []
  for (const filename of filenames) {
    const bytes = await readFile(join(directory, filename))
    lines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${filename}`)
  }
  await writeFile(join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`)
}

async function createReleaseBundle(directory, options = {}) {
  const releaseSha = options.releaseSha ?? '1'.repeat(40)
  const releaseVersion = options.releaseVersion ?? '1.0.0-rc.68'
  const imageTag = options.imageTag ?? 'mbox-ops:test'
  const releaseIntent = options.releaseIntent ?? 'validation-only'
  const config = Buffer.from(`${JSON.stringify({
    architecture: 'amd64',
    config: {
      Labels: {
        'org.opencontainers.image.revision': options.imageRevision ?? releaseSha,
        'org.opencontainers.image.version': releaseVersion,
      },
    },
  })}\n`)
  const configDigest = createHash('sha256').update(config).digest('hex')
  const configName = `${configDigest}.json`
  const archiveName = 'mbox-image.tar'
  await writeFile(join(directory, configName), config)
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify([{
    Config: configName,
    RepoTags: [imageTag],
    Layers: [],
  }])}\n`)
  const tar = spawnSync('tar', ['-cf', join(directory, archiveName), '-C', directory, 'manifest.json', configName], { encoding: 'utf8' })
  assert.equal(tar.status, 0, tar.stderr)
  const archive = await readFile(join(directory, archiveName))
  const migration = {
    schemaVersion: 2,
    compatibilityPolicy: 'expand-contract-v1',
    digest: `sha256:${'3'.repeat(64)}`,
    count: 1,
    files: [{ filename: '001_init.sql', sha256: '4'.repeat(64), expandContractCompatible: true, blockingOperations: [] }],
  }
  await writeFile(join(directory, 'migration-manifest.json'), `${JSON.stringify(migration, null, 2)}\n`)
  const manifest = {
    schemaVersion: 1,
    releaseIntent,
    releaseSha,
    releaseVersion,
    imageTag,
    imageDigest: `sha256:${configDigest}`,
    archive: archiveName,
    archiveSha256: createHash('sha256').update(archive).digest('hex'),
    migration,
  }
  await writeFile(join(directory, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

test('formal deployment always executes and must pass the release quality gate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-release-intent-'))
  const manifest = join(directory, 'release-manifest.json')
  const npmLog = join(directory, 'npm.log')
  await writeFile(manifest, '{"releaseIntent":"commercial"}\n')
  try {
    const success = runBash(`
      npm() { printf '%s\\n' "$*" >> "$NPM_LOG"; return 0; }
      export -f npm
      source "$DEPLOY_SCRIPT"
      enforce_release_intent "$MANIFEST" 0
    `, { DEPLOY_SCRIPT: deployScript, MANIFEST: manifest, NPM_LOG: npmLog })
    assert.equal(success.status, 0, success.stderr)
    assert.equal(await readFile(npmLog, 'utf8'), 'run release:quality-gate\n')
    assert.match(success.stdout, /release_intent=commercial/)

    const failure = runBash(`
      npm() { return 23; }
      export -f npm
      source "$DEPLOY_SCRIPT"
      enforce_release_intent "$MANIFEST" 0
    `, { DEPLOY_SCRIPT: deployScript, MANIFEST: manifest })
    assert.equal(failure.status, 23)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('release bundle manifest defaults to commercial and accepts validation-only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-release-manifest-'))
  const archive = join(directory, 'image.tar.gz')
  const migration = join(directory, 'migration-manifest.json')
  await writeFile(archive, 'immutable-image-archive')
  await writeFile(migration, '{"digest":"sha256:migration"}\n')
  const baseEnv = {
    MBOX_BUNDLE_ARCHIVE: archive,
    MBOX_BUNDLE_SHA: '1'.repeat(40),
    MBOX_BUNDLE_VERSION: '1.0.0-rc.68',
    MBOX_BUNDLE_IMAGE_TAG: 'mbox-ops:test',
    MBOX_BUNDLE_IMAGE_DIGEST: `sha256:${'2'.repeat(64)}`,
    MBOX_MIGRATION_MANIFEST: migration,
  }
  try {
    const commercialOutput = join(directory, 'commercial.json')
    const defaultResult = spawnSync(process.execPath, [manifestGenerator], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...baseEnv,
        MBOX_BUNDLE_RELEASE_INTENT: '',
        MBOX_BUNDLE_MANIFEST: commercialOutput,
      },
    })
    assert.equal(defaultResult.status, 0, defaultResult.stderr)
    assert.equal(JSON.parse(await readFile(commercialOutput, 'utf8')).releaseIntent, 'commercial')

    const validationOutput = join(directory, 'validation.json')
    const validationResult = spawnSync(process.execPath, [manifestGenerator], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...baseEnv,
        MBOX_BUNDLE_RELEASE_INTENT: 'validation-only',
        MBOX_BUNDLE_MANIFEST: validationOutput,
      },
    })
    assert.equal(validationResult.status, 0, validationResult.stderr)
    assert.equal(JSON.parse(await readFile(validationOutput, 'utf8')).releaseIntent, 'validation-only')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('release bundle manifest rejects unsupported release intent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-invalid-intent-'))
  const archive = join(directory, 'image.tar.gz')
  const migration = join(directory, 'migration-manifest.json')
  await writeFile(archive, 'immutable-image-archive')
  await writeFile(migration, '{"digest":"sha256:migration"}\n')
  try {
    const result = spawnSync(process.execPath, [manifestGenerator], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MBOX_BUNDLE_ARCHIVE: archive,
        MBOX_BUNDLE_SHA: '1'.repeat(40),
        MBOX_BUNDLE_VERSION: '1.0.0-rc.68',
        MBOX_BUNDLE_IMAGE_TAG: 'mbox-ops:test',
        MBOX_BUNDLE_IMAGE_DIGEST: `sha256:${'2'.repeat(64)}`,
        MBOX_MIGRATION_MANIFEST: migration,
        MBOX_BUNDLE_RELEASE_INTENT: 'production-ish',
        MBOX_BUNDLE_MANIFEST: join(directory, 'invalid.json'),
      },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must be commercial or validation-only/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('validation-only requires the explicit argument and manifest marker together', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-validation-intent-'))
  const marked = join(directory, 'marked.json')
  const commercial = join(directory, 'commercial.json')
  await writeFile(marked, '{"releaseIntent":"validation-only"}\n')
  await writeFile(commercial, '{"releaseIntent":"commercial"}\n')
  const shell = 'source "$DEPLOY_SCRIPT"; enforce_release_intent "$MANIFEST" "$EXPLICIT"'
  try {
    const allowed = runBash(shell, {
      DEPLOY_SCRIPT: deployScript,
      MANIFEST: marked,
      EXPLICIT: '1',
    })
    assert.equal(allowed.status, 0, allowed.stderr)
    assert.match(allowed.stdout, /commercial_release=false/)

    for (const scenario of [
      { manifest: commercial, explicit: '1' },
      { manifest: marked, explicit: '0' },
    ]) {
      const denied = runBash(shell, {
        DEPLOY_SCRIPT: deployScript,
        MANIFEST: scenario.manifest,
        EXPLICIT: scenario.explicit,
      })
      assert.notEqual(denied.status, 0, `unexpectedly allowed ${JSON.stringify(scenario)}`)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('root-owned server marker rejects direct root, writable files and spoofed content', () => {
  const validate = 'source "$ACTIVATE_SCRIPT"; validate_server_environment_values "$EUID_VALUE" "$DEPLOY_UID" "$OWNER_UID" "$MODE" "$CONTENT"'
  const allowed = runBash(validate, {
    ACTIVATE_SCRIPT: activateScript,
    EUID_VALUE: '0',
    DEPLOY_UID: '1001',
    OWNER_UID: '0',
    MODE: '644',
    CONTENT: 'deployment_tier=validation',
  })
  assert.equal(allowed.status, 0, allowed.stderr)
  assert.equal(allowed.stdout.trim(), 'validation')
  const commercial = runBash(validate, {
    ACTIVATE_SCRIPT: activateScript,
    EUID_VALUE: '0',
    DEPLOY_UID: '1001',
    OWNER_UID: '0',
    MODE: '600',
    CONTENT: 'deployment_tier=commercial',
  })
  assert.equal(commercial.status, 0, commercial.stderr)
  assert.equal(commercial.stdout.trim(), 'commercial')

  for (const scenario of [
    { deployUid: '0', mode: '644', content: 'deployment_tier=validation' },
    { deployUid: '1001', mode: '664', content: 'deployment_tier=validation' },
    { deployUid: '1001', mode: '644', content: 'deployment_tier=validation\nextra=true' },
    { deployUid: '1001', mode: '644', content: 'deployment_tier=production' },
  ]) {
    const denied = runBash(validate, {
      ACTIVATE_SCRIPT: activateScript,
      EUID_VALUE: '0',
      DEPLOY_UID: scenario.deployUid,
      OWNER_UID: '0',
      MODE: scenario.mode,
      CONTENT: scenario.content,
    })
    assert.notEqual(denied.status, 0, `unexpectedly accepted ${JSON.stringify(scenario)}`)
  }
})

test('release intent can only activate on the matching server-owned tier', () => {
  const command = 'source "$ACTIVATE_SCRIPT"; verify_release_intent_for_tier "$INTENT" "$TIER"'
  for (const scenario of [
    { intent: 'validation-only', tier: 'validation' },
    { intent: 'commercial', tier: 'commercial' },
  ]) {
    const result = runBash(command, { ACTIVATE_SCRIPT: activateScript, INTENT: scenario.intent, TIER: scenario.tier })
    assert.equal(result.status, 0, result.stderr)
  }
  for (const scenario of [
    { intent: 'commercial', tier: 'validation' },
    { intent: 'validation-only', tier: 'commercial' },
    { intent: 'validation-only', tier: 'production' },
  ]) {
    const result = runBash(command, { ACTIVATE_SCRIPT: activateScript, INTENT: scenario.intent, TIER: scenario.tier })
    assert.notEqual(result.status, 0)
  }
})

test('bundle verifier rejects archive tampering and OCI revision mismatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-bundle-verifier-'))
  try {
    const manifest = await createReleaseBundle(directory)
    const args = [bundleVerifier, '--directory', directory, '--expected-sha', manifest.releaseSha, '--expected-intent', 'validation-only']
    const valid = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.equal(valid.status, 0, valid.stderr)

    await writeFile(join(directory, manifest.archive), 'tampered')
    const tampered = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.notEqual(tampered.status, 0)

    await createReleaseBundle(directory, { imageRevision: '2'.repeat(40) })
    const mismatched = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.notEqual(mismatched.status, 0)
    assert.match(mismatched.stderr, /image revision mismatch/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('migration evidence marks destructive SQL and activation rejects changed history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-migration-policy-'))
  const migrationDirectory = join(directory, 'migrations')
  await mkdir(migrationDirectory)
  try {
    await writeFile(join(migrationDirectory, '001_expand.sql'), 'ALTER TABLE orders ADD COLUMN note TEXT;\n')
    await writeFile(join(migrationDirectory, '002_contract.sql'), 'DROP TABLE orders;\n')
    const generated = spawnSync(process.execPath, [migrationGenerator, '--directory', migrationDirectory], { encoding: 'utf8' })
    assert.equal(generated.status, 0, generated.stderr)
    const policy = JSON.parse(generated.stdout)
    assert.equal(policy.files[0].expandContractCompatible, true)
    assert.equal(policy.files[1].expandContractCompatible, false)
    assert.deepEqual(policy.files[1].blockingOperations, ['drop-object'])

    const current = join(directory, 'current.json')
    const safeCandidate = join(directory, 'safe.json')
    const changedCandidate = join(directory, 'changed.json')
    const destructiveCandidate = join(directory, 'destructive.json')
    const first = policy.files[0]
    await writeFile(current, JSON.stringify({ schemaVersion: 2, compatibilityPolicy: 'expand-contract-v1', files: [first] }))
    await writeFile(safeCandidate, JSON.stringify({ schemaVersion: 2, compatibilityPolicy: 'expand-contract-v1', files: [first, { filename: '003_more.sql', sha256: '5'.repeat(64), expandContractCompatible: true, blockingOperations: [] }] }))
    await writeFile(changedCandidate, JSON.stringify({ schemaVersion: 2, compatibilityPolicy: 'expand-contract-v1', files: [{ ...first, sha256: '6'.repeat(64) }] }))
    await writeFile(destructiveCandidate, JSON.stringify({ schemaVersion: 2, compatibilityPolicy: 'expand-contract-v1', files: [first, policy.files[1]] }))
    const command = 'source "$ACTIVATE_SCRIPT"; verify_expand_contract_migrations "$CURRENT" "$CANDIDATE"'
    assert.equal(runBash(command, { ACTIVATE_SCRIPT: activateScript, CURRENT: current, CANDIDATE: safeCandidate }).status, 0)
    assert.notEqual(runBash(command, { ACTIVATE_SCRIPT: activateScript, CURRENT: current, CANDIDATE: changedCandidate }).status, 0)
    assert.notEqual(runBash(command, { ACTIVATE_SCRIPT: activateScript, CURRENT: current, CANDIDATE: destructiveCandidate }).status, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('validation-only wrapper verifies evidence and exits before every remote command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-validation-wrapper-'))
  const bin = join(directory, 'bin')
  const fixtures = join(directory, 'fixtures')
  const quality = join(fixtures, `quality-evidence-${'1'.repeat(40)}`)
  const runtime = join(fixtures, `runtime-quality-${'1'.repeat(40)}`)
  const remoteMarker = join(directory, 'remote-command-ran')
  await mkdir(bin)
  await mkdir(quality, { recursive: true })
  await mkdir(runtime, { recursive: true })
  try {
    const manifest = await createReleaseBundle(directory)
    await writeFile(join(quality, 'ci-quality-evidence.json'), `${JSON.stringify({
      source: { commitSha: manifest.releaseSha },
      ci: { runId: '123' },
      decision: 'ALLOW',
    })}\n`)
    await writeFile(join(runtime, 'runtime.json'), '{"status":"pass"}\n')
    await sealDirectory(quality, ['ci-quality-evidence.json'])
    await sealDirectory(runtime, ['runtime.json'])

    await writeFile(join(bin, 'gh'), `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "run view" ]; then
  printf '%s\\n' '{"status":"completed","conclusion":"success","headSha":"${manifest.releaseSha}","event":"workflow_dispatch","headBranch":"fix/deploy-release-safety-chain"}'
  exit 0
fi
if [ "$1 $2" = "run download" ]; then
  name=
  destination=
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --name) name=$2; shift 2 ;;
      --dir) destination=$2; shift 2 ;;
      *) shift ;;
    esac
  done
  cp -R "$GH_FIXTURE_ROOT/$name/." "$destination/"
  exit 0
fi
printf 'unexpected gh call: %s\\n' "$*" >&2
exit 97
`)
    await writeFile(join(bin, 'ssh'), `#!/usr/bin/env bash
touch "$REMOTE_MARKER"
exit 98
`)
    await writeFile(join(bin, 'rsync'), `#!/usr/bin/env bash
touch "$REMOTE_MARKER"
exit 98
`)
    await writeFile(join(bin, 'scp'), `#!/usr/bin/env bash
touch "$REMOTE_MARKER"
exit 98
`)
    await Promise.all(['gh', 'ssh', 'rsync', 'scp'].map((name) => chmod(join(bin, name), 0o755)))

    const result = spawnSync('bash', [deployScript, '--validation-only'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_FIXTURE_ROOT: fixtures,
        REMOTE_MARKER: remoteMarker,
        MBOX_RELEASE_BUNDLE_DIR: directory,
        MBOX_CI_RUN_ID: '123',
        MBOX_SSH_KEY_PATH: join(directory, 'missing-private-key'),
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /validation_only=bundle-verified/)
    assert.match(result.stdout, /deployment=skipped/)
    await assert.rejects(access(remoteMarker))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('CI identity verification rejects failed runs, wrong commits and wrong tag refs', () => {
  const verify = `
    source "$DEPLOY_SCRIPT"
    gh() { printf '%s\\n' "$RUN_JSON"; }
    verify_ci_run_identity 123 "$EXPECTED_SHA" "$EXPECTED_EVENT" "$EXPECTED_REF"
  `
  const sha = '1'.repeat(40)
  const base = {
    DEPLOY_SCRIPT: deployScript,
    EXPECTED_SHA: sha,
    EXPECTED_EVENT: 'push',
    EXPECTED_REF: 'v1.0.0-rc.68',
  }
  const valid = runBash(verify, {
    ...base,
    RUN_JSON: JSON.stringify({ status: 'completed', conclusion: 'success', headSha: sha, event: 'push', headBranch: 'v1.0.0-rc.68' }),
  })
  assert.equal(valid.status, 0, valid.stderr)
  for (const run of [
    { status: 'completed', conclusion: 'failure', headSha: sha, event: 'push', headBranch: 'v1.0.0-rc.68' },
    { status: 'completed', conclusion: 'success', headSha: '2'.repeat(40), event: 'push', headBranch: 'v1.0.0-rc.68' },
    { status: 'completed', conclusion: 'success', headSha: sha, event: 'push', headBranch: 'v1.0.0-rc.67' },
  ]) {
    assert.notEqual(runBash(verify, { ...base, RUN_JSON: JSON.stringify(run) }).status, 0)
  }
})

test('required artifact download fails closed when GitHub quota or storage blocks it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-artifact-fail-'))
  try {
    const result = runBash(`
      source "$DEPLOY_SCRIPT"
      gh() { return 1; }
      download_required_artifact 123 mbox-image-deadbeef "$OUTPUT"
    `, { DEPLOY_SCRIPT: deployScript, OUTPUT: directory })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /quota exhaustion is a release failure/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('archive identity verification rejects changed config bytes and mismatched identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-image-archive-'))
  const content = Buffer.from('{"architecture":"amd64","config":{"Labels":{}}}\n')
  const digest = createHash('sha256').update(content).digest('hex')
  const configName = `${digest}.json`
  const manifest = [{ Config: configName, RepoTags: ['mbox:test'], Layers: [] }]
  await writeFile(join(directory, configName), content)
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
  const validArchive = join(directory, 'valid.tar')
  const tamperedArchive = join(directory, 'tampered.tar')
  const tarResult = spawnSync('tar', ['-cf', validArchive, '-C', directory, 'manifest.json', configName], { encoding: 'utf8' })
  assert.equal(tarResult.status, 0, tarResult.stderr)
  await writeFile(join(directory, configName), '{"tampered":true}\n')
  const tamperedResult = spawnSync('tar', ['-cf', tamperedArchive, '-C', directory, 'manifest.json', configName], { encoding: 'utf8' })
  assert.equal(tamperedResult.status, 0, tamperedResult.stderr)
  const verify = 'source "$ACTIVATE_SCRIPT"; verify_archive_image_identity "$ARCHIVE" mbox:test "$EXPECTED"'
  try {
    const valid = runBash(verify, {
      ACTIVATE_SCRIPT: activateScript,
      ARCHIVE: validArchive,
      EXPECTED: `sha256:${digest}`,
    })
    assert.equal(valid.status, 0, valid.stderr)

    const tampered = runBash(verify, {
      ACTIVATE_SCRIPT: activateScript,
      ARCHIVE: tamperedArchive,
      EXPECTED: `sha256:${digest}`,
    })
    assert.notEqual(tampered.status, 0)

    const mismatched = runBash(verify, {
      ACTIVATE_SCRIPT: activateScript,
      ARCHIVE: validArchive,
      EXPECTED: `sha256:${'f'.repeat(64)}`,
    })
    assert.notEqual(mismatched.status, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('loaded image, candidate and rollback checks use actual Docker identity', () => {
  const oldImage = `sha256:${'a'.repeat(64)}`
  const newImage = `sha256:${'b'.repeat(64)}`
  const oldSha = '1'.repeat(40)
  const shellPrelude = `
    source "$ACTIVATE_SCRIPT"
    docker() {
      if [ "$1" = image ] && [ "$2" = inspect ]; then printf '%s\\n' "$LOADED_IMAGE"; return 0; fi
      case "$*" in
        *'{{.Image}}'*) printf '%s\\n' "$CONTAINER_IMAGE" ;;
        *'org.opencontainers.image.revision'*) printf '%s\\n' "$CONTAINER_SHA" ;;
        *) return 91 ;;
      esac
    }
  `

  const loadedMismatch = runBash(`${shellPrelude}\nverify_loaded_image_identity mbox:test "$EXPECTED_IMAGE"`, {
    ACTIVATE_SCRIPT: activateScript,
    LOADED_IMAGE: oldImage,
    CONTAINER_IMAGE: newImage,
    CONTAINER_SHA: oldSha,
    EXPECTED_IMAGE: newImage,
  })
  assert.notEqual(loadedMismatch.status, 0)

  const candidateMismatch = runBash(`${shellPrelude}\nverify_container_image_identity candidate "$EXPECTED_IMAGE"`, {
    ACTIVATE_SCRIPT: activateScript,
    LOADED_IMAGE: newImage,
    CONTAINER_IMAGE: oldImage,
    CONTAINER_SHA: oldSha,
    EXPECTED_IMAGE: newImage,
  })
  assert.notEqual(candidateMismatch.status, 0)

  const validRollback = runBash(`${shellPrelude}\nverify_rollback_identity mbox-app "$EXPECTED_IMAGE" "$EXPECTED_SHA" "$READY"`, {
    ACTIVATE_SCRIPT: activateScript,
    LOADED_IMAGE: newImage,
    CONTAINER_IMAGE: oldImage,
    CONTAINER_SHA: oldSha,
    EXPECTED_IMAGE: oldImage,
    EXPECTED_SHA: oldSha,
    READY: JSON.stringify({ status: 'ready', releaseSha: oldSha, releaseImageDigest: oldImage }),
  })
  assert.equal(validRollback.status, 0, validRollback.stderr)

  const wrongRollbackApi = runBash(`${shellPrelude}\nverify_rollback_identity mbox-app "$EXPECTED_IMAGE" "$EXPECTED_SHA" "$READY"`, {
    ACTIVATE_SCRIPT: activateScript,
    LOADED_IMAGE: newImage,
    CONTAINER_IMAGE: oldImage,
    CONTAINER_SHA: oldSha,
    EXPECTED_IMAGE: oldImage,
    EXPECTED_SHA: oldSha,
    READY: JSON.stringify({ status: 'ready', releaseSha: '2'.repeat(40), releaseImageDigest: oldImage }),
  })
  assert.notEqual(wrongRollbackApi.status, 0)
})

test('deployment chain is fail-closed at immutable identity and environment boundaries', async () => {
  const deploy = await readFile(deployScript, 'utf8')
  const activate = await readFile(activateScript, 'utf8')
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const readme = await readFile(new URL('../deploy/aliyun/README.md', import.meta.url), 'utf8')
  assert.ok(deploy.indexOf('enforce_release_intent') < deploy.indexOf('ssh "${ssh_options[@]}"'))
  assert.ok(deploy.indexOf('validation_only=bundle-verified') < deploy.indexOf('test -f "${ssh_key}"'))
  assert.match(deploy, /sudo -n bash -s/)
  assert.match(activate, /verify_archive_image_identity "\$\{archive\}"/)
  assert.match(activate, /verify_loaded_image_identity "\$\{image_tag\}"/)
  assert.match(activate, /verify_container_image_identity "\$\{candidate\}"/)
  assert.match(activate, /verify_container_release_identity "\$\{active_container\}"/)
  assert.match(activate, /read_server_deployment_tier "\$\{server_environment_marker\}"/)
  assert.match(activate, /direct root deployment is forbidden/)
  assert.doesNotMatch(activate, /pg_restore/)
  assert.ok(activate.indexOf('trap rollback_on_error ERR INT TERM') < activate.indexOf('node dist-server/server/migrate.js'))
  assert.match(activate, /commercialRelease: \(\$releaseIntent == "commercial"\)/)
  assert.match(workflow, /release_intent:[\s\S]*options:[\s\S]*- commercial[\s\S]*- validation-only/)
  assert.match(workflow, /MBOX_BUNDLE_RELEASE_INTENT:.*inputs\.release_intent.*commercial/)
  assert.match(workflow, /Download the exact image bundle for independent verification/)
  assert.match(workflow, /node scripts\/verify-release-bundle\.mjs/)
  assert.doesNotMatch(workflow, /Upload the exact image used by validation and deployment\n\s+if:/)
  assert.match(readme, /gh workflow run ci\.yml[\s\S]*release_intent=validation-only/)
  assert.match(readme, /never connects to the ECS instance or activates a[\s\S]*container/)
})
