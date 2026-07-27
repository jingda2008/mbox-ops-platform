import { execFileSync } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { classifyChangedPaths } from './ci-change-scope.mjs'

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

const event = option('event') ?? process.env.GITHUB_EVENT_NAME ?? 'local'
const ref = option('ref') ?? process.env.GITHUB_REF ?? ''
const head = option('head') ?? process.env.GITHUB_SHA ?? 'HEAD'
let base = option('base')
const forceFull = event === 'workflow_dispatch' || ref.startsWith('refs/tags/')

if (!base || /^0+$/.test(base)) {
  try {
    base = git('rev-parse', `${head}^`)
  } catch {
    base = undefined
  }
}

let paths = []
if (base) {
  paths = git('diff', '--name-only', '--diff-filter=ACMRTUXB', base, head).split('\n').filter(Boolean)
}

const result = classifyChangedPaths(paths, { forceFull })
const githubOutput = option('github-output') ?? process.env.GITHUB_OUTPUT
if (githubOutput) {
  await appendFile(githubOutput, [
    `scope=${result.scope}`,
    `docs_only=${String(result.docsOnly)}`,
    `full=${String(result.full)}`,
    `migration_changed=${String(result.migrationChanged)}`,
    `reason=${result.reason}`,
    '',
  ].join('\n'))
}

process.stdout.write(`${JSON.stringify({ base: base ?? null, head, event, ref, ...result }, null, 2)}\n`)
