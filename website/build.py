from pathlib import Path
import json, html, shutil, re
from content import C, LANGS
from experience_content import EXPERIENCE, FOOTERS
from refresh_content import SCHEDULE, TIMING_COPY, PUBLIC_COPY, OVERNIGHT_FAILURE, PHONE_COPY
from datetime import datetime
for lang,c in C.items():
 x=EXPERIENCE[lang]
 c['steps'][2]=[x['submit'],x['bookingIntro']]
 c['privacy']=x['privacy']
 c['preview'],c['footerNote']=PUBLIC_COPY[lang]
 c['phoneNote']=PHONE_COPY[lang]
 c['faq'][6][1]=x['feeFaq']

B=Path(__file__).parent; D=B/'public'; P=B/'data'
ORIGIN='https://mbox-shanghai-preview-20261013.jingda2008.chatgpt.site'
esc=html.escape
def json_script(value):
 return json.dumps(value,ensure_ascii=False).replace("<", "\\u003c")
A=D/'assets'; A.mkdir(exist_ok=True)
products=json.loads((P/'website-menu-candidates.json').read_text())['products']
asset_map=json.loads((P/'menu-assets.json').read_text())
for item in products:
 item['web_image']=asset_map[item['code']]
 assert (D/item['web_image'].lstrip('/')).is_file(),item['code']

def group(x):
 n=x['category_name']
 if '鸡尾酒' in n:return 0
 if n in ['无酒精','软饮']:return 1
 if n in ['小食','冷食','鲜果与冷食']:return 2
 if n=='啤酒':return 3
 if n in ['葡萄酒','香槟&起泡酒']:return 4
 if '威士忌' in n or '日威' in n:return 5
 if n in ['干邑','烈酒']:return 6
 return 7

def nl(s):return '<br>'.join(esc(s).split('\n'))
def head(lang,c,menu=False,reserve=False):
 path=f'/{lang}/'+('menu/' if menu else 'reserve/' if reserve else '')
 alternates=''.join(f'<link rel="alternate" hreflang="{x}" href="{ORIGIN}/{x}/{"menu/" if menu else "reserve/" if reserve else ""}">' for x,_ in LANGS)
 schema={'@id':ORIGIN+'/#venue','@context':'https://schema.org','@type':'BarOrPub','name':'M-BOX 陆家嘴店','alternateName':['MBOX','M-BOX','M-BOX Lujiazui','MBOX 陆家嘴'],'description':c['meta'],'address':{'@type':'PostalAddress','streetAddress':'浦东南路889号陆家嘴中心穹顶花园RG05','addressLocality':'上海市','addressRegion':'上海市','addressCountry':'CN'},'hasMenu':[ORIGIN+f'/{x}/menu/' for x,_ in LANGS],'url':ORIGIN+'/zh/','telephone':'+86-176-2139-2152'}
 page_schema={'@context':'https://schema.org','@type':'CollectionPage' if menu else 'WebPage','@id':ORIGIN+path+'#page','url':ORIGIN+path,'inLanguage':'zh-CN' if lang=='zh' else lang,'about':{'@id':ORIGIN+'/#venue'},'description':c['menuMeta'] if menu else c['meta']}
 title=(('M-BOX 陆家嘴' if lang=='zh' else 'M-BOX Lujiazui')+' | '+c['nav'][2]+' · CNY') if menu else c['title']
 if reserve: title=EXPERIENCE[lang]['flowTitle']+' | M-BOX Shanghai'
 return f'''<!doctype html><html lang="{'zh-CN' if lang=='zh' else lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(title)}</title><meta name="description" content="{esc(c['menuMeta'] if menu else c['meta'],quote=True)}"><meta name="robots" content="index,follow,max-image-preview:large"><meta name="theme-color" content="#172c21"><link rel="icon" href="/assets/favicon.svg"><link rel="canonical" href="{ORIGIN}{path}">{alternates}<link rel="alternate" hreflang="x-default" href="{ORIGIN}/zh/{'menu/' if menu else 'reserve/' if reserve else ''}"><link rel="stylesheet" href="/style.css"><script type="application/ld+json">{json.dumps([schema,page_schema],ensure_ascii=False)}</script><script src="/app.js" defer></script></head><body data-language="{lang}"><a class="skip" href="#main">{c['skip']}</a>'''
def header(lang,c,menu=False,reserve=False):
 home=f'/{lang}/'; links=['why','story','menu','events','visit']
 opts=''.join(f'<option value="/{x}/{"menu/" if menu else "reserve/" if reserve else ""}" {"selected" if x==lang else ""}>{name}</option>' for x,name in LANGS)
 nav=''.join(f'<a href="{home}#{key}">{txt}</a>' for key,txt in zip(links,c['nav']))
 return f'''<header class="header"><a class="wordmark" href="{home}" aria-label="M-BOX">M—BOX<span>SHANGHAI · LIVE MUSIC</span></a><nav aria-label="M-BOX">{nav}</nav><div class="header-tools"><label class="language"><span aria-hidden="true">◎</span><span class="sr-only">{c['langLabel']}</span><select id="language">{opts}</select></label><a class="button small seat-link" href="/{lang}/reserve/">{c['book']} <span aria-hidden="true">↗</span></a></div></header>'''
ICP_RECORD='<a class="icp" href="https://beian.miit.gov.cn/#/Integrated/recordQuery" target="_blank" rel="noopener">沪ICP备2023018086号-3</a>'
def contact_pair(c, arrow=False, phone_class=''):
 tel,email=esc(c['telLabel']),esc(c['emailLabel'])
 cls=f' class="{phone_class}"' if phone_class else ''
 mark=' ↗' if arrow else ''
 phone=f'<a{cls} href="tel:+8617621392152">+86 176 2139 2152{mark}</a>'
 mail='<a class="contact-email" href="mailto:shmbox@qq.com">shmbox@qq.com</a>'
 return f'<div class="contact-pair"><p class="contact-phone-line"><span class="phone-label">{tel}</span>{phone}</p><p class="contact-email-line"><span class="email-label">{email}</span>{mail}</p></div>'
def footer(lang,c):
 return f'''<footer><div class="footer-main"><a class="wordmark" href="/{lang}/">M—BOX<span>SHANGHAI · LIVE MUSIC</span></a><p>{c['footer']}</p><div class="footer-contact">{contact_pair(c, arrow=True)}</div></div><div class="footer-bottom"><span>© M-BOX · LUJIAZUI</span><span>{c['footerNote']}</span></div><p class="footer-icp">{ICP_RECORD}</p></footer><nav class="mobile-actions" aria-label="M-BOX"><a class="seat-link" href="/{lang}/reserve/">{c["book"]}</a><a href="/{lang}/menu/">{c["nav"][2]}</a><a href="tel:+8617621392152">{c["call"]}</a></nav><div class="toast" id="toast" role="status" aria-live="polite"></div><script id="ui-messages" type="application/json">{json.dumps({k:c[k] for k in ['copied','copyFailed','noResults']},ensure_ascii=False)}</script></body></html>'''

def budget(lang,c):
 choices=''.join(f'<a href="/{lang}/menu/?q={code}"><span>{esc(label)}</span><strong>¥{int(next(p for p in products if p["code"]==code)["amount_minor"])//100}</strong></a>' for code,label in zip(['CXW004','dasb11','pijiu6'],c['choicesNames']))
 return f'<div class="order-guide" id="budget"><div><h3>{c["choicesTitle"]}</h3><div class="price-options">{choices}</div><p class="fineprint">{c["choicesNote"]}</p></div><details class="budget-detail"><summary>{c["budgetTitle"]}</summary><p>{c["budgetOne"]}<strong>¥98 + ¥58 = ¥156</strong></p><p>{c["budgetTwo"]}<strong>¥98 × 2 + ¥58 = ¥254</strong></p><p class="fineprint">{c["budgetNote"]}</p></details></div>'

def decision_intro(lang,c):
 x=EXPERIENCE[lang]
 links=''.join(f'<a href="{"/"+lang+"/reserve/" if target=="booking" else "#"+target}">{label} <span aria-hidden="true">↗</span></a>' for target,label in zip(['live','first-visit','budget','booking'],c['quickLinks']))
 return f'''<section class="section identity" id="identity"><p class="eyebrow">M—BOX / LIVE ARCHIVE</p><h2>{nl(c['identityTitle'])}</h2><div class="listen-invitation"><div class="listen-copy"><p class="identity-answer">{c['identityText']}</p><p>{c['identityClose']}</p><nav class="decision-links">{links}</nav></div><figure class="listen-film"><video controls muted playsinline preload="metadata" poster="/assets/mbox-live-20261013-poster.jpg" width="1280" height="720" aria-label="{esc(x['videoTitle'],quote=True)}"><source src="/assets/mbox-live-20261013.mp4" type="video/mp4"></video><figcaption><strong>{x['videoTitle']}</strong><p>{x['videoNote']}</p></figcaption></figure></div></section>'''

def first_visit(c):
 cards=''.join(f'<article><span class="eyebrow">0{i+1}</span><h3>{h}</h3><p>{body}</p></article>' for i,(h,body) in enumerate(c['plans']))
 return f'<section class="section first-visit" id="first-visit"><h2>{c["planTitle"]}</h2><div class="visit-plan">{cards}</div><p class="fineprint">{c["seatNote"]}</p></section>'

def booking(lang,c):
 x=EXPERIENCE[lang]
 opts=''.join(f'<option value="{v}">{esc(label)}</option>' for v,label in zip(['no_preference','stage_atmosphere','quiet_chat','comfortable_booth','outdoor_view'],x['preferences']))
 occasions=''.join(f'<option value="{i}">{esc(label)}</option>' for i,label in enumerate(x['occasions']))
 progress=''.join(f'<li data-step="{i+1}"><b>{i+1}</b><span>{text}</span></li>' for i,text in enumerate(x['stepNames']))
 return f'''<section class="booking wizard" id="booking"><div class="booking-heading"><p class="eyebrow">M—BOX / RESERVATION</p><h1>{x['flowTitle']}</h1><p>{x['flowIntro']}</p></div><ol class="step-progress">{progress}</ol><div class="booking-panel"><p class="timezone">Shanghai · UTC+8</p><form id="booking-form" novalidate>
<fieldset id="step-1"><h2 class="wide">{x['when']}</h2><label>{x['date']}<input type="date" name="date" required></label><label>{x['time']}<input type="time" name="time" value="21:00" required></label><label class="wide">{x['guests']}<input name="guests" type="number" min="1" max="200" value="2" required></label></fieldset>
<fieldset id="step-2" hidden><h2 class="wide">{x['experience']}</h2><div class="wide show-selection"><h3>{x['shows']}</h3><div id="booking-shows" class="show-choices"></div><p id="booking-shows-state" class="fineprint" role="status"></p><button type="button" id="shows-retry" class="text-link" hidden>{x['retryShows']}</button></div><label class="wide">{x['preference']}<select name="preference">{opts}</select></label><label class="wide">{x['occasion']}<select name="occasion">{occasions}</select></label><label class="wide">{x['notes']}<textarea name="notes" maxlength="80" rows="2"></textarea></label><p class="wide fineprint">{x['showNote']}</p></fieldset>
<fieldset id="step-3" hidden><h2 class="wide">{x['finalCheck']}</h2><p id="booking-summary" class="wide booking-summary"></p><label class="wide">{x['name']}<input name="customerName" autocomplete="name" maxlength="100" required></label><label class="wide">{x['contact']}<input name="contact" autocomplete="off" minlength="3" maxlength="100" aria-describedby="contact-hint" required><small id="contact-hint">{x['contactHint']}</small></label><div class="wide booking-rule-box"><h3>{x['policy']}</h3><p id="booking-deposit"></p><p id="booking-rule" class="fineprint"></p><p class="fineprint">{x['showNote']}</p></div><label class="wide consent"><input type="checkbox" id="booking-consent"> <span>{x['consent']}</span></label></fieldset>
<div class="booking-actions flow-actions"><button class="button outline" id="booking-back" type="button" hidden>{x['previous']}</button><button class="button gold" id="booking-next" type="submit">{x['next']} ↗</button></div></form>
<div id="booking-recovery" hidden><p>{x['uncertain']}</p><button class="button gold" id="booking-recover">{x['recover']}</button></div><p id="booking-status" role="status" aria-live="polite"></p><div id="booking-receipt" hidden><h2 id="receipt-heading"></h2><p id="receipt-note"></p><p id="receipt-detail"></p><code id="receipt-id"></code><div class="booking-actions"><button class="button" id="booking-refresh">{x['refresh']}</button><button class="button outline" id="booking-cancel">{x['cancel']}</button><button class="button outline" id="booking-new" hidden>{c['book']}</button></div></div><p class="fineprint booking-privacy">{x['privacy']}</p>{contact_pair(c, arrow=True)}</div><script id="booking-messages" type="application/json">{json.dumps(x,ensure_ascii=False)}</script><script type="module" src="/booking.js"></script></section>'''

def reserve(lang,c):
 return head(lang,c,reserve=True)+header(lang,c,reserve=True)+f'<main id="main" class="reserve-page"><a class="text-link reserve-back" href="/{lang}/">← {c["back"]}</a>'+booking(lang,c)+'</main>'+footer(lang,c)

def exterior(lang,c):
 x=EXPERIENCE[lang]
 return f'''<section class="exterior"><figure><img src="/assets/exterior-atmosphere-v2.png" width="1672" height="941" loading="lazy" alt="{esc(x['exteriorNote'],quote=True)}"><figcaption>{x['exteriorNote']}</figcaption></figure><div class="exterior-copy"><p class="eyebrow">SHANGHAI / AFTER DARK</p><h2>{x['exteriorTitle']}</h2><p>{x['exteriorText']}</p><a class="button gold seat-link" href="/{lang}/reserve/">{c['book']} ↗</a></div></section>'''

def home(lang,c):
 reasons=''.join(f'''<article class="reason"><span class="ordinal">0{i+1}</span><p class="eyebrow">{r[0]}</p><h3>{r[1]}</h3><p>{r[2]}</p><a class="text-link" href="{('/'+lang+'/reserve/') if i==2 else '#'+['identity','first-visit'][i]}">{r[3]} <span>↗</span></a></article>''' for i,r in enumerate(c['reasons']))
 snapshot=json.loads((P/'public-performance.json').read_text())
 schedules=[x for x in snapshot['schedules'] if x['status']!='cancelled']
 labels=dict(zip(['verified','snapshot','loading','fresh','failed','empty','upcoming','window','ended','refresh','reserve','overnight','overnightNote'],SCHEDULE[lang]))
 labels.update(overnightFailed=OVERNIGHT_FAILURE[lang],set=c['set'],nextDay=c['nextDay'],checked=TIMING_COPY[lang][2])
 c['date']=snapshot['localDate']
 c['scheduleNote']=labels['snapshot']
 rows=''
 for i,s in enumerate(schedules):
  times=s['startsAt'][11:16]+' — '+s['endsAt'][11:16]+(' · '+c['nextDay'] if s['endsAt'][:10]!=s['startsAt'][:10] else '')
  genre=c['rock'] if s['performerProfile']['genres']==['摇滚'] else c['liveGenre']
  rows+=f'<article class="performance"><span class="set-number">{c["set"].replace("{n}",str(i+1))}</span><h3>{esc(s["performerStageName"])}</h3><span class="genre">{genre}</span><time>{times}</time><a class="seat-link" href="/{lang}/reserve/" aria-label="{esc(c["book"]+" — "+s["performerStageName"],quote=True)}">↗</a></article>'
 product_cards='';codes=['CK025','CK002','CXF003','CXF010'];filenames=['mojito','oasis','fries','wings']
 for i,code in enumerate(codes):
  p=next(p for p in products if p['code']==code)
  product_cards+=f'''<article class="product"><a href="/{lang}/menu/?q={code}"><div class="product-image"><img src="/assets/menu-{filenames[i]}-v1.png" alt="{esc(c['products'][i],quote=True)}" width="1536" height="1024" loading="lazy"><span class="product-arrow">↗</span></div><p class="eyebrow">{c['productTypes'][i]}</p><div class="product-name"><h3>{c['products'][i]}</h3><span>¥{int(p['amount_minor'])//100}</span></div>{f'<p class="original-name" lang="zh-CN">{p["name"]}</p>' if lang!='zh' else ''}</a></article>'''
 steps=''.join(f'<li><span>0{i+1}</span><div><h3>{s[0]}</h3><p>{s[1]}</p></div></li>' for i,s in enumerate(c['steps']))
 tags=''.join(f'<span>{x}</span>' for x in c['eventTags'])
 faqs=''.join(f'<details><summary>{q}<span aria-hidden="true">+</span></summary><p>{a}</p></details>' for q,a in c['faq'])
 options=''.join(f'<option value="{i}">{t}</option>' for i,t in enumerate(c['formTypes']))
 return head(lang,c)+header(lang,c)+f'''
<main id="main">
<section class="hero" aria-labelledby="hero-title"><div class="hero-copy"><div class="edition"><span>{c['preview']}</span><span>VOL. 01 / 2026</span></div><p class="eyebrow">{c['kicker']}</p><h1 id="hero-title">{esc(c['hero'][0])}<br><em>{esc(c['hero'][1])}</em></h1><p class="invitation">{nl(c['invite'])}</p><p class="hero-intro">{c['intro']}</p><div class="hero-contact"><p class="contact-email-line"><span class="email-label">{esc(c['emailLabel'])}</span><a class="contact-email" href="mailto:shmbox@qq.com">shmbox@qq.com</a></p></div><div class="hero-actions"><a class="button gold seat-link" href="/{lang}/reserve/">{c["book"]} ↗</a><a class="text-link light" href="#identity">{c['show']} <span>↗</span></a><a class="text-link light" href="#menu">{c['menuLink']} <span>→</span></a></div><p class="hero-location"><span aria-hidden="true">⌖</span> {c['place']}</p></div><figure class="hero-visual"><img src="/assets/venue-night-illustration-v1.png" alt="{esc(c['imageNote'],quote=True)}" width="1672" height="941" fetchpriority="high"><div class="photo-stamp" aria-hidden="true">M—BOX<br><span>THE NIGHT CONTINUES</span></div><figcaption>{c['imageNote']}</figcaption></figure></section>
{decision_intro(lang,c)}
<section class="section why" id="why"><div class="section-heading"><p class="eyebrow">01 / {c['whyLabel']}</p><h2>{nl(c['whyTitle'])}</h2><p class="why-proof">{c['whyProof']}</p></div><div class="reason-grid">{reasons}</div><p class="context-note">{c['fit']}</p></section>
<section class="story" id="story"><div class="story-mark" aria-hidden="true"><span>M—BOX</span><div>19<br>99<span class="story-star">✳</span></div><small>THE STORY GOES ON.</small></div><div class="story-copy"><p class="eyebrow">02 / {c['storyLabel']}</p><h2>{nl(c['storyTitle'])}</h2>{''.join(f'<p>{x}</p>' for x in c['storyText'])}<p class="history-moment">{c['historyMoment']} <a href="https://k.sina.cn/article_5860568496_15d512db0019002x3i.html" target="_blank" rel="noopener">2017 ↗</a></p><p class="history-note">{c['history']}</p><div class="source-links"><span>{c['sources']}</span><a href="https://k.sina.cn/article_5860568496_15d512db0019002x3i.html" target="_blank" rel="noopener">2017 ↗</a><a href="https://www.sohu.com/a/481017465_121124405" target="_blank" rel="noopener">2021 ↗</a></div></div></section>
<section class="section live" id="live"><div class="live-heading"><div><p class="eyebrow">03 / {c['liveLabel']}</p><h2>{nl(c['liveTitle'])}</h2></div><p>{c['liveIntro']}</p></div><div class="schedule-header"><span class="live-dot"></span><strong id="schedule-date">{c['date']}</strong><span id="schedule-label">{labels['verified']}</span></div><p id="schedule-status" class="fineprint" role="status">{labels['snapshot']}</p><div class="schedule" id="schedule-list">{rows}</div><p class="fineprint" id="schedule-checked">{labels['checked']} · {datetime.fromisoformat(snapshot['checkedAt']).astimezone(__import__('zoneinfo').ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d %H:%M')} · Shanghai UTC+8</p><div id="overnight-schedule" hidden><h3>{labels['overnight']} · <span id="overnight-date"></span></h3><div class="schedule" id="overnight-list"></div><p class="fineprint" id="overnight-note">{labels['overnightNote']}</p></div><div class="schedule-actions"><button class="button outline" type="button" id="schedule-refresh">{labels['refresh']}</button><a class="button gold" href="/{lang}/reserve/">{labels['reserve']} ↗</a></div><script id="performance-messages" type="application/json">{json_script(labels)}</script><script id="performance-snapshot" type="application/json">{json_script(snapshot)}</script><script type="module" src="/performance.js"></script></section>
{first_visit(c)}
<section class="section menu-section" id="menu"><div class="menu-heading"><div><p class="eyebrow">04 / {c['menuLabel']}</p><h2>{nl(c['menuTitle'])}</h2></div><p>{c['menuIntro']}</p></div><!--menu:start--><div class="product-grid">{product_cards}</div>{budget(lang,c)}<!--menu:end--><div class="menu-bottom"><!--menu-note:start--><p class="fineprint">{c['menuNote']}</p><!--menu-note:end--><a class="button outline" href="/{lang}/menu/">{c['fullMenu']} <span>↗</span></a></div></section>
<section class="events" id="events"><div class="event-time" aria-hidden="true"><span>DAYTIME & EVENING</span><strong>YOUR<br>GATHERING.</strong><span>M—BOX · PRIVATE EVENTS</span></div><div><p class="eyebrow">05 / {c['eventLabel']}</p><h2>{nl(c['eventTitle'])}</h2><p>{c['eventText']}</p><div class="event-tags">{tags}</div><a class="button gold event-link" href="tel:+8617621392152">{c['eventCta']} <span>↗</span></a>{contact_pair(c, arrow=True)}<p class="fineprint">{c['eventNote']}</p></div></section>
{exterior(lang,c)}
<section class="section visit" id="visit"><p class="eyebrow">06 / {c['visitLabel']}</p><h2>{c['visitTitle']}</h2><ol class="steps">{steps}</ol><div class="contact-grid"><div class="contact-card"><span class="eyebrow">{c['addressLabel']}</span><address>{nl(c['address'])}</address><p>{c['addressHint']}</p><button class="text-link" data-copy="上海市浦东新区浦东南路889号陆家嘴中心穹顶花园RG05">{c['copyAddress']} ↗</button><br><a class="text-link map-link" href="https://www.amap.com/place/B0HGMX0GDR" target="_blank" rel="noopener">{c['mapLabel']} ↗</a></div><div class="contact-card"><span class="eyebrow">{c['phoneLabel']}</span>{contact_pair(c, phone_class='phone')}<a class="text-link" href="tel:+8617621392152">{c['call']} ↗</a><p class="fineprint">{c['phoneNote']}</p></div></div><p class="contact-language fineprint">{c['contactNote']}</p>
</section>
<section class="section faq"><p class="eyebrow">A FEW THINGS TO KNOW</p><h2>{c['faqTitle']}</h2>{faqs}</section></main>'''+footer(lang,c)

def menu(lang,c):
 tabs=f'<button class="filter active" data-filter="all" aria-pressed="true">{c["all"]}</button>'+''.join(f'<button class="filter" data-filter="{i}" aria-pressed="false">{n}</button>' for i,n in enumerate(c['categoryNames']))
 items=''
 translated=dict(zip(['CK025','CK002','CXF003','CXF010','CXW004','dasb11','pijiu6'],c['products']+c['choicesNames']))
 for p in products:
  g=group(p);price=f"{int(p['amount_minor'])/100:,.0f}"
  items+=f'''<article class="catalog-item" data-group="{g}" data-search="{esc(p['name']+' '+p['code']+' '+translated.get(p['code'],''),quote=True)}"><img src="{p['web_image']}" alt="{esc(p['name'],quote=True)}" width="90" height="90" loading="lazy"><div><span class="eyebrow">{c['categoryNames'][g]}</span><h2 lang="{'zh-CN' if lang=='zh' or p['code'] not in translated else lang}">{esc(translated.get(p['code'],p['name']))}</h2>{f'<p class="original-name" lang="zh-CN">{esc(p["name"])}</p>' if lang!='zh' and p['code'] in translated else ''}<small>{esc(p['code'])}</small></div><span class="catalog-price">¥{price}</span></article>'''
 return head(lang,c,True)+header(lang,c,True)+f'''<main id="main" class="catalog section"><a class="text-link" href="/{lang}/">← {c['back']}</a><p class="eyebrow">M—BOX / MENU</p><h1>{c['catalogTitle']}</h1><p class="catalog-intro">{c['catalogIntro']}</p><!--menu-note:start--><p class="fineprint">{c['priceNote']} {c['catalogImageNote']}</p><!--menu-note:end--><!--menu:start--><div class="catalog-tools"><label><span class="sr-only">{c['search']}</span><input id="menu-search" type="search" placeholder="{esc(c['search'],quote=True)}"></label><span id="result-count" aria-live="polite">187 {c['count']}</span></div><div class="filters" role="group" aria-label="{esc(c['menuHeading'],quote=True)}">{tabs}</div><div class="catalog-grid">{items}</div><p id="no-results" hidden>{c['noResults']}</p><!--menu:end--></main>'''+footer(lang,c)

pages={}
for lang,_ in LANGS:
 missing=set(C['zh'])-set(C[lang]);assert not missing,(lang,missing)
 folder=D/lang;folder.mkdir(exist_ok=True);(folder/'menu').mkdir(exist_ok=True);(folder/'reserve').mkdir(exist_ok=True)
 pages[f'/{lang}/']=home(lang,C[lang]);pages[f'/{lang}/menu/']=menu(lang,C[lang]);(folder/'reserve/index.html').write_text(reserve(lang,C[lang]));(folder/'index.html').unlink(missing_ok=True);(folder/'menu/index.html').unlink(missing_ok=True)
(P/'pages.json').write_text(json.dumps(pages,ensure_ascii=False))
from root_page import render_root
(D/'index.html').write_text(render_root(), encoding='utf-8')
(B/'aliyun/public-overrides/index.html').write_text(render_root(), encoding='utf-8')
(D/'robots.txt').write_text(f'User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: {ORIGIN}/sitemap.xml\n')
# All public language routes are explicit and independent of browser/IP routing.
sitemap=['<?xml version="1.0" encoding="UTF-8"?>','<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">']
sitemap.append(f'<url><loc>{ORIGIN}/</loc></url>')
for suffix in ['', 'menu/', 'reserve/']:
 for lang,_ in LANGS:
  sitemap.append(f'<url><loc>{ORIGIN}/{lang}/{suffix}</loc>')
  for alternate,_ in LANGS:
   sitemap.append(f'<xhtml:link rel="alternate" hreflang="{alternate}" href="{ORIGIN}/{alternate}/{suffix}"/>')
  sitemap.append(f'<xhtml:link rel="alternate" hreflang="x-default" href="{ORIGIN}/zh/{suffix}"/></url>')
sitemap.append('</urlset>')
(D/'sitemap.xml').write_text('\n'.join(sitemap)+'\n')
(A/'favicon.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#214635"/><text x="32" y="46" text-anchor="middle" font-size="44" font-family="Georgia" fill="#ddc390">M</text></svg>')
m=B/'.openai/hosting.json';config=json.loads(m.read_text());config.pop('static',None);m.write_text(json.dumps(config,indent=2)+'\n')
print('Built 7 home pages, 7 menu pages, 7 reservation pages; 187 items each. Public pages allow indexing; sitemap includes all seven languages.')
from build_archive import render_archive
render_archive(B, LANGS, C, header, footer)
