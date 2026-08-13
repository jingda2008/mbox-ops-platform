import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, extname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const textExtensions = new Set([
  '.csv', '.html', '.js', '.json', '.jsonl', '.log', '.md', '.mjs', '.sh', '.sha256', '.svg', '.ts', '.txt', '.xml', '.yaml', '.yml',
])

const extensionlessTextFiles = new Set(['SHA256SUMS'])

const forbiddenArtifactExtensions = new Set([
  '.env', '.gif', '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.pdf', '.png', '.webp', '.wav',
])

const rules = [
  { id: 'private-key', expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'alibaba-access-key', expression: /\bLTAI[A-Za-z0-9]{12,}\b/ },
  { id: 'model-api-key', expression: /\bsk-[A-Za-z0-9._-]{20,}\b/ },
  { id: 'bearer-credential', expression: /\bBearer\s+[A-Za-z0-9._~-]{20,}/i },
  { id: 'url-or-field-token', expression: /(?:[?&]|\b)(?:token|access_token|authorization)[=:]["']?(?!REDACTED\b)[A-Za-z0-9._~-]{20,}/i },
  { id: 'database-password', expression: /postgres(?:ql)?:\/\/[^\s:@/]+:(?!\*{3})[^\s@/]+@/i },
  // Do not interpret an 11-digit run inside a SHA256 or other hex identifier
  // as a Chinese mobile number. Real serialized phone values still have a
  // quote, delimiter or whitespace at both boundaries and remain detectable.
  { id: 'raw-mobile-number', expression: /(?<![0-9a-f])1[3-9]\d{9}(?![0-9a-f])/i },
  // A checksum can contain 18 consecutive decimal digits. Require hexadecimal
  // boundaries so such a run is not mistaken for an identity number, while a
  // serialized identity value next to quotes or delimiters remains blocked.
  { id: 'raw-chinese-id', expression: /(?<![0-9a-f])\d{17}[\dX](?![0-9a-f])/i },
]

const forbiddenJsonKeys = new Set([
  'accesskeyid', 'accesskeysecret', 'apikey', 'authorization', 'cookie', 'databaseurl', 'idcard',
  'paymentpayload', 'phonenumber', 'rawrequestbody', 'requestbody', 'secret', 'token',
])

async function filesUnder(root) {
  const output = []
  async function visit(path) {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new Error(`evidence must not contain symlinks: ${relative(root, path)}`)
    if (stat.isDirectory()) {
      for (const entry of await readdir(path)) await visit(resolve(path, entry))
      return
    }
    if (stat.isFile()) output.push(path)
  }
  await visit(root)
  return output.toSorted()
}

function inspectJsonKeys(value, location, findings) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectJsonKeys(entry, `${location}[${index}]`, findings))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()
    if (forbiddenJsonKeys.has(normalized) && child !== null && child !== '' && child !== 'REDACTED') {
      findings.push({ rule: 'forbidden-json-field', location: `${location}.${key}` })
    }
    inspectJsonKeys(child, `${location}.${key}`, findings)
  }
}

export async function inspectEvidenceDirectory(rootInput) {
  const root = resolve(rootInput)
  const findings = []
  for (const path of await filesUnder(root)) {
    const extension = extname(path).toLowerCase()
    const file = relative(root, path)
    if (forbiddenArtifactExtensions.has(extension)) {
      findings.push({ file, rule: 'uninspectable-or-sensitive-artifact' })
      continue
    }
    if ((!extension && !extensionlessTextFiles.has(basename(path)))
      || (extension && !textExtensions.has(extension))) {
      findings.push({ file, rule: 'unapproved-artifact-extension' })
      continue
    }
    const bytes = await readFile(path)
    let content
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      findings.push({ file, rule: 'invalid-text-encoding' })
      continue
    }
    if (content.includes('\0')) {
      findings.push({ file, rule: 'binary-content-in-text-artifact' })
      continue
    }
    for (const rule of rules) {
      const match = rule.expression.exec(content)
      if (match) findings.push({ file, rule: rule.id, line: content.slice(0, match.index).split('\n').length })
    }
    if (extension === '.json' || extension === '.jsonl') {
      const documents = extension === '.jsonl'
        ? content.split('\n').filter(Boolean)
        : [content]
      documents.forEach((document, index) => {
        try {
          inspectJsonKeys(JSON.parse(document), index ? `$line${index + 1}` : '$', findings)
        } catch {
          findings.push({ file, rule: 'invalid-json', line: index + 1 })
        }
      })
    }
  }
  return findings
}

async function main() {
  const root = process.argv[2]
  if (!root) throw new Error('usage: node scripts/verify-sensitive-artifacts.mjs <directory>')
  const findings = await inspectEvidenceDirectory(root)
  if (findings.length) {
    for (const finding of findings) {
      process.stderr.write(`${finding.file ?? finding.location}:${finding.line ?? '-'} ${finding.rule}\n`)
    }
    throw new Error(`sensitive artifact verification failed with ${findings.length} finding(s)`)
  }
  process.stdout.write('sensitive artifact verification passed\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
