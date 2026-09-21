import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

function functions(platform, page, names) {
  const file = new URL(`../${platform}/pages/${page}/index.js`, import.meta.url)
  const source = readFileSync(file, 'utf8')
  const tree = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const definitions = tree.statements.filter((node) =>
    ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
    || ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => names.includes(declaration.name.getText(tree))))
  return vm.runInNewContext(`${definitions.map((node) => node.getText(tree)).join('\n')}\n({${names.filter((name) => name[0] === name[0].toLowerCase()).join(',')}})`,
    { dateTime: (value) => value || '', TASK_STATUS: {} })
}

for (const platform of ['miniprogram', 'alipay-miniprogram']) {
  test(`${platform}: ordinary service keeps authoritative acknowledged state through completion`, () => {
    const { serviceSummaryView } = functions(platform, 'order', ['SERVICE_STATUS_NAMES', 'ACTIVE_SERVICE_STATUSES', 'serviceSummaryView'])
    for (const [status, label] of [['pending', '等待接单'], ['acknowledged', '服务人员已接单'], ['in_progress', '正在处理'], ['completed', '等待您确认']]) {
      assert.equal(serviceSummaryView([{ status, publicId: 'request-1', guestConfirmedAt: null }], '').label, label)
    }
    const confirmed = { status: 'completed', guestConfirmedAt: '2026-09-21T00:00:00Z', publicId: 'request-1' }
    assert.equal(serviceSummaryView([confirmed], '').status, 'ready')
    assert.equal(serviceSummaryView([confirmed, { publicId: 'request-2', status: 'acknowledged' }], '').status, 'acknowledged')
  })

  test(`${platform}: confirmation is separate from employee completion and survives normalized readback`, () => {
    const { normalizeTask } = functions(platform, 'status', ['REQUEST_TYPE_NAMES', 'SERVICE_STATUS_NAMES', 'ACTIVE_SERVICE_STATUSES', 'normalizeTask'])
    const task = { publicId: 'request-1', requestType: 'call_staff', status: 'completed', guestConfirmedAt: null }
    assert.equal(normalizeTask(task).canConfirm, true)
    assert.equal(normalizeTask(task).statusText, '等待您确认')
    const confirmed = normalizeTask({ ...task, guestConfirmedAt: '2026-09-21T00:00:00Z' })
    assert.equal(confirmed.status, 'completed')
    assert.equal(confirmed.statusText, '已解决')
    assert.equal(confirmed.canConfirm, false)
    assert.equal(confirmed.canEscalate, false)
    assert.equal(normalizeTask({ ...task, status: 'acknowledged' }).canEscalate, true)
    assert.equal(normalizeTask({ ...task, status: 'acknowledged' }).canConfirm, false)
  })
}
