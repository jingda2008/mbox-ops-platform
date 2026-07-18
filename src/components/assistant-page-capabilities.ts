import type { AssistantCapability } from '../shared/assistant-contracts'
import type { VoicePageControl } from './voice-page-controls'

function commandForControl(control: VoicePageControl) {
  if (control.kind === 'input' || control.kind === 'textarea') return `在${control.displayName}输入内容`
  if (control.kind === 'select') return `${control.displayName}选择选项`
  if (control.kind === 'checkbox' || control.kind === 'radio') return `打开${control.displayName}`
  return `点击${control.displayName}`
}

export function assistantPageCapabilities(controls: VoicePageControl[]): AssistantCapability[] {
  return controls.filter((control) => !control.sensitive).map((control) => ({
    id: `page:${control.id}`,
    label: control.displayName,
    command: commandForControl(control),
    description: [control.context, control.kind].filter(Boolean).join(' · '),
    risk: control.risk,
    disabled: control.disabled,
  }))
}
