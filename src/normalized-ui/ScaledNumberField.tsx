import {useEffect,useState} from 'react'
import {minorToYuanInput,yuanInputToMinor} from './membership-business-inputs'

/** Both money cents and percentage basis points use an exact scale of 100. */
export function ScaledNumberField({label,value,onChange,unit,required=false,maxValue=Number.MAX_SAFE_INTEGER}:{label:string;value:string;onChange(value:string):void;unit:'元'|'%';required?:boolean;maxValue?:number}){
  const [text,setText]=useState(()=>value===''?'':minorToYuanInput(Number(value)))
  useEffect(()=>{setText(previous=>value===''?'':yuanInputToMinor(previous)===Number(value)?previous:minorToYuanInput(Number(value)))},[value])
  return <label>{label}（{unit}）<input inputMode="decimal" required={required} value={text} onChange={event=>{
    const raw=event.currentTarget.value;setText(raw)
    const scaled=yuanInputToMinor(raw),valid=scaled!==null&&scaled<=maxValue
    event.currentTarget.setCustomValidity(raw===''&&!required||valid?'':`请输入0至${minorToYuanInput(maxValue)}${unit}，最多两位小数`)
    if(raw==='')onChange('');else if(valid)onChange(String(scaled))
  }}/></label>
}
