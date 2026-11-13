import {escapeHTML as e} from '../../public/menu-model.js';
export const datePath=(lang,date)=>`/${lang}/performances/${date}/`;
export const fillDate=(text,date)=>text.replaceAll('{date}',date);
export function validDate(date){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;
 const n=Date.parse(date+'T12:00:00Z');
 return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===date;
}
export function dateSignals(html,snapshot){
 const messages=JSON.parse(html.match(/id="performance-messages" type="application\/json">(.*?)<\/script>/s)[1]);
 if(!messages.dateHeading)return html;
 const lang=html.match(/data-language="([a-z]+)"/)[1],date=snapshot.localDate;
 const title=e(fillDate(messages.dateHeading,date));
 html=html.replace(/(<div class="live-heading">[\s\S]*?)<h2[^>]*>.*?<\/h2>/,(_all,prefix)=>prefix+`<h2 id="schedule-title">${title}</h2>`);
 html=html.replace(/<a id="schedule-permalink"[\s\S]*?<\/a>/g,'');
 return html.replace('<div class="schedule-actions">',`<a id="schedule-permalink" class="text-link schedule-permalink" href="${datePath(lang,date)}">${e(fillDate(messages.dateLink,date))} ↗</a><div class="schedule-actions">`);
}
export function datedPage(html,lang,snapshot,origin){
 const date=snapshot.localDate,m=JSON.parse(html.match(/id="performance-messages" type="application\/json">(.*?)<\/script>/s)[1]);
 const title=fillDate(m.dateHeading,date)+' | M-BOX Shanghai',note=fillDate(m.fixedDateNote,date),path=datePath(lang,date);
 let top=html.slice(0,html.indexOf('<main id="main">'));
 top=top.replace(/<title>.*?<\/title>/s,()=>`<title>${e(title)}</title>`)
 .replace(/<meta name="description" content="[^"]*">/,()=>`<meta name="description" content="${e(note)}">`)
 .replace(/<link rel="canonical" href="[^"]*">/,()=>`<link rel="canonical" href="${origin}${path}">`)
 .replace(/<link rel="alternate" hreflang="([^"]+)" href="[^"]*">/g,(_all,l)=>`<link rel="alternate" hreflang="${l}" href="${origin}${datePath(l==='x-default'?'zh':l,date)}">`)
 .replace(/(<option value=")\/(zh|en|ru|ja|ko|fr|de)\/("[^>]*>)/g,(_a,start,l,end)=>start+datePath(l,date)+end)
 .replace(/<script type="application\/ld\+json">(.*?)<\/script>/s,(_all,value)=>{
  const schemas=JSON.parse(value);for(const item of schemas)if(item['@type']==='WebPage')Object.assign(item,{'@id':origin+path+'#page',url:origin+path,name:title,description:note});
  return '<script type="application/ld+json">'+JSON.stringify(schemas).replaceAll('<','\\u003c')+'</script>';
 });
 let section=html.match(/<section class="section live"[\s\S]*?<\/section>/)[0];
 section=section.replace('class="section live"','class="section live dated-programme"')
 .replace(/<div class="live-heading">[\s\S]*?<\/div><p>.*?<\/p><\/div>/,()=>`<div class="live-heading"><h1>${e(fillDate(m.dateHeading,date))}</h1><p class="fixed-date-note">${e(note)}</p></div>`)
 .replace(/<div id="overnight-schedule"[\s\S]*?<p class="fineprint" id="overnight-note">.*?<\/p><\/div>/,'')
 .replace(/<a id="schedule-permalink"[\s\S]*?<\/a>/,'')
 .replace(/<button[^>]+id="schedule-refresh"[^>]*>.*?<\/button>/,()=>`<a class="button outline" href="/${lang}/#live">${e(m.latestLink)} ↗</a>`)
 .replace(/<script type="module" src="\/performance.js"><\/script>/,'');
 if(!snapshot.unavailable&&!snapshot.schedules.length)section=section.replace(/(<p id="schedule-status"[^>]*>).*?(<\/p>)/s,(_a,start,end)=>start+e(m.dateEmpty)+end);
 if(snapshot.unavailable)section=section.replace(/(<p id="schedule-status"[^>]*>).*?(<\/p>)/s,(_a,start,end)=>start+e(fillDate(m.dateUnavailable,date))+end);
 return top+'<main id="main">'+section+'</main>'+html.slice(html.lastIndexOf('</main>')+7);
}
