import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NumberInputWithUnit } from './NumberInputWithUnit'

describe('NumberInputWithUnit', () => {
  it('renders a visible unit suffix and an accessible unit description', () => {
    const markup = renderToStaticMarkup(createElement(NumberInputWithUnit, {
      unit: '毫升',
      defaultValue: '45',
      inputMode: 'decimal',
      'aria-label': '每份用量',
    }))

    expect(markup).toContain('number-input-with-unit__suffix')
    expect(markup).toContain('>毫升</span>')
    expect(markup).toContain('单位：毫升')
    expect(markup).toContain('aria-describedby=')
  })

  it('keeps native integer limits for fields using a numeric keypad', () => {
    const markup = renderToStaticMarkup(createElement(NumberInputWithUnit, {
      unit: '人',
      inputMode: 'numeric',
      min: 1,
      max: 1000,
      defaultValue: '20',
      'aria-label': '人数上限',
    }))

    expect(markup).toContain('type="number"')
    expect(markup).toContain('min="1"')
    expect(markup).toContain('max="1000"')
  })
})
