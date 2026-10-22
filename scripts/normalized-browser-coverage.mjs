import { basename } from 'node:path'

export function reportCases(report) {
  const cases = []
  const visit = suite => {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        cases.push({ file: basename(spec.file || suite.file), title: spec.title, status: test.status === 'expected' && test.expectedStatus && test.expectedStatus !== 'passed' ? 'unexpected' : test.status })
      }
    }
    for (const child of suite.suites || []) visit(child)
  }
  visit(report)
  return cases
}

export function reconcileBrowserCoverage(baseline, dedicated) {
  const invalidReports = [!reportCases(baseline).length ? 'baseline' : null, ...dedicated.filter(item => !reportCases(item.report).length).map(item => item.name)].filter(Boolean)
  const key = item => `${item.file}:${item.title}`
  const dedicatedCases = dedicated.flatMap(({ name, report }) => reportCases(report).map(item => ({ ...item, group: name })))
  const skipped = reportCases(baseline).filter(item => item.status === 'skipped').map(item => ({
    ...item,
    passedIn: dedicatedCases.filter(candidate => key(candidate) === key(item) && candidate.status === 'expected').map(candidate => candidate.group),
  }))
  const uncovered = skipped.filter(item => !item.passedIn.length)
  const failed = [...reportCases(baseline), ...dedicatedCases].filter(item => !['expected', 'skipped'].includes(item.status))
  return { passed: !invalidReports.length && !uncovered.length && !failed.length, invalidReports, baselineSkipped: skipped.length, covered: skipped.length - uncovered.length, skipped, uncovered, failed }
}
