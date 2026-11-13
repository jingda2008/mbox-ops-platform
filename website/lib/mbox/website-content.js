import pages from '../../data/pages.json' with {type:'json'};
import {normalizeMenu,renderMenu,escapeHTML as e} from '../../public/menu-model.js';
import {MENU_COPY,TRANSLATIONS} from '../../public/menu-copy.js';
import {normalize,shanghaiDate} from '../../public/performance-model.js';
import {createReader} from './content-cache.js';
import {dateSignals,datedPage,validDate} from './dated-performance.js';
const ORIGIN='https://mbox.shmbox.com';
const json=value=>JSON.stringify(value).replace(/</g,'\\u003c');
export function renderPage(html,lang,data){
 const view=html.includes('class="catalog section"')?'catalog':'home';
 if(view==='catalog')html=html.replace(/<p class="catalog-intro">.*?<\/p>/s,()=>`<p class="catalog-intro">${e(MENU_COPY[lang].intro)}</p>`).replace(/<meta name="description" content="[^"]*">/,()=>`<meta name="description" content="${e(MENU_COPY[lang].intro)}">`).replace(/<script type="application\/ld\+json">(.*?)<\/script>/s,(_all,value)=>{const schemas=JSON.parse(value);for(const schema of schemas)if(schema['@type']==='CollectionPage')schema.description=MENU_COPY[lang].intro;return `<script type="application/ld+json">${json(schemas)}</script>`});
 return html.replace(/<!--menu:start-->[\s\S]*?<!--menu:end-->/,()=>`<div id="dynamic-menu" data-view="${view}" data-available="${!!data}">${renderMenu(data,lang,MENU_COPY[lang],view,TRANSLATIONS)}</div>`)
  .replace(/<!--menu-note:start-->[\s\S]*?<!--menu-note:end-->/,'')
  .replace('</body>','<script type="module" src="/menu-sync.js"></script></body>');
}
export function renderPerformance(html,snapshot){
 const messages=JSON.parse(html.match(/id="performance-messages" type="application\/json">(.*?)<\/script>/s)[1]);
 const rows=snapshot.schedules.map((s,i)=>`<article class="performance"><span class="set-number">${e(messages.set.replace('{n}',String(i+1)))}</span><h3>${e(s.performerStageName)}</h3><span class="genre">${e(messages.verified)}</span><time datetime="${e(s.startsAt)}">${e(s.startsAt.slice(11,16))} — ${e(s.endsAt.slice(11,16))}${s.startsAt.slice(0,10)!==s.endsAt.slice(0,10)?' · '+e(messages.nextDay):''}</time></article>`).join('');
 return dateSignals(html.replace(/(<strong id="schedule-date">).*?(<\/strong>)/s,()=>`<strong id="schedule-date">${snapshot.localDate}</strong>`)
 .replace(/<div class="schedule" id="schedule-list">.*?<\/div>/s,()=>`<div class="schedule" id="schedule-list">${rows}</div>`)
 .replace(/(<[^>]+ id="schedule-label"[^>]*>).*?(<\/[^>]+>)/s,(_a,start,end)=>start+e(snapshot.unavailable?messages.staleLabel:messages.verified)+end)
 .replace(/(<[^>]+ id="schedule-status"[^>]*>).*?(<\/[^>]+>)/s,(_a,start,end)=>start+snapshot.localDate+' · '+e(snapshot.unavailable?messages.staleNote:snapshot.schedules.length?messages.verified:messages.empty)+end)
 .replace(/<p class="fineprint" id="schedule-checked">.*?<\/p>/s,()=>`<p class="fineprint" id="schedule-checked">${snapshot.checkedAt?e(messages.checked)+' · '+e(snapshot.checkedAt)+' (UTC)':''}</p>`)
 .replace(/(<script id="performance-snapshot" type="application\/json">).*?(<\/script>)/s,()=>`<script id="performance-snapshot" type="application/json">${json(snapshot)}</script>`),snapshot);
}
export function createWebsiteContent(send=fetch){
 const menu=createReader(ORIGIN+'/api/public/website/menu',normalizeMenu,300000,send);
 let performanceDate='',performance;
 const datedReaders=new Map();
 return async(request,enabled=false)=>{
  const u=new URL(request.url),html=pages[u.pathname];
  const dated=/^\/(zh|en|ru|ja|ko|fr|de)\/performances\/(\d{4}-\d{2}-\d{2})\/$/.exec(u.pathname);
  if(dated&&['GET','HEAD'].includes(request.method)){
   const [,lang,date]=dated;
   if(!validDate(date))return new Response('Not found',{status:404,headers:{'x-robots-tag':'noindex'}});
   if(!datedReaders.has(date)){
    if(datedReaders.size>=32)datedReaders.delete(datedReaders.keys().next().value);
    datedReaders.set(date,createReader(ORIGIN+'/api/public/reservation/performances?date='+date,p=>({...normalize(p,date),checkedAt:new Date().toISOString()}),60000,send));
   }
   let snapshot;try{snapshot=await datedReaders.get(date)()}catch{snapshot={timezone:'Asia/Shanghai',localDate:date,schedules:[],unavailable:true,checkedAt:null}}
   const output=datedPage(renderPerformance(pages['/'+lang+'/'],snapshot),lang,snapshot,u.origin);
   return new Response(request.method==='HEAD'?null:output,{status:snapshot.unavailable?503:200,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...(snapshot.unavailable?{'retry-after':'60','x-robots-tag':'noindex'}:{})}});
  }
  if(u.pathname==='/api/website/menu'){
   if(request.method!=='GET'||u.search)return new Response(null,{status:404});
   if(!enabled)return Response.json({error:{code:'MENU_SYNC_PENDING'}},{status:503,headers:{'cache-control':'no-store'}});
   try{const d=await menu();return Response.json({data:{...d,products:d.products.map(p=>({...p,imageUrl:p.imageUrl?.replace(ORIGIN,'')||null})),schemaVersion:1,currency:'CNY'},meta:{complete:true,count:d.products.length}},{headers:{'cache-control':'no-store','x-robots-tag':'noindex'}})}catch{return Response.json({error:{code:'MENU_UNAVAILABLE'}},{status:503,headers:{'cache-control':'no-store'}})}
  }
  if(!html||!['GET','HEAD'].includes(request.method))return null;
  const lang=u.pathname.split('/')[1];let output=html;
  if(enabled){let data=null;try{data=await menu()}catch{}output=renderPage(output,lang,data)}
  if(!u.pathname.includes('/menu/')){
   const date=shanghaiDate();if(performanceDate!==date){performanceDate=date;performance=createReader(ORIGIN+'/api/public/reservation/performances?date='+date,p=>({...normalize(p,date),checkedAt:new Date().toISOString()}),60000,send)}
   try{output=renderPerformance(output,await performance())}catch{output=renderPerformance(output,{timezone:'Asia/Shanghai',localDate:date,schedules:[],unavailable:true,checkedAt:null})}
  }
  return new Response(request.method==='HEAD'?null:output,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
 };
}
export const websiteContent=createWebsiteContent();
