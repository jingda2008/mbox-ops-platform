import {shanghaiDate,previousDate,normalize,phase,iso} from './performance-model.js';
const q=id=>document.getElementById(id),root=q('live');
if(root){
 const m=JSON.parse(q('performance-messages').textContent),snapshot=JSON.parse(q('performance-snapshot').textContent),lang=document.documentElement.lang,locale=lang==='zh'?'zh-CN':lang;
 const dateText=date=>new Intl.DateTimeFormat(locale,{dateStyle:'long',timeZone:'Asia/Shanghai'}).format(new Date(date+'T12:00:00+08:00'));
 const timeText=value=>new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'Asia/Shanghai'}).format(new Date(iso(value)));
 let state=normalize(snapshot,snapshot.localDate),overnight=null,overnightFailed=false,sequence=0,dateRequested=null,busy=false;
 const label=s=>m[phase(s)];
 function rows(target,data){
  target.replaceChildren();for(const [i,s] of data.schedules.entries()){
   const row=document.createElement('article');row.className='performance';row.dataset.phase=phase(s);
   const n=document.createElement('span');n.className='set-number';n.textContent=m.set.replace('{n}',String(s.setNumber||i+1));
   const name=document.createElement('h3');name.textContent=s.performerStageName;
   const status=document.createElement('span');status.className='genre';status.textContent=label(s);
   const time=document.createElement('time');time.dateTime=iso(s.startsAt);time.textContent=timeText(s.startsAt)+' — '+timeText(s.endsAt)+(shanghaiDate(new Date(iso(s.endsAt)))!==data.localDate?' · '+m.nextDay:'');
   const link=document.createElement('a');link.className='seat-link';link.href='/'+document.body.dataset.language+'/reserve/';link.textContent='↗';link.setAttribute('aria-label',m.reserve+' — '+s.performerStageName);
   row.append(n,name,status,time,link);target.append(row);
  }
 }
 function render(){
  q('schedule-date').textContent=dateText(state.localDate);rows(q('schedule-list'),state);
  const active=overnight?.schedules.filter(s=>phase(s)!=='ended')||[];
  q('overnight-schedule').hidden=!active.length&&!overnightFailed;
  q('overnight-note').textContent=overnightFailed?m.overnightFailed:m.overnightNote;
  q('overnight-date').textContent=dateText(overnight?.localDate||previousDate(shanghaiDate()));
  rows(q('overnight-list'),{...overnight,schedules:active});
 }

 async function fetchDay(date){const r=await fetch('/api/public/reservation/performances?date='+date,{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('schedule request failed');return normalize(await r.json(),date);}
 async function refresh(){
  if(busy)return;busy=true;const ticket=++sequence,date=shanghaiDate();dateRequested=date;q('schedule-status').textContent=m.loading;q('schedule-refresh').disabled=true;
  try{const data=await fetchDay(date);if(ticket!==sequence)return;state=data;q('schedule-label').textContent=m.verified;q('schedule-status').textContent=data.schedules.length?m.fresh:m.empty;
   q('schedule-checked').textContent=m.checked+' · '+new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Shanghai'}).format(new Date())+' · Shanghai UTC+8';
  }catch{q('schedule-status').textContent=m.failed;}
  overnightFailed=false;
  if(Number(new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone:'Asia/Shanghai'}).format(new Date()))<6){try{overnight=await fetchDay(previousDate(date))}catch{overnight=null;overnightFailed=true}}else overnight=null;
  render();busy=false;q('schedule-refresh').disabled=false;
 }
 q('schedule-refresh').addEventListener('click',refresh);render();refresh();
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});
 setInterval(()=>{if(document.hidden)return;render();if(dateRequested!==shanghaiDate())refresh();},60000);
}
