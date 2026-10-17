const messages=JSON.parse(document.querySelector('#ui-messages')?.textContent||'{}');
const toast=document.querySelector('#toast');let toastTimer;
function notify(text){toast.textContent=text;toast.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('visible'),4000)}
async function copyText(text){try{await navigator.clipboard.writeText(text);notify(messages.copied)}catch{notify(messages.copyFailed)}}
document.querySelector('#language')?.addEventListener('change',e=>{try{localStorage.setItem('mbox.language',e.target.value.split('/')[1])}catch{}const url=new URL(e.target.value,location.origin);if(location.hash)url.hash=location.hash;if(location.search&&e.target.value.includes('/menu/'))url.search=location.search;location.href=url.href});
document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',()=>copyText(b.dataset.copy)));
let activeFilter='all';
function filterMenu(){const menuSearch=document.querySelector('#menu-search');if(!menuSearch)return;const q=menuSearch.value.trim().toLowerCase();let visible=0;for(const item of document.querySelectorAll('.catalog-item')){const show=(activeFilter==='all'||item.dataset.group===activeFilter)&&item.dataset.search.toLowerCase().includes(q);item.hidden=!show;if(show)visible++}const count=document.querySelector('#result-count');const suffix=count.dataset.suffix||count.textContent.replace(/^\d+\s*/,'');count.textContent=`${visible} ${suffix}`;document.querySelector('#no-results').hidden=visible>0;document.querySelectorAll('.filter').forEach(x=>{x.classList.toggle('active',x.dataset.filter===activeFilter);x.setAttribute('aria-pressed',String(x.dataset.filter===activeFilter))})}
document.addEventListener('input',e=>{if(e.target.id==='menu-search')filterMenu()});
document.addEventListener('click',e=>{const b=e.target.closest('.filter');if(b){activeFilter=b.dataset.filter;filterMenu()}});
function initializeMenu(query=new URLSearchParams(location.search).get('q')||'',filter='all'){const search=document.querySelector('#menu-search');if(search){search.value=query;activeFilter=filter;filterMenu()}}
window.addEventListener('menu-updated',e=>initializeMenu(e.detail.query,e.detail.filter));initializeMenu();

// Keep the homepage email prominent on already-running SSR releases.
// New builds include the same block in HTML; do not duplicate it.
(()=>{
 const hero=document.querySelector('.hero-copy');
 if(!hero||hero.querySelector('.hero-contact'))return;
 const actions=hero.querySelector('.hero-actions');
 const source=document.querySelector('.contact-email-line');
 if(!actions||!source)return;
 const contact=document.createElement('div');contact.className='hero-contact';
 contact.append(source.cloneNode(true));actions.before(contact);
})();
