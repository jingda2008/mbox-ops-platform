export type VoicePageControlKind = 'button' | 'link' | 'input' | 'textarea' | 'select' | 'checkbox' | 'radio'
export type VoicePageRisk = 'normal' | 'high'
export type VoicePageZone = 'session' | 'navigation' | 'page'

export interface VoicePageControl {
  id: string
  kind: VoicePageControlKind
  label: string
  context: string
  displayName: string
  zone: VoicePageZone
  disabled: boolean
  generatedLabel: boolean
  sensitive: boolean
  risk: VoicePageRisk
  value?: string
  options?: Array<{ label: string; value: string; disabled: boolean }>
}

export type VoicePageAction = 'activate' | 'set_value' | 'select_option' | 'set_checked'

export type VoicePagePlan =
  | {
      kind: 'ready'
      controlId: string
      controlLabel: string
      context: string
      action: VoicePageAction
      value?: string
      optionLabel?: string
      checked?: boolean
      risk: VoicePageRisk
      summary: string
    }
  | { kind: 'ambiguous'; message: string; candidates: string[] }
  | { kind: 'blocked'; message: string }
  | { kind: 'unknown'; message: string }

export interface VoicePageExecutionResult {
  ok: boolean
  message: string
}

export interface VoicePageStateSnapshot {
  heading: string
  feedback: string[]
}

interface RuntimeVoicePageControl extends VoicePageControl {
  element: HTMLElement
}

const controlIds = new WeakMap<Element, string>()
let nextControlId = 1

const sensitiveFieldPattern = /pin|密码|密钥|secret|token|口令|验证码|付款码|银行卡|身份证/i
const highRiskPattern = /退款|支付|付款|收款|结台|翻台|转桌|换位|合台|加桌|拆回|赠送|折扣|确认发放|批准发放|入库|出库|盘点|报损|保存|删除|作废|重置|发布|权限|授权|撤销|清空|售罄|确认到账|关闭桌台|取消预约|切换员工|退出登录/i
const feedbackSelector = '[role="alert"], [role="status"], .notice-bar, .error-banner, .waitlist-notice, .offline-guard-notice'

function compactText(value: string | null | undefined, maximum = 80) {
  const compact = String(value ?? '').replace(/\s+/g, ' ').trim()
  return compact.length > maximum ? `${compact.slice(0, maximum - 1)}…` : compact
}

export function normalizeVoiceText(value: string) {
  return value
    .toLocaleLowerCase('zh-CN')
    .replace(/[，。！？、,.!?：:；;（）()【】“”"'\s·/\\_-]+/g, '')
}

export function classifyVoicePageRisk(
  label: string,
  options: { zone?: VoicePageZone; danger?: boolean; safeDisclosure?: boolean } = {},
): VoicePageRisk {
  if (options.zone === 'navigation' || options.safeDisclosure) return 'normal'
  return options.danger || highRiskPattern.test(label) ? 'high' : 'normal'
}

function controlId(element: Element) {
  const existing = controlIds.get(element)
  if (existing) return existing
  const id = `voice-control-${nextControlId}`
  nextControlId += 1
  controlIds.set(element, id)
  return id
}

function visibleForVoice(element: HTMLElement) {
  if (element.closest('[data-voice-ignore], [hidden], [aria-hidden="true"]')) return false
  const closedDetails = element.closest<HTMLDetailsElement>('details:not([open])')
  if (closedDetails && closedDetails.querySelector(':scope > summary') !== element) return false
  let current: HTMLElement | null = element
  while (current) {
    const style = window.getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    current = current.parentElement
  }
  return true
}

function directLabelText(element: HTMLElement) {
  const ariaLabel = compactText(element.getAttribute('aria-label'))
  if (ariaLabel) return ariaLabel
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy) {
    const labelledText = compactText(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '))
    if (labelledText) return labelledText
  }
  const title = compactText(element.getAttribute('title'))
  if (title) return title

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    const associated = element.labels?.[0]
    if (associated) {
      const labelHint = associated.querySelector(':scope > span, :scope > strong, :scope > small')
      const associatedText = compactText(labelHint?.textContent ?? associated.textContent)
      if (associatedText) return associatedText
    }
    const placeholder = compactText(element.getAttribute('placeholder'))
    if (placeholder) return placeholder
    const name = compactText(element.getAttribute('name'))
    if (name) return name
  }

  return compactText(element.innerText || element.textContent)
}

function textWithoutControls(container: Element, maximum = 60) {
  const clone = container.cloneNode(true) as HTMLElement
  clone.querySelectorAll('button, input, select, textarea, svg, option').forEach((item) => item.remove())
  return compactText(clone.textContent, maximum)
}

function tableControlLabel(element: HTMLElement) {
  const cell = element.closest<HTMLTableCellElement>('td, th')
  const row = cell?.parentElement
  const table = cell?.closest('table')
  if (!cell || !row || !table) return ''
  const cells = [...row.children]
  const columnIndex = cells.indexOf(cell)
  const headerRows = [...table.querySelectorAll<HTMLTableRowElement>('thead tr')]
  const headerCells = headerRows.length > 0 ? [...headerRows[headerRows.length - 1]!.children] : []
  const columnLabel = compactText(headerCells[columnIndex]?.textContent, 28)
  const rowLabel = textWithoutControls(row, 36)
  return compactText([rowLabel, columnLabel].filter(Boolean).join(' '), 64)
}

function structuralLabelText(element: HTMLElement) {
  const tableLabel = tableControlLabel(element)
  if (tableLabel) return tableLabel

  if (element instanceof HTMLInputElement && element.closest('.community-brand-highlights') && element.value.trim()) {
    return compactText(`活动关键词 ${element.value}`, 64)
  }

  const previousText = compactText(element.previousElementSibling?.textContent, 42)
  if (previousText) return previousText

  let container = element.parentElement
  for (let depth = 0; container && depth < 4; depth += 1, container = container.parentElement) {
    if (container.matches('form, section, article, main')) break
    const localText = textWithoutControls(container, 52)
    if (localText) return localText
  }

  if (element instanceof HTMLInputElement && element.type !== 'password' && element.value.trim()) {
    const group = element.closest<HTMLElement>('.community-brand-highlights, .config-section, .benefit-configuration')
    const groupName = compactText(group?.querySelector('h2, h3, h4, .config-section-title strong, :scope > div > strong')?.textContent, 28)
    return compactText(`${groupName ? `${groupName} ` : ''}${element.value}字段`, 64)
  }
  return ''
}

function controlContext(element: HTMLElement, label: string) {
  const container = element.closest<HTMLElement>('[role="dialog"], form, article, section, tr, .task-card, .approval-row, .table-service-toolbar, .table-business-toolbar, .script-config-row, .role-config-row, .minimum-rule-row, .master-row, [class*="-item"], [class*="-card"]')
  const contextHint = container?.querySelector<HTMLElement>('h1, h2, h3, h4, :scope > div > strong, .row-identity strong, .script-config-name strong, .table-code, .eyebrow, legend, header strong, .form-heading strong, .panel-heading strong')
  const siblingInput = element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement
    ? element.parentElement?.querySelector<HTMLInputElement>('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])')
    : null
  const tableRow = element.closest<HTMLTableRowElement>('tr')
  const tableContext = tableRow
    ? [...tableRow.children].map((cell) => textWithoutControls(cell, 32)).find(Boolean) ?? ''
    : ''
  const rowIdentityInput = container?.querySelector<HTMLInputElement>('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])')
  const localContext = compactText(siblingInput?.value || contextHint?.innerText || contextHint?.textContent || tableContext || rowIdentityInput?.value, 36)
  if (localContext && !normalizeVoiceText(label).includes(normalizeVoiceText(localContext))) return localContext
  const pageHeading = document.querySelector<HTMLElement>('.topbar h1')
  return compactText(pageHeading?.innerText || pageHeading?.textContent, 36)
}

function controlKind(element: HTMLElement): VoicePageControlKind | null {
  if (element instanceof HTMLButtonElement || element instanceof HTMLElement && element.tagName === 'SUMMARY') return 'button'
  if (element instanceof HTMLAnchorElement) return 'link'
  if (element instanceof HTMLTextAreaElement) return 'textarea'
  if (element instanceof HTMLSelectElement) return 'select'
  if (element instanceof HTMLInputElement) {
    if (element.type === 'hidden' || element.type === 'file') return null
    if (element.type === 'checkbox') return 'checkbox'
    if (element.type === 'radio') return 'radio'
    return 'input'
  }
  return null
}

function controlZone(element: HTMLElement): VoicePageZone {
  if (element.closest('.pilot-session-bar')) return 'session'
  if (element.closest('.sidebar nav')) return 'navigation'
  return 'page'
}

function isDisabled(element: HTMLElement) {
  if (element.getAttribute('aria-disabled') === 'true') return true
  return 'disabled' in element && Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled)
}

function runtimeControls(root: ParentNode): RuntimeVoicePageControl[] {
  const unnamedCounters = new Map<string, number>()
  return [...root.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary')].flatMap((element) => {
    const kind = controlKind(element)
    if (!kind || !visibleForVoice(element)) return []
    let label = directLabelText(element) || structuralLabelText(element)
    const generatedLabel = !label
    const preliminaryContext = controlContext(element, label)
    if (!label) {
      const contextKey = preliminaryContext || '当前页面'
      const ordinal = (unnamedCounters.get(contextKey) ?? 0) + 1
      unnamedCounters.set(contextKey, ordinal)
      label = `${contextKey}操作${ordinal}`
    }
    const context = controlContext(element, label)
    const displayName = context && !normalizeVoiceText(label).includes(normalizeVoiceText(context))
      ? `${context} · ${label}`
      : label
    const options = element instanceof HTMLSelectElement
      ? [...element.options].map((option) => ({ label: compactText(option.textContent), value: option.value, disabled: option.disabled }))
      : undefined
    const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
      ? element.value
      : undefined
    const dangerClass = /danger|destructive|remove|delete/.test(element.className)
    const zone = controlZone(element)
    const isSafeNavigationControl = zone === 'navigation' || element.tagName === 'SUMMARY' || element.getAttribute('role') === 'tab'
    return [{
      id: controlId(element),
      kind,
      label,
      context,
      displayName,
      zone,
      disabled: isDisabled(element),
      generatedLabel,
      sensitive: (element instanceof HTMLInputElement && element.type === 'password') || sensitiveFieldPattern.test(label),
      risk: classifyVoicePageRisk(label, { zone, danger: dangerClass, safeDisclosure: isSafeNavigationControl }),
      value,
      options,
      element,
    } satisfies RuntimeVoicePageControl]
  })
}

export function collectVoicePageControls(root: ParentNode): VoicePageControl[] {
  return runtimeControls(root).map(({ element: _element, ...control }) => control)
}

function voiceBigrams(value: string) {
  if (value.length <= 1) return new Set([value])
  return new Set([...value].slice(0, -1).map((character, index) => `${character}${value[index + 1]}`))
}

function matchScore(query: string, candidate: string) {
  const normalizedQuery = normalizeVoiceText(query)
  const normalizedCandidate = normalizeVoiceText(candidate)
  if (!normalizedQuery || !normalizedCandidate) return 0
  if (normalizedQuery === normalizedCandidate) return 100
  if (normalizedCandidate.startsWith(normalizedQuery) || normalizedQuery.startsWith(normalizedCandidate)) return 92
  if (normalizedCandidate.includes(normalizedQuery) || normalizedQuery.includes(normalizedCandidate)) return 86
  const queryParts = voiceBigrams(normalizedQuery)
  const candidateParts = voiceBigrams(normalizedCandidate)
  const overlap = [...queryParts].filter((part) => candidateParts.has(part)).length
  return Math.round((overlap / Math.max(queryParts.size, candidateParts.size, 1)) * 80)
}

function selectControl(query: string, controls: VoicePageControl[], allowedKinds: VoicePageControlKind[]) {
  const scored = controls
    .filter((control) => allowedKinds.includes(control.kind))
    .map((control) => ({ control, score: Math.max(matchScore(query, control.label), matchScore(query, control.displayName)) }))
    .filter((candidate) => candidate.score >= 58)
    .sort((left, right) => right.score - left.score || left.control.displayName.localeCompare(right.control.displayName, 'zh-CN'))
  if (scored.length === 0) return { kind: 'none' as const }
  const best = scored[0]!
  const close = scored.filter((candidate) => best.score - candidate.score <= 5)
  if (close.length > 1) {
    const exactNavigation = close.filter((candidate) => (
      candidate.control.zone === 'navigation'
      && normalizeVoiceText(candidate.control.label) === normalizeVoiceText(query)
    ))
    if (exactNavigation.length === 1) return { kind: 'selected' as const, control: exactNavigation[0]!.control }
    return { kind: 'ambiguous' as const, candidates: close.slice(0, 4).map((candidate) => candidate.control.displayName) }
  }
  return { kind: 'selected' as const, control: best.control }
}

function stripActivationWords(command: string) {
  return command
    .trim()
    .replace(/^(请|麻烦|帮我|我要|我想|给我)+/g, '')
    .replace(/^(点击|点一下|按下|执行|打开|进入|调用|选择|切换到|切换)/, '')
    .replace(/(这个|一下|按钮)$/g, '')
    .trim()
}

function blockedOrAmbiguous(
  selected: ReturnType<typeof selectControl>,
  unavailableMessage: string,
): { plan: VoicePagePlan } | { control: VoicePageControl } {
  if (selected.kind === 'none') return { plan: { kind: 'unknown', message: unavailableMessage } }
  if (selected.kind === 'ambiguous') {
    return { plan: { kind: 'ambiguous', message: '找到多个相似控件，请说得更具体一些。', candidates: selected.candidates } }
  }
  if (selected.control.disabled) {
    return { plan: { kind: 'blocked', message: `“${selected.control.displayName}”当前不可用，请先完成页面要求的前置信息。` } }
  }
  return { control: selected.control }
}

function readyPlan(
  control: VoicePageControl,
  action: VoicePageAction,
  summary: string,
  extras: Partial<Extract<VoicePagePlan, { kind: 'ready' }>> = {},
): VoicePagePlan {
  return {
    kind: 'ready',
    controlId: control.id,
    controlLabel: control.label,
    context: control.context,
    action,
    risk: control.risk,
    summary,
    ...extras,
  }
}

export function planVoicePageCommand(command: string, controls: VoicePageControl[]): VoicePagePlan {
  const cleanCommand = command.trim()
  if (!cleanCommand) return { kind: 'unknown', message: '请说出或输入要执行的命令。' }

  const valueMatch = cleanCommand.match(/^(?:请|帮我|在|把)?(.{1,40}?)(?:输入|填写|填入|改成|设置为)(.+)$/)
  if (valueMatch) {
    const fieldName = valueMatch[1]!.trim()
    const value = valueMatch[2]!.trim()
    const selected = blockedOrAmbiguous(selectControl(fieldName, controls, ['input', 'textarea']), `当前页面没有找到“${fieldName}”输入框。`)
    if ('plan' in selected) return selected.plan
    if (selected.control.sensitive) return { kind: 'blocked', message: `“${selected.control.displayName}”属于敏感字段，请在原页面手工输入。` }
    return readyPlan(selected.control, 'set_value', `在“${selected.control.displayName}”填写“${value}”。`, { value })
  }

  const optionMatch = cleanCommand.match(/^(?:请|帮我|在|把)?(.{1,40}?)(?:选择|选成|选为|切换为)(.+)$/)
  if (optionMatch) {
    const fieldName = optionMatch[1]!.trim()
    const requestedOption = optionMatch[2]!.trim()
    const selected = blockedOrAmbiguous(selectControl(fieldName, controls, ['select']), `当前页面没有找到“${fieldName}”选择框。`)
    if ('plan' in selected) return selected.plan
    const availableOptions = (selected.control.options ?? []).filter((option) => !option.disabled)
    const scoredOptions = availableOptions
      .map((option) => ({ option, score: matchScore(requestedOption, option.label) }))
      .filter((candidate) => candidate.score >= 58)
      .sort((left, right) => right.score - left.score)
    if (scoredOptions.length === 0) return { kind: 'blocked', message: `“${selected.control.displayName}”没有“${requestedOption}”这个可选项。` }
    if (scoredOptions.length > 1 && scoredOptions[0]!.score - scoredOptions[1]!.score <= 5) {
      return { kind: 'ambiguous', message: '找到多个相似选项，请说完整选项名称。', candidates: scoredOptions.slice(0, 4).map((item) => item.option.label) }
    }
    const option = scoredOptions[0]!.option
    return readyPlan(selected.control, 'select_option', `把“${selected.control.displayName}”选择为“${option.label}”。`, { value: option.value, optionLabel: option.label })
  }

  const toggleMatch = cleanCommand.match(/^(?:请|帮我)?(打开|开启|启用|关闭|停用|取消)(.+)$/)
  if (toggleMatch) {
    const checked = ['打开', '开启', '启用'].includes(toggleMatch[1]!)
    const fieldName = toggleMatch[2]!.trim()
    const selected = blockedOrAmbiguous(selectControl(fieldName, controls, ['checkbox', 'radio']), `当前页面没有找到“${fieldName}”开关。`)
    if ('control' in selected) {
      return readyPlan(selected.control, 'set_checked', `${checked ? '打开' : '关闭'}“${selected.control.displayName}”。`, { checked })
    }
    if (selected.plan.kind !== 'unknown') return selected.plan
  }

  const target = stripActivationWords(cleanCommand)
  const selected = blockedOrAmbiguous(
    selectControl(target, controls, ['button', 'link', 'checkbox', 'radio']),
    `当前页面没有找到“${target || cleanCommand}”操作。`,
  )
  if ('plan' in selected) return selected.plan
  const action: VoicePageAction = selected.control.kind === 'checkbox' || selected.control.kind === 'radio' ? 'set_checked' : 'activate'
  return readyPlan(selected.control, action, `执行“${selected.control.displayName}”。`, action === 'set_checked' ? { checked: true } : {})
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) return false
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

export function executeVoicePagePlan(plan: Extract<VoicePagePlan, { kind: 'ready' }>, root: ParentNode): VoicePageExecutionResult {
  const runtime = runtimeControls(root).find((control) => control.id === plan.controlId)
  if (!runtime) return { ok: false, message: '页面状态已经变化，请重新说一次命令。' }
  if (runtime.disabled) return { ok: false, message: `“${runtime.displayName}”当前不可用，命令没有执行。` }
  if (runtime.sensitive && plan.action === 'set_value') return { ok: false, message: '敏感字段不允许通过语音填写。' }

  runtime.element.scrollIntoView({ block: 'center', inline: 'nearest' })
  runtime.element.focus({ preventScroll: true })

  if (plan.action === 'set_value') {
    if (!(runtime.element instanceof HTMLInputElement || runtime.element instanceof HTMLTextAreaElement) || plan.value === undefined) {
      return { ok: false, message: '输入目标已经变化，命令没有执行。' }
    }
    if (!setNativeValue(runtime.element, plan.value)) return { ok: false, message: '该输入框无法通过语音填写。' }
    return { ok: true, message: `已填写“${runtime.displayName}”：${plan.value}` }
  }

  if (plan.action === 'select_option') {
    if (!(runtime.element instanceof HTMLSelectElement) || plan.value === undefined) {
      return { ok: false, message: '选择目标已经变化，命令没有执行。' }
    }
    const option = [...runtime.element.options].find((item) => item.value === plan.value && !item.disabled)
    if (!option) return { ok: false, message: '该选项已经不可用，请重新选择。' }
    runtime.element.value = option.value
    runtime.element.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, message: `已将“${runtime.displayName}”选择为“${compactText(option.textContent)}”。` }
  }

  if (plan.action === 'set_checked') {
    if (!(runtime.element instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(runtime.element.type)) {
      return { ok: false, message: '开关目标已经变化，命令没有执行。' }
    }
    const nextChecked = plan.checked ?? true
    if (runtime.element.checked !== nextChecked) runtime.element.click()
    return { ok: true, message: `已${nextChecked ? '打开' : '关闭'}“${runtime.displayName}”。` }
  }

  runtime.element.click()
  return { ok: true, message: `已执行“${runtime.displayName}”。` }
}

export function readVoicePageState(root: ParentNode): VoicePageStateSnapshot {
  const headingElement = root.querySelector<HTMLElement>('.topbar h1, main h1, [role="dialog"] h2, [role="dialog"] h3')
  const feedback = [...root.querySelectorAll<HTMLElement>(feedbackSelector)]
    .filter((element) => visibleForVoice(element))
    .map((element) => compactText(element.innerText || element.textContent, 160))
    .filter(Boolean)
  return { heading: compactText(headingElement?.innerText || headingElement?.textContent), feedback: [...new Set(feedback)] }
}
