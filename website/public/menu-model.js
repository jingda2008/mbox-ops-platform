export const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function publicImage(value){
 if(typeof value!=='string')return null;
 return /^\/api\/public\/media-assets\/MA[0-9A-F]{32}$/.test(value)||/^\/menu\/(?:[A-Za-z0-9][A-Za-z0-9_.-]*\/)*[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:jpe?g|png|webp)$/i.test(value)?'https://mbox.shmbox.com'+value:null;
}
export function normalizeMenu(payload){
 const d=payload?.data;
 if(payload?.meta?.complete!==true||d?.schemaVersion!==1||d.currency!=='CNY'||!Array.isArray(d.products)||d.products.length>2000||payload.meta.count!==d.products.length||!Number.isFinite(Date.parse(d.checkedAt))||!/^\w{64}$/.test(d.version))throw Error('Invalid menu snapshot');
 const ids=new Set(),codes=new Set();
 const products=d.products.map(p=>{
  if(typeof p.id!=='string'||!p.id||ids.has(p.id)||typeof p.code!=='string'||!p.code||codes.has(p.code)||typeof p.name!=='string'||!p.name.trim()||p.currency!=='CNY'||!Number.isSafeInteger(p.amountMinor)||p.amountMinor<0||!['available','scheduled','unavailable'].includes(p.availability))throw Error('Invalid menu item');
  ids.add(p.id);codes.add(p.code);
  return {id:p.id,code:p.code,name:p.name,categoryName:String(p.categoryName||'其他'),categoryParentName:p.categoryParentName||null,specification:p.specification||null,description:p.description||null,imageUrl:publicImage(p.imageUrl),amountMinor:p.amountMinor,currency:p.currency,availability:p.availability};
 });
 return {products,version:d.version,checkedAt:d.checkedAt};
}
export const price=p=>'¥'+(p.amountMinor/100).toFixed(2).replace(/\.00$/,'');
// A translation is usable only after its product ID and exact source name are reviewed.
export function displayName(p,lang,translations={}){const t=translations[p.id];return t?.sourceName===p.name&&typeof t[lang]==='string'?t[lang]:p.name;}
export function group(p){const n=p.categoryParentName||p.categoryName;if(n.includes('鸡尾酒'))return 0;if(['无酒精','软饮'].includes(n))return 1;if(['小食','冷食','鲜果与冷食'].includes(n))return 2;if(n==='啤酒')return 3;if(['葡萄酒','香槟&起泡酒'].includes(n))return 4;if(n.includes('威士忌')||n.includes('日威'))return 5;if(['干邑','烈酒'].includes(n))return 6;return 7;}
export function renderMenu(data,lang,c,view='catalog',translations={}){
 const e=escapeHTML;
 const products=data?.products||[];
 const status=!data?c.failure:products.length?c.fresh:c.empty;
 const timestamp=data?`<span>${e(c.checked)} · ${e(new Intl.DateTimeFormat(lang,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Shanghai'}).format(new Date(data.checkedAt)))} · Shanghai UTC+8</span>`:'';
 const notice=`<p class="fineprint menu-sync-status" role="status">${e(status)} ${timestamp}</p>`;
 const card=p=>{const name=displayName(p,lang,translations),g=group(p);return `<article class="catalog-item" data-group="${g}" data-search="${e(p.name+' '+name+' '+p.code)}" data-product-id="${e(p.id)}">${p.imageUrl?`<img src="${e(p.imageUrl)}" alt="${e(p.name)}" width="90" height="90" loading="lazy">`:'<div class="menu-image-placeholder" aria-hidden="true">M—BOX</div>'}<div><span class="eyebrow">${e(c.categories[g])}</span><h2 lang="${name===p.name?'zh-CN':lang}">${e(name)}</h2>${name!==p.name?`<p class="original-name" lang="zh-CN">${e(p.name)}</p>`:''}${p.specification?`<p>${e(p.specification)}</p>`:''}<small>${e(p.code)}</small>${p.availability!=='available'?`<p class="menu-availability">${e(c[p.availability])}</p>`:''}</div><span class="catalog-price">${price(p)}</span></article>`};
 if(view==='home'){
  const featured=['CK025','CK002','CXF003','CXF010'].map(code=>products.find(p=>p.code===code)).filter(Boolean);
  const budget=['CXW004','dasb11','pijiu6'].map(code=>products.find(p=>p.code===code)).filter(Boolean);
  return `<div id="budget">${notice}</div>`+`<div class="catalog-grid home-menu-grid">${featured.map(card).join('')}</div>`+(budget.length?`<div class="budget-links">${budget.map(p=>`<a href="/${lang}/menu/?q=${encodeURIComponent(p.code)}">${e(displayName(p,lang,translations))} ${price(p)}${p.availability!=='available'?' · '+e(c[p.availability]):''}</a>`).join('')}</div>`:'');
 }
 return notice+`<div class="catalog-tools"><label><span class="sr-only">${e(c.search)}</span><input id="menu-search" type="search" placeholder="${e(c.search)}"></label><span id="result-count" data-suffix="${e(c.count)}" aria-live="polite">${products.length} ${e(c.count)}</span></div><div class="filters" role="group" aria-label="${e(c.filterLabel)}"><button class="filter active" data-filter="all" aria-pressed="true">${e(c.all)}</button>${c.categories.map((n,i)=>`<button class="filter" data-filter="${i}" aria-pressed="false">${e(n)}</button>`).join('')}</div><div class="catalog-grid">${products.map(card).join('')}</div><p id="no-results" hidden>${e(c.noResults)}</p>`;
}
