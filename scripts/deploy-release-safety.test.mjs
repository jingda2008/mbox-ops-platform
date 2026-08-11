import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const deployScript = fileURLToPath(new URL('../deploy/aliyun/deploy-release.sh', import.meta.url))
const activateScript = fileURLToPath(new URL('../deploy/aliyun/activate-release.sh', import.meta.url))

function runBash(source, env = {}) {
  return spawnSync('bash', ['-c', source], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
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
      enforce_release_intent "$MANIFEST" 0 production
    `, { DEPLOY_SCRIPT: deployScript, MANIFEST: manifest, NPM_LOG: npmLog })
    assert.equal(success.status, 0, success.stderr)
    assert.equal(await readFile(npmLog, 'utf8'), 'run release:quality-gate\n')
    assert.match(success.stdout, /release_intent=commercial/)

    const failure = runBash(`
      npm() { return 23; }
      export -f npm
      source "$DEPLOY_SCRIPT"
      enforce_release_intent "$MANIFEST" 0 production
    `, { DEPLOY_SCRIPT: deployScript, MANIFEST: manifest })
    assert.equal(failure.status, 23)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('validation-only requires the argument, validation tier and manifest marker together', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-validation-intent-'))
  const marked = join(directory, 'marked.json')
  const commercial = join(directory, 'commercial.json')
  await writeFile(marked, '{"releaseIntent":"validation-only"}\n')
  await writeFile(commercial, '{"releaseIntent":"commercial"}\n')
  const shell = 'source "$DEPLOY_SCRIPT"; enforce_release_intent "$MANIFEST" "$EXPLICIT" "$TIER"'
  try {
    const allowed = runBash(shell, {
      DEPLOY_SCRIPT: deployScript,
      MANIFEST: marked,
      EXPLICIT: '1',
      TIER: 'validation',
    })
    assert.equal(allowed.status, 0, allowed.stderr)
    assert.match(allowed.stdout, /commercial_release=false/)

    for (const scenario of [
      { manifest: commercial, explicit: '1', tier: 'validation' },
      { manifest: marked, explicit: '0', tier: 'validation' },
      { manifest: marked, explicit: '1', tier: 'production' },
    ]) {
      const denied = runBash(shell, {
        DEPLOY_SCRIPT: deployScript,
        MANIFEST: scenario.manifest,
        EXPLICIT: scenario.explicit,
        TIER: scenario.tier,
      })
      assert.notEqual(denied.status, 0, `unexpectedly allowed ${JSON.stringify(scenario)}`)
    }
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

test('activation checks each immutable identity boundary and records non-commercial intent', async () => {
  const deploy = await readFile(deployScript, 'utf8')
  const activate = await readFile(activateScript, 'utf8')
  assert.match(deploy, /MBOX_DEPLOYMENT_TIER:-validation/)
  assert.ok(deploy.indexOf('enforce_release_intent') < deploy.indexOf('ssh "${ssh_options[@]}"'))
  assert.match(activate, /verify_archive_image_identity "\$\{archive\}"/)
  assert.match(activate, /verify_loaded_image_identity "\$\{image_tag\}"/)
  assert.match(activate, /verify_container_image_identity "\$\{candidate\}"/)
  assert.match(activate, /verify_container_release_identity "\$\{active_container\}"/)
  assert.match(activate, /commercialRelease: \(\$releaseIntent == "commercial"\)/)
})
