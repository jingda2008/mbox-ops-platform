import {normalizeMenu,renderMenu} from './menu-model.js';
import {MENU_COPY,TRANSLATIONS} from './menu-copy.js';
const root=document.querySelector('#dynamic-menu');
if(root){
 const lang=document.body.dataset.language,copy=MENU_COPY[lang];let pending=false;
 async function refresh(){if(pending)return;pending=true;const query=document.querySelector('#menu-search')?.value||'',filter=document.querySelector('.filter.active')?.dataset.filter||'all';let data=null;try{const r=await fetch('/api/website/menu',{cache:'no-store',signal:AbortSignal.timeout(9000)});if(!r.ok)throw Error();data=normalizeMenu(await r.json());}catch{}root.innerHTML=renderMenu(data,lang,copy,root.dataset.view,TRANSLATIONS);window.dispatchEvent(new CustomEvent('menu-updated',{detail:{query,filter}}));pending=false;}
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});setInterval(()=>{if(!document.hidden)refresh()},300000);
 // Server supplied the initial snapshot. An unavailable server response gets one immediate retry.
 if(root.dataset.available!=='true')refresh();
}
