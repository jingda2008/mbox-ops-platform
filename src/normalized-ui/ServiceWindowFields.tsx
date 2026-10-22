import { DEFAULT_PRODUCT_SERVICE_WINDOW, type ProductServiceWindow } from '../shared/product-service-window.js'

const clock=(minute:number)=>`${String(Math.floor((minute%1440)/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`
const minutes=(value:string)=>{const [h,m]=value.split(':').map(Number);return h!*60+m!}

/** Shared small editor; the server validates the final configuration. */
export function ServiceWindowFields({value,onChange,disabled=false}: {
  value:ProductServiceWindow|null|undefined
  onChange:(window:ProductServiceWindow|null)=>void
  disabled?:boolean
}) {
  const set=(patch:Partial<ProductServiceWindow>)=>{if(value)onChange({...value,...patch})}
  const same=!!value&&value.visibleStartMinute===value.saleStartMinute&&value.visibleEndMinute===value.saleEndMinute
  const sale=(start:number,end:number)=>set({saleStartMinute:start,saleEndMinute:end,...(same?{visibleStartMinute:start,visibleEndMinute:end}:{})})
  return <fieldset disabled={disabled}>
    <legend>定时可见与出售</legend>
    <label><input type="checkbox" checked={!!value} onChange={event=>onChange(event.target.checked?{...DEFAULT_PRODUCT_SERVICE_WINDOW,weekdays:[1,2,3,4,5,6,7]}:null)}/>设置日期和时段</label>
    {value&&<>
      <label>开始日期（可空）<input type="date" value={value.dateFrom??''} onChange={event=>set({dateFrom:event.target.value||null})}/></label>
      <label>结束日期（可空）<input type="date" value={value.dateThrough??''} onChange={event=>set({dateThrough:event.target.value||null})}/></label>
      <div>{['一','二','三','四','五','六','日'].map((day,index)=><label key={day}><input type="checkbox" checked={value.weekdays.includes(index+1)} onChange={event=>set({weekdays:event.target.checked?[...value.weekdays,index+1].sort((a,b)=>a-b):value.weekdays.filter(d=>d!==index+1)})}/>周{day}</label>)}</div>
      <label><input type="checkbox" checked={value.saleStartMinute===0&&value.saleEndMinute===1440} onChange={event=>sale(event.target.checked?0:1080,event.target.checked?1440:1380)}/>全天</label>
      {!(value.saleStartMinute===0&&value.saleEndMinute===1440)&&<>
        <label>出售开始<input type="time" value={clock(value.saleStartMinute)} onChange={event=>sale(minutes(event.target.value),value.saleEndMinute)}/></label>
        <label>出售结束<input type="time" value={clock(value.saleEndMinute)} onChange={event=>sale(value.saleStartMinute,minutes(event.target.value)+(value.saleEndMinute>=1440?1440:0))}/></label>
        <label><input type="checkbox" checked={value.saleEndMinute>=1440} onChange={event=>sale(value.saleStartMinute,value.saleEndMinute%1440+(event.target.checked?1440:0))}/>次日结束</label>
      </>}
      {value.saleStartMinute>0&&<label><input type="checkbox" checked={!same} onChange={event=>event.target.checked?set({visibleStartMinute:Math.max(0,value.saleStartMinute-60),visibleEndMinute:value.saleEndMinute}):set({visibleStartMinute:value.saleStartMinute,visibleEndMinute:value.saleEndMinute})}/>提前展示</label>}
      {!same&&<>
        <label>展示开始<input type="time" value={clock(value.visibleStartMinute)} onChange={event=>set({visibleStartMinute:minutes(event.target.value)})}/></label>
        <label>展示结束<input type="time" value={clock(value.visibleEndMinute)} onChange={event=>set({visibleEndMinute:minutes(event.target.value)+(value.visibleEndMinute>=1440?1440:0)})}/></label>
        <label><input type="checkbox" checked={value.visibleEndMinute>=1440} onChange={event=>set({visibleEndMinute:value.visibleEndMinute%1440+(event.target.checked?1440:0)})}/>展示次日结束</label>
      </>}
      <small>开始时刻包含，结束时刻停止；跨午夜按开始日期和星期计算。专属时段还须在商品基础供应时间内。</small>
    </>}
  </fieldset>
}
