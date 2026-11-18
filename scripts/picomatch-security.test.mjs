import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const pm = require('picomatch')
const root = resolve(import.meta.dirname, '..')
const vendor = resolve(root, 'vendor/picomatch')
const archive = resolve(vendor, 'mbox-picomatch-4.0.7-mbox.2.tgz')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const hash = value => createHash('sha256').update(value).digest('hex')

test('all glob consumers resolve the reviewed fork and locked archive, not an unaudited fallback', () => {
  const provenance = readJson(resolve(vendor, 'provenance.json'))
  const lock = readJson(resolve(root, 'package-lock.json'))
  const packageInfo = require('picomatch/package.json')
  assert.equal(packageInfo.name, '@mbox/picomatch')
  assert.equal(packageInfo.version, '4.0.7-mbox.2')
  const entries = Object.entries(lock.packages).filter(([key]) => key.endsWith('/picomatch'))
  assert.equal(entries.length, 1)
  assert.equal(entries[0][1].name, '@mbox/picomatch')
  assert.equal(entries[0][1].integrity, `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`)
  for (const name of ['vite', 'vitest', 'tinyglobby', 'fdir']) {
    const consumer = createRequire(require.resolve(`${name}/package.json`))
    assert.equal(consumer.resolve('picomatch'), require.resolve('picomatch'), name)
  }
  for (const [file, expected] of Object.entries(provenance.sourceHashes)) {
    const source = readFileSync(resolve(vendor, file))
    assert.equal(hash(source), expected, `reviewed source: ${file}`)
    assert.equal(hash(readFileSync(resolve(require.resolve('picomatch/package.json'), '..', file))), expected, `installed: ${file}`)
    assert.equal(hash(execFileSync('tar', ['-xOf', archive, `package/${file}`])), expected, `archive: ${file}`)
    assert.equal(expected === provenance.upstreamHashes[file], !provenance.changedSourceFiles.includes(file), `upstream diff: ${file}`)
  }
  assert.deepEqual(provenance.changedSourceFiles, ['lib/parse.js'])
  for (const file of ['package.json', 'LICENSE', 'SECURITY.md']) {
    assert.deepEqual(execFileSync('tar', ['-xOf', archive, `package/${file}`]), readFileSync(resolve(vendor, file)))
  }
})

test('published exploit and nested variants fail before regex construction, even with recursion guard disabled', () => {
  const patterns = ['+(*)', '*(*a)', '+(*a)', '+(a*)', '+([ab]*)', '+(@(*a))', '+(+(*a))', '+(+(a))', '*(*(a))', '+(a|*b)', 'prefix/+(*a)b', '**/+(*a).ts', '+(a*|b)', '+("x"*)', '+(\\**)', '+([*]*)', '+(a+)', '+((a+))', '+([a]+)', '+((ab|abab))', '+(ab|abab)', '+(a|[a])', '+(a|"a")', '+(a|a)', '+(a|)', '+({a,aa})']
  // A separate process timeout prevents a regression from hanging the test runner.
  const result = spawnSync(process.execPath, ['--input-type=commonjs', '-e', `
    const assert = require('node:assert/strict');
    for (const entry of ['picomatch', 'picomatch/posix']) {
      const pm = require(entry);
      for (const pattern of ${JSON.stringify(patterns)}) {
        for (const options of [{}, {capture:true}, {fastpaths:false}, {maxExtglobRecursion:false}, {maxExtglobRecursion:1000}, {dot:true,windows:true}, {contains:true}]) {
          for (const fn of [() => pm(pattern, options)('a'.repeat(100000)+'!'), () => pm.makeRe(pattern, options), () => pm.parse(pattern, options)]) {
            assert.throws(fn, e => e instanceof SyntaxError && e.code === 'ERR_UNSAFE_EXTGLOB', pattern);
          }
        }
      }
    }
  `], { cwd: root, timeout: 3000, encoding: 'utf8' })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr)
})

test('ordinary globs, finite extglobs, escaped stars, classes, exclusions and public APIs retain behavior', () => {
  for (const [pattern, yes, no] of [
    ['src/**/*.{ts,tsx}', 'src/ui/index.tsx', 'src/ui/index.js'],
    ['**/*.test.ts', 'server/channel.test.ts', 'server/channel.ts'],
    ['file.@(js|ts)', 'file.ts', 'file.css'],
    ['+(ab|cd)', 'abcdab', 'abce'],
    ['+([ab])', 'abba', 'abca'],
    ['+(\\*)', '***', 'abc'],
    ['+("*")', '***', 'abc'],
    ['+([*])', '***', 'abc'],
    ['**/!(*.test).ts', 'src/main.ts', 'src/main.test.ts'],
    ['?(foo).js', 'foo.js', 'bar.js'],
    ['**/[a-z]?.js', 'lib/a1.js', 'lib/ab1.js'],
  ]) {
    assert.equal(pm(pattern)(yes), true, pattern)
    assert.equal(pm(pattern)(no), false, pattern)
    assert.equal(pm.makeRe(pattern).test(yes), true, pattern)
  }
  assert.equal(pm('**/*', { dot: true, ignore: '**/*.secret' })('config/.env'), true)
  assert.equal(pm('**/*', { dot: true, ignore: '**/*.secret' })('config/a.secret'), false)
  assert.equal(pm(['**/*.ts', '**/*.css'])('src/a.css'), true)
  assert.equal(pm('*.TS', { nocase: true, basename: true })('src/main.ts'), true)
  assert.equal(pm('src/*.ts', { windows: true })('src\\main.ts'), true)
  assert.equal(pm.scan('src/**/*.{ts,tsx}').base, 'src')
  assert.equal(pm.isMatch('foo.ts', '*.ts'), true)
  const events = []
  const result = pm('*.ts', { onResult: () => events.push('result'), onMatch: () => events.push('match') })('a.ts', true)
  assert.equal(result.isMatch, true)
  assert.deepEqual(events, ['result', 'match'])
  assert.equal(pm('+(*a)', { noextglob: true })('+(*a)'), true)
  // Upstream treats a leading question mark as literal syntax, not an extglob.
  // Keep that behavior; these expressions contain only a single quantifier.
  for (const pattern of ['+(?*)', '+(?(*a))']) {
    assert.equal(pm(pattern)('a'.repeat(100000) + '!'), false)
    assert.match(pm.makeRe(pattern).source, /\\\+/)
  }
})

test('tinyglobby and fdir retain discovery, dotfile, ignore and sync/async semantics', async () => {
  const { glob, globSync } = await import('tinyglobby')
  const { fdir } = await import('fdir')
  const directory = mkdtempSync(resolve(tmpdir(), 'mbox-glob-'))
  const files = ['src/a.ts', 'src/b.tsx', 'src/a.test.ts', 'src/.hidden.ts', 'src/nested/c.ts', 'src/nested/no.js', 'dist/generated.ts', 'node_modules/x.ts', 'src/star(name).ts']
  try {
    for (const file of files) { mkdirSync(resolve(directory, file, '..'), { recursive: true }); writeFileSync(resolve(directory, file), '') }
    const options = { cwd: directory, dot: true, ignore: ['**/*.test.ts', 'dist/**', 'node_modules/**'] }
    const expected = ['src/.hidden.ts', 'src/a.ts', 'src/b.tsx', 'src/nested/c.ts', 'src/star(name).ts']
    assert.deepEqual((await glob('**/*.{ts,tsx}', options)).sort(), expected)
    assert.deepEqual(globSync('**/*.{ts,tsx}', options).sort(), expected)
    assert.deepEqual(new fdir().withRelativePaths().glob('**/*.tsx').crawl(directory).sync(), ['src/b.tsx'])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('release containers and CI include the security fork and mandatory exploit gate', () => {
  const docker = readFileSync(resolve(root, 'Dockerfile'), 'utf8')
  assert.equal(docker.split('COPY vendor/picomatch/mbox-picomatch-4.0.7-mbox.2.tgz ./vendor/picomatch/').length - 1, 2)
  const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
  assert.match(ci, /npm run test:glob-security/)
  assert.match(ci, /npm audit --audit-level=moderate/)
})
