import { useId, type InputHTMLAttributes } from 'react'
import './number-input-with-unit.css'

interface NumberInputWithUnitProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  unit: string
}

export function NumberInputWithUnit({ unit, inputMode, 'aria-describedby': describedBy, ...inputProps }: NumberInputWithUnitProps) {
  const unitDescriptionId = useId()
  const normalizedUnit = unit.trim() || '单位待选择'

  return <span className="number-input-with-unit">
    <input
      {...inputProps}
      type={inputMode === 'numeric' ? 'number' : 'text'}
      inputMode={inputMode}
      aria-describedby={[describedBy, unitDescriptionId].filter(Boolean).join(' ')}
    />
    <span className="number-input-with-unit__suffix" aria-hidden="true">{normalizedUnit}</span>
    <span className="number-input-with-unit__accessible-unit" id={unitDescriptionId}>单位：{normalizedUnit}</span>
  </span>
}
