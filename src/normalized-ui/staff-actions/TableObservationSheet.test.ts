import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./staff-actions-panel.css', import.meta.url), 'utf8')
const source = readFileSync(new URL('./TableObservationSheet.tsx', import.meta.url), 'utf8')

describe('TableObservationSheet mobile interaction contract', () => {
  it('keeps candidate selection reversible without a sub-44px radio target', () => {
    expect(source).toContain('aria-pressed={selectedCandidateId === candidate.id}')
    expect(source).toContain("current === candidate.id ? '' : candidate.id")
    expect(source).not.toContain('type="radio"')
    expect(css).toMatch(/\.staff-observation-candidates > button \{[^}]*min-height: 58px;/)
  })

  it('collapses classification controls for 320px and 390px screens and preserves 44px controls', () => {
    expect(css).toMatch(/@media \(max-width: 560px\)[\s\S]*\.staff-observation-classification \{ grid-template-columns: 1fr; \}/)
    expect(css).toMatch(/\.staff-observation-classification select, \.staff-observation-revision-form input \{[^}]*min-height: 44px;/)
    expect(css).toMatch(/\.staff-actions-panel button \{[^}]*min-height: 44px;/)
    expect(css).toContain('width: min(100%, 680px)')
  })

  it('keeps table observations text-only without requesting a microphone or transcription', () => {
    expect(source).toContain('一句话记录')
    expect(source).not.toContain('navigator.mediaDevices.getUserMedia')
    expect(source).not.toContain('MediaRecorder')
    expect(source).not.toContain('transcribeObservationAudio')
    expect(source).not.toContain('语音记录')
    expect(css).not.toContain('.staff-observation-voice')
  })
})
