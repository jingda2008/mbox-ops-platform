import { access, readFile } from 'node:fs/promises'

const path = process.argv[2] ?? 'docs/quality/release-incident-register-v1.json'
const document = JSON.parse(await readFile(path, 'utf8'))
if (document.schemaVersion !== 1 || !Array.isArray(document.incidents) || document.incidents.length === 0) {
  throw new Error('release incident register is invalid')
}
const ids = new Set()
for (const incident of document.incidents) {
  if (!/^REL-\d{3}$/.test(incident.id) || ids.has(incident.id)) throw new Error(`invalid incident id: ${incident.id}`)
  ids.add(incident.id)
  for (const field of ['category', 'rootCause', 'earliestDetectionStage', 'regressionTest', 'automaticBlocker', 'fixCommit']) {
    if (typeof incident[field] !== 'string' || incident[field].trim() === '') {
      throw new Error(`${incident.id} is missing ${field}`)
    }
  }
  if (incident.status !== 'covered') throw new Error(`${incident.id} has no permanent regression coverage`)
  await access(incident.regressionTest)
}
process.stdout.write(`Verified ${ids.size} release incidents with permanent blockers.\n`)
