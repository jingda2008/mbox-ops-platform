import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const project = process.env.MBOX_EVIDENCE_GCP_PROJECT
const service = process.env.MBOX_EVIDENCE_CLOUD_RUN_SERVICE
const region = process.env.MBOX_EVIDENCE_GCP_REGION

async function command(file, args, allowFailure = false) {
  try {
    const result = await exec(file, args, { maxBuffer: 20 * 1024 * 1024 })
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
  } catch (error) {
    if (!allowFailure) throw error
    return {
      ok: false,
      stdout: String(error.stdout ?? '').trim(),
      stderr: String(error.stderr ?? error.message ?? '').trim(),
    }
  }
}

function matchNumber(text, expression) {
  const matched = text.match(expression)
  return matched ? Number(matched[1]) : null
}

async function cloudEvidence() {
  if (!project || !service || !region) return { configured: false }
  const described = await command('gcloud', [
    'run', 'services', 'describe', service,
    '--project', project, '--region', region, '--format=json',
  ], true)
  if (!described.ok) return { configured: true, error: described.stderr || described.stdout }
  const document = JSON.parse(described.stdout)
  const container = document.spec?.template?.spec?.containers?.[0] ?? {}
  const environment = Object.fromEntries(
    (container.env ?? []).map((item) => [
      item.name,
      item.value ?? (item.valueFrom?.secretKeyRef ? `secret:${item.valueFrom.secretKeyRef.name}` : 'configured'),
    ]),
  )
  const publicUrl = document.status?.url
  let readiness = null
  if (publicUrl) {
    try {
      const response = await fetch(`${publicUrl}/api/ready`)
      readiness = { status: response.status, body: await response.json() }
    } catch (error) {
      readiness = { error: error instanceof Error ? error.message : String(error) }
    }
  }
  return {
    configured: true,
    project,
    service,
    region,
    revision: document.status?.latestReadyRevisionName ?? null,
    image: container.image ?? null,
    publicUrl: publicUrl ?? null,
    serviceAccount: document.spec?.template?.spec?.serviceAccountName ?? null,
    cloudSqlInstances: document.spec?.template?.metadata?.annotations?.['run.googleapis.com/cloudsql-instances'] ?? null,
    maxScale: document.spec?.template?.metadata?.annotations?.['autoscaling.knative.dev/maxScale'] ?? null,
    traffic: document.status?.traffic ?? [],
    environment,
    readiness,
  }
}

const generatedAt = new Date().toISOString()
const [commit, branch, status, packageJson] = await Promise.all([
  command('git', ['rev-parse', 'HEAD']),
  command('git', ['branch', '--show-current']),
  command('git', ['status', '--porcelain']),
  import('../package.json', { with: { type: 'json' } }),
])
const check = process.env.MBOX_EVIDENCE_SKIP_CHECK === '1'
  ? { ok: true, stdout: 'skipped by MBOX_EVIDENCE_SKIP_CHECK=1', stderr: '' }
  : await command('npm', ['run', 'check'], true)
const audit = await command('npm', ['audit', '--omit=dev', '--json'], true)
const combinedCheckOutput = `${check.stdout}\n${check.stderr}`
const evidence = {
  schemaVersion: 1,
  generatedAt,
  git: {
    commit: commit.stdout,
    branch: branch.stdout,
    clean: status.stdout.length === 0,
    changedPaths: status.stdout ? status.stdout.split('\n') : [],
  },
  application: { version: packageJson.default.version },
  verification: {
    checkPassed: check.ok,
    testFilesPassed: matchNumber(combinedCheckOutput, /Test Files\s+(\d+) passed/),
    testsPassed: matchNumber(combinedCheckOutput, /Tests\s+(\d+) passed/),
    miniprogramFiles: matchNumber(combinedCheckOutput, /verification passed \((\d+) files\)/),
  },
  dependencyAudit: {
    commandSucceeded: audit.ok,
    result: audit.ok ? JSON.parse(audit.stdout) : null,
    error: audit.ok ? null : audit.stderr || audit.stdout,
  },
  cloud: await cloudEvidence(),
}

await mkdir('.runtime', { recursive: true })
await writeFile('.runtime/release-evidence.json', `${JSON.stringify(evidence, null, 2)}\n`)
const cloud = evidence.cloud.configured
  ? `${evidence.cloud.project}/${evidence.cloud.region}/${evidence.cloud.service}，revision ${evidence.cloud.revision ?? 'unknown'}，镜像 ${evidence.cloud.image ?? 'unknown'}，仓储 ${evidence.cloud.environment?.MBOX_REPOSITORY ?? 'unknown'}`
  : '未提供云环境变量，本次未采集'
const markdown = `# M-Box 自动发布证据

> 本文件由 \`npm run evidence:capture\` 生成，禁止手工修改结论。

- 生成时间：${generatedAt}
- Commit：\`${evidence.git.commit}\`
- 分支：\`${evidence.git.branch}\`
- 工作树干净：${evidence.git.clean ? '是' : '否'}
- 全量检查：${evidence.verification.checkPassed ? 'PASS' : 'FAIL'}
- 测试：${evidence.verification.testFilesPassed ?? 'unknown'}个文件，${evidence.verification.testsPassed ?? 'unknown'}项
- 依赖审计：${evidence.dependencyAudit.commandSucceeded ? `${evidence.dependencyAudit.result?.metadata?.vulnerabilities?.total ?? 'unknown'}项漏洞` : `未取得结果：${evidence.dependencyAudit.error}`}
- 云端：${cloud}

机器可读证据：\`.runtime/release-evidence.json\`。
`
await writeFile('docs/release-evidence.generated.md', markdown)
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
