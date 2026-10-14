export const shanghaiDate=(now=new Date())=>new Date(now.getTime()+8*3600000).toISOString().slice(0,10);
export const previousDate=date=>new Date(Date.parse(date+'T00:00:00+08:00')-86400000+8*3600000).toISOString().slice(0,10);
export const iso=value=>String(value).replace(' ','T').replace(/([+-]\d\d)$/,'$1:00');
export const phase=(s,now=Date.now())=>now>=Date.parse(iso(s.endsAt))?'ended':now>=Date.parse(iso(s.startsAt))?'window':'upcoming';
export function normalize(payload,date){
 const d=payload?.data||payload;
 if(d?.timezone!=='Asia/Shanghai'||d.localDate!==date||!Array.isArray(d.schedules))throw Error('invalid schedule');
 return {...d,schedules:d.schedules.filter(s=>s.status!=='cancelled').map(s=>{
  const start=Date.parse(iso(s.startsAt)),end=Date.parse(iso(s.endsAt));
  if(typeof s.performerStageName!=='string'||!s.performerStageName.trim()||!Number.isFinite(start)||!Number.isFinite(end)||end<=start||shanghaiDate(new Date(start))!==date)throw Error('invalid set');
  return {...s,startsAt:iso(s.startsAt),endsAt:iso(s.endsAt)};
 }).sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt)).map((s,i)=>({...s,setNumber:i+1}))};
}
