import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const deployDir = resolve(root, 'deploy/normalized')
const shellFiles = readdirSync(deployDir).filter((name) => name.endsWith('.sh')).toSorted()

test('all normalized deployment scripts use strict shell mode', () => {
  assert.ok(shellFiles.length >= 8)
  for (const filename of shellFiles) {
    const source = readFileSync(resolve(deployDir, filename), 'utf8')
    assert.match(source, /^#!\/usr\/bin\/env bash\nset -Eeuo pipefail\n/)
  }
})

test('normalized Dockerfile is isolated, non-root, immutable and readiness checked', () => {
  const source = readFileSync(resolve(root, 'Dockerfile.normalized'), 'utf8')
  assert.match(source, /FROM node:24-alpine AS build/)
  assert.match(source, /npm run build:normalized/)
  assert.match(source, /dist-normalized\/server\/normalized-server\.js/)
  assert.match(source, /\.\/dist-normalized\/database\/normalized-migrations/)
  assert.match(source, /USER node/)
  assert.match(source, /http:\/\/127\.0\.0\.1:\$\{PORT\}\/api\/ready/)
  assert.doesNotMatch(source, /http:\/\/localhost:\$\{PORT\}\/api\/ready/)
  assert.doesNotMatch(source, /dist-server\/server\/index\.js/)
  assert.doesNotMatch(source, /database\/migrations(?:\s|\/)/)
})

test('database initializer accepts only a new empty database and normalized migrations', () => {
  const source = readFileSync(resolve(deployDir, 'initialize-empty-database.mjs'), 'utf8')
  assert.match(source, /table_count !== 0/)
  assert.match(source, /runNormalizedMigrations/)
  assert.doesNotMatch(source, /runtime_states/)
  assert.doesNotMatch(source, /database\/migrations(?:['"`/])/)
})

test('deployment scripts contain no embedded public endpoint or secret assignment', () => {
  const sources = [
    readFileSync(resolve(root, 'Dockerfile.normalized'), 'utf8'),
    ...readdirSync(deployDir)
      .filter((name) => !name.endsWith('.test.mjs'))
      .map((name) => readFileSync(resolve(deployDir, name), 'utf8')),
  ].join('\n')
  const publicEndpointSources = sources.replaceAll('127.0.0.1', '<loopback>')
  assert.doesNotMatch(publicEndpointSources, /(?:^|[^0-9])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?:[^0-9]|$)/m)
  assert.doesNotMatch(sources, /(?:AccessKey|Secret|Password)\s*[=:]\s*[A-Za-z0-9+/_.-]{12,}/i)
})

test('mutating entrypoints are dry-run by default and never invoke Docker', () => {
  const temp = mkdtempSync(join(tmpdir(), 'mbox-normalized-deploy-'))
  const envFile = join(temp, 'candidate.env')
  const storeConfigFile = join(temp, 'store.json')
  const catalogConfigFile = join(temp, 'catalog.json')
  const fakeBin = join(temp, 'bin')
  execFileSync('mkdir', ['-p', fakeBin])
  writeFileSync(envFile, 'NODE_ENV=production\n', { mode: 0o600 })
  writeFileSync(storeConfigFile, '{}\n', { mode: 0o600 })
  writeFileSync(catalogConfigFile, '{}\n', { mode: 0o600 })
  writeFileSync(join(fakeBin, 'docker'), '#!/bin/sh\nexit 97\n', { mode: 0o700 })

  const baseEnv = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    IMAGE_REF: 'mbox-normalized:test',
    APP_COMMIT_SHA: 'abcdef1234567',
    EXPECTED_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
    ENV_FILE: envFile,
    STORE_CONFIG_FILE: storeConfigFile,
    CATALOG_CONFIG_FILE: catalogConfigFile,
    CANDIDATE_CONTAINER_NAME: 'mbox-normalized-candidate-test',
    CANDIDATE_BIND_ADDRESS: '<loopback-address>',
    CANDIDATE_HOST_PORT: '18787',
    CANDIDATE_BASE_URL: 'http://localhost:18787',
    CURRENT_HEALTH_URL: 'https://current-service.example.test',
    PUBLIC_BASE_URL: 'https://public-service.example.test',
  }
  for (const script of [
    'build-image.sh',
    'initialize-empty-database.sh',
    'provision-store.sh',
    'start-candidate.sh',
    'verify-candidate.sh',
    'pre-cutover-check.sh',
    'rollback-candidate.sh',
    'activate-candidate.sh',
  ]) {
    execFileSync('bash', [resolve(deployDir, script)], { env: baseEnv, stdio: 'pipe' })
  }
})

test('candidate scripts protect the existing production container', () => {
  const common = readFileSync(resolve(deployDir, 'common.sh'), 'utf8')
  const rollback = readFileSync(resolve(deployDir, 'rollback-candidate.sh'), 'utf8')
  assert.match(common, /PROTECTED_CONTAINER_NAME='mbox-app'/)
  assert.match(common, /mbox-normalized-candidate-/)
  assert.match(rollback, /com\.mbox\.schema-flavor/)
  assert.doesNotMatch(rollback, /docker (?:stop|rm).*PROTECTED_CONTAINER_NAME/)
})

test('candidate verification rejects missing external worker integrations', () => {
  const source = readFileSync(resolve(deployDir, 'verify-candidate.sh'), 'utf8')
  assert.match(source, /deploymentTier === 'production'/)
  assert.match(source, /integrationWorkersEnabled !== true/)
  assert.match(source, /payment\.create\.postar/)
  assert.match(source, /refund\.execute\.postar/)
  assert.match(source, /candidate integration workers are not commercially ready/)
})

test('activation is atomic, verifies public identity and preserves a rollback container', () => {
  const source = readFileSync(resolve(deployDir, 'activate-candidate.sh'), 'utf8')
  assert.match(source, /ACTIVATE_VERIFIED_NORMALIZED_CANDIDATE/)
  assert.match(source, /verify_public_candidate 15/)
  assert.match(source, /rollback_container=/)
  assert.match(source, /rollback_on_error/)
  assert.match(source, /Caddyfile\.previous/)
  assert.match(source, /caddy_source=/)
  assert.match(source, /persistent_config_updated/)
  assert.match(source, /deployment-manifest\.json/)
  assert.doesNotMatch(source, /docker rm .*ACTIVE_CONTAINER_NAME/)
})

test('protected production name is rejected before Docker can be called', () => {
  const temp = mkdtempSync(join(tmpdir(), 'mbox-normalized-protected-'))
  const envFile = join(temp, 'candidate.env')
  const fakeBin = join(temp, 'bin')
  execFileSync('mkdir', ['-p', fakeBin])
  writeFileSync(envFile, 'NODE_ENV=production\n', { mode: 0o600 })
  writeFileSync(join(fakeBin, 'docker'), '#!/bin/sh\nexit 97\n', { mode: 0o700 })

  assert.throws(() => execFileSync('bash', [resolve(deployDir, 'start-candidate.sh')], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      IMAGE_REF: 'mbox-normalized:test',
      APP_COMMIT_SHA: 'abcdef1234567',
      EXPECTED_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
      ENV_FILE: envFile,
      CANDIDATE_CONTAINER_NAME: 'mbox-app',
      CANDIDATE_BIND_ADDRESS: '<loopback-address>',
      CANDIDATE_HOST_PORT: '18787',
      CANDIDATE_BASE_URL: 'http://localhost:18787',
    },
    stdio: 'pipe',
  }))
})
