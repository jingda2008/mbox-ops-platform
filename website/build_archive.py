"""Render evidence-backed editorial pages without modifying transaction flows."""
import html, json
from archive_content import COPY, NAMES, SOURCES
from experience_content import EXPERIENCE

def render_archive(base, langs, content, header, footer):
 origin='https://www.shmbox.com'
 esc=html.escape
 pages_path=base/'data/pages.json'
 pages=json.loads(pages_path.read_text())
 ids=['history','performers','gatherings']
 for lang,_ in langs:
  c=COPY[lang]; path=f'/{lang}/archive/'
  alternates=''.join(f'<link rel="alternate" hreflang="{l}" href="{origin}/{l}/archive/">' for l,_ in langs)
  schema={'@context':'https://schema.org','@type':'CollectionPage','@id':origin+path+'#page','url':origin+path,'name':c['title'],'description':c['intro'],'inLanguage':'zh-CN' if lang=='zh' else lang,'about':{'@id':origin+'/#venue'},'dateModified':'2026-10-15','citation':SOURCES}
  head=f'''<!doctype html><html lang="{'zh-CN' if lang=='zh' else lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(c['title'])}</title><meta name="description" content="{esc(c['intro'],quote=True)}"><meta name="robots" content="index,follow,max-image-preview:large"><meta name="theme-color" content="#172c21"><link rel="canonical" href="{origin}{path}">{alternates}<link rel="alternate" hreflang="x-default" href="{origin}/zh/archive/"><link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/archive.css"><script src="/app.js" defer></script><script type="application/ld+json">{json.dumps(schema,ensure_ascii=False).replace('<',chr(92)+'u003c')}</script></head><body data-language="{lang}"><a class="skip" href="#main">{content[lang]['skip']}</a>'''
  nav=header(lang,content[lang])
  for l,_ in langs: nav=nav.replace(f'value="/{l}/"',f'value="/{l}/archive/"')
  intro=f'''<main id="main" class="archive-page"><section class="archive-hero"><a class="text-link" href="/{lang}/">← {esc(c['back'])}</a><p class="eyebrow">M—BOX / {esc(c['label'])}</p><h1>{'<br>'.join(map(esc,c['headline'].split(chr(10))))}</h1><p class="archive-lead">{esc(c['intro'])}</p><div class="archive-links">{''.join(f'<a href="#{i}">{esc(t)} ↘</a>' for i,t in zip(ids,c['sections']))}</div><a class="button gold" href="/{lang}/reserve/">{esc(c['reserve'])} ↗</a></section>'''
  history=''.join(f'<article class="archive-entry"><p class="archive-year">{year}</p><div><h3>{esc(title)}</h3><p>{esc(body)}</p><a class="text-link" href="{SOURCES[0 if n<2 else 1]}" target="_blank" rel="noopener">{2017 if n<2 else 2021} ↗</a></div></article>' for n,(year,title,body) in enumerate(c['history']))
  story=f'<section class="section archive-history" id="history"><p class="eyebrow">01 / {esc(c["sections"][0])}</p><h2>{esc(c["historyTitle"])}</h2><p class="archive-lead">{esc(c["historyIntro"])}</p><div class="archive-timeline">{history}</div><p class="fineprint">{esc(c["sourceNote"])}</p></section>'
  roster=''.join(f'<li><span lang="{"en" if name in ["Natalie","Amo"] else "zh-CN"}">{esc(name)}</span></li>' for name in NAMES)
  film=EXPERIENCE[lang]
  clip=f'<figure class="archive-performance"><video controls muted playsinline preload="none" poster="/assets/mbox-live-20261013-poster.jpg" width="1280" height="720" aria-label="{esc(film["videoTitle"],quote=True)}"><source src="/assets/mbox-live-20261013.mp4" type="video/mp4"></video><figcaption><strong>{esc(film["videoTitle"])}</strong><p>{esc(film["videoNote"])}</p></figcaption></figure>'
  people=f'''<section class="section archive-people" id="performers"><p class="eyebrow">02 / {esc(c['sections'][1])}</p><h2>{esc(c['peopleTitle'])}</h2><p class="archive-lead">{esc(c['peopleIntro'])}</p>{clip}<ul class="artist-roster">{roster}</ul><p class="fineprint">{esc(c['peopleNote'])}</p><a class="button" href="/{lang}/#live">{esc(c['listen'])} ↗</a><a class="text-link archive-film-link" href="/{lang}/#identity">{esc(content[lang]['show'])} ↗</a></section>'''
  plans=''.join(f'<article><span class="eyebrow">0{n+1}</span><h3>{esc(t)}</h3><p>{esc(b)}</p></article>' for n,(t,b) in enumerate(c['plans']))
  events=f'''<section class="section archive-events" id="gatherings"><p class="eyebrow">03 / {esc(c['sections'][2])}</p><h2>{esc(c['eventTitle'])}</h2><p class="archive-lead">{esc(c['eventIntro'])}</p><h3>{esc(c['planTitle'])}</h3><div class="archive-plan-grid">{plans}</div><p class="fineprint">{esc(c['planNote'])}</p><div class="archive-contacts"><a class="button gold" href="mailto:shmbox@qq.com">{esc(c['cta'])} ↗</a><a class="text-link" href="tel:+8617621392152">+86 176 2139 2152</a></div></section><p class="archive-updated">{esc(c['updated'])}</p></main>'''
  folder=base/'public'/lang/'archive';folder.mkdir(parents=True,exist_ok=True)
  (folder/'index.html').write_text(head+nav+intro+story+people+events+footer(lang,content[lang]))
  cards=''.join(f'<a href="{path}#{i}"><span class="eyebrow">0{n+1}</span><h3>{esc(t)}</h3><p>{esc(b)}</p><span class="text-link">{esc(c["read"])} ↗</span></a>' for n,(i,t,b) in enumerate(zip(ids,c['sections'],c['teasers'])))
  teaser=f'<section class="section archive-preview" id="archive"><p class="eyebrow">M—BOX / {esc(c["label"])}</p><h2>{esc(c["historyTitle"])}</h2><div class="archive-preview-grid">{cards}</div></section>'
  home=pages[f'/{lang}/']
  home=home.replace('</head>','<link rel="stylesheet" href="/archive.css"></head>')
  marker='<section class="section live" id="live">'
  assert home.count(marker)==1
  pages[f'/{lang}/']=home.replace(marker,teaser+marker)
 pages_path.write_text(json.dumps(pages,ensure_ascii=False))
 sitemap=base/'public/sitemap.xml'
 text=sitemap.read_text()
 entries=[]
 for lang,_ in langs:
  alt=''.join(f'<xhtml:link rel="alternate" hreflang="{l}" href="{origin}/{l}/archive/"/>' for l,_ in langs)
  entries.append(f'<url><loc>{origin}/{lang}/archive/</loc><lastmod>2026-10-15</lastmod>{alt}<xhtml:link rel="alternate" hreflang="x-default" href="{origin}/zh/archive/"/></url>')
 text=text.replace('</urlset>','\n'.join(entries)+'\n</urlset>')
 sitemap.write_text(text)
 # The Aliyun overlay must include the same routes; do not overwrite other overlays.
 (base/'aliyun/public-overrides/sitemap.xml').write_text(text.replace('https://mbox-shanghai-preview-20261013.jingda2008.chatgpt.site',origin))
