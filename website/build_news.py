"""Build static, translated news. Safe to rerun without rebuilding booking pages."""
from pathlib import Path
import html
import json
import re
from news_content import ARTICLES, LANGS, UI

ORIGIN = 'https://www.shmbox.com'
esc = html.escape

def wire_page(page, lang, suffix=None):
    page = re.sub(r'<a class="news-nav"[^>]*>.*?</a>', '', page)
    nav = f'<a class="news-nav" href="/{lang}/news/">{esc(UI[lang]["nav"])}</a>'
    # Insert first so this new section is visible even in the scrollable mobile navigation.
    page = page.replace('<nav aria-label="M-BOX">', '<nav aria-label="M-BOX">'+nav, 1)
    if '<link rel="stylesheet" href="/news.css">' not in page:
        page = page.replace('</head>', '<link rel="stylesheet" href="/news.css"></head>')
    if suffix is not None:
        page = re.sub(r'value="/(zh|en|ru|ja|ko|fr|de)/(?:[^\"]*)"', lambda m:f'value="/{m[1]}/{suffix}"', page)
    return page

def head(lang, suffix, title, description, schema, poster=None):
    path = f'/{lang}/{suffix}'
    alternates = ''.join(f'<link rel="alternate" hreflang="{l}" href="{ORIGIN}/{l}/{suffix}">' for l in LANGS)
    image = f'<meta property="og:image" content="{ORIGIN}{poster}">' if poster else ''
    return f'''<!doctype html><html lang="{'zh-CN' if lang=='zh' else lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(title)} | M-BOX Shanghai</title><meta name="description" content="{esc(description,quote=True)}"><meta name="robots" content="index,follow,max-image-preview:large"><meta name="theme-color" content="#315d46"><link rel="canonical" href="{ORIGIN}{path}">{alternates}<link rel="alternate" hreflang="x-default" href="{ORIGIN}/zh/{suffix}"><meta property="og:type" content="{'article' if poster else 'website'}"><meta property="og:title" content="{esc(title,quote=True)}"><meta property="og:description" content="{esc(description,quote=True)}"><meta property="og:url" content="{ORIGIN}{path}">{image}<link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/news.css"><script src="/app.js" defer></script><script type="application/ld+json">{json.dumps(schema,ensure_ascii=False).replace('<',chr(92)+'u003c')}</script></head><body data-language="{lang}">'''

def card(lang, article):
    c, u = article['copy'][lang], UI[lang]
    url = f'/{lang}/news/{article["slug"]}/'
    return f'''<article class="news-card"><a class="news-card-image" href="{url}" tabindex="-1" aria-hidden="true"><img src="{article['poster']}" width="1280" height="720" loading="lazy" alt=""></a><div class="news-card-copy"><p class="eyebrow">{esc(u['category'])} · M—BOX</p><h3><a href="{url}">{esc(c['title'])}</a></h3><p class="news-subtitle">{esc(c['subtitle'])}</p><p>{esc(c['summary'])}</p><p class="news-date">{esc(u['published'])} <time datetime="{article['published']}">{article['published']}</time></p><a class="text-link" href="{url}">{esc(u['read'])} ↗</a></div></article>'''

def render_news(base=None):
    base = base or Path(__file__).parent
    pages_path = base/'data/pages.json'
    pages = json.loads(pages_path.read_text())
    urls = []
    for lang in LANGS:
        u = UI[lang]
        home = pages[f'/{lang}/']
        # Reuse only presentation chrome; no reservation or API source is imported.
        nav = re.search(r'<header class="header">.*?</header>', home, re.S)[0]
        foot = home[home.index('<footer>'):]
        foot = re.sub(r'(<div class="footer-bottom"><span>.*?</span><span>).*?(</span></div>)', lambda m:m[1]+esc(u['category'])+m[2], foot)
        skip = re.search(r'<a class="skip".*?</a>', home, re.S)[0]
        cards = ''.join(card(lang, a) for a in reversed(ARTICLES))
        preview = f'''<!--news:start--><section class="section news-preview" id="news"><div class="news-heading"><div><p class="eyebrow">M—BOX / {esc(u['nav'])}</p><h2>{esc(u['heading'])}</h2><p>{esc(u['intro'])}</p></div><a class="text-link" href="/{lang}/news/">{esc(u['all'])} ↗</a></div>{card(lang, ARTICLES[-1])}</section><!--news:end-->'''
        home = re.sub(r'<!--news:start-->.*?<!--news:end-->', '', home, flags=re.S)
        marker = '<section class="events" id="events">'
        assert home.count(marker) == 1
        pages[f'/{lang}/'] = wire_page(home.replace(marker, preview+marker), lang)
        pages[f'/{lang}/menu/'] = wire_page(pages[f'/{lang}/menu/'], lang)
        archive = base/'public'/lang/'archive/index.html'
        if archive.exists():
            archive.write_text(wire_page(archive.read_text(), lang))
        suffix = 'news/'
        schema = {'@context':'https://schema.org','@type':'CollectionPage','url':ORIGIN+f'/{lang}/{suffix}','name':u['nav']+' | M-BOX','description':u['intro'],'inLanguage':lang,'mainEntity':{'@type':'ItemList','itemListElement':[{'@type':'ListItem','position':i+1,'url':f'{ORIGIN}/{lang}/news/{a["slug"]}/','name':a['copy'][lang]['subtitle']} for i,a in enumerate(reversed(ARTICLES))]}}
        listing = head(lang,suffix,u['nav'],u['intro'],schema)+skip+nav+f'''<main id="main" class="news-page"><section class="news-hero"><p class="eyebrow">M—BOX / {esc(u['nav'])}</p><h1>{esc(u['heading'])}</h1><p class="news-lead">{esc(u['intro'])}</p></section><section class="section news-list" aria-label="{esc(u['nav'],quote=True)}">{cards}</section></main>'''+foot
        folder = base/'public'/lang/'news'; folder.mkdir(parents=True,exist_ok=True)
        (folder/'index.html').write_text(wire_page(listing,lang,suffix))
        urls.append((lang,suffix,max(a['published'] for a in ARTICLES)))
        for a in ARTICLES:
            c = a['copy'][lang]; suffix = f'news/{a["slug"]}/'; url = ORIGIN+f'/{lang}/{suffix}'
            schema = {'@context':'https://schema.org','@type':'Article','@id':url+'#article','mainEntityOfPage':url,'url':url,'headline':c['subtitle'],'alternativeHeadline':c['title'],'description':c['summary'],'inLanguage':lang,'datePublished':a['published'],'author':{'@type':'Organization','name':'M-BOX','url':ORIGIN+'/zh/'},'publisher':{'@type':'Organization','name':'M-BOX','url':ORIGIN+'/'},'image':[ORIGIN+a['poster']],'articleBody':'\n\n'.join([c['intro']]+[t+'\n'+p for t,p in c['sections']]),'video':{'@type':'VideoObject','name':c['videoLabel'],'description':c['description'],'thumbnailUrl':ORIGIN+a['poster'],'contentUrl':ORIGIN+a['video'],'uploadDate':a['published'],'duration':a['duration']}}
            sections = ''.join(f'<section><h2>{esc(t)}</h2><p>{esc(p)}</p></section>' for t,p in c['sections'])
            article = f'''<main id="main" class="news-page"><article><header class="news-hero"><a class="text-link" href="/{lang}/news/">← {esc(u['back'])}</a><p class="eyebrow">M—BOX / {esc(u['category'])}</p><h1>{esc(c['title'])}</h1><p class="news-lead">{esc(c['subtitle'])}</p><p class="news-date">{esc(u['published'])} <time datetime="{a['published']}">{a['published']}</time></p></header><div class="news-body"><p class="news-intro">{esc(c['intro'])}</p><figure class="news-film"><video controls playsinline preload="none" poster="{a['poster']}" width="1280" height="720" aria-label="{esc(c['videoLabel'],quote=True)}"><source src="{a['video']}" type="video/mp4"></video><figcaption><strong>{esc(c['videoLabel'])}</strong><p>{esc(c['description'])}</p></figcaption></figure>{sections}<div class="news-cta"><a class="button gold" href="mailto:shmbox@qq.com">{esc(u['enquire'])} ↗</a><a class="text-link" href="/{lang}/#live">{esc(u['music'])} ↗</a><a class="text-link" href="tel:+8617621392152">+86 176 2139 2152</a><a class="text-link" href="mailto:shmbox@qq.com">shmbox@qq.com</a></div><p class="news-source">{esc(c['source'])}</p></div></article></main>'''
            detail = head(lang,suffix,c['subtitle'],c['summary'],schema,a['poster'])+skip+nav+article+foot
            folder = base/'public'/lang/suffix; folder.mkdir(parents=True,exist_ok=True)
            (folder/'index.html').write_text(wire_page(detail,lang,suffix))
            urls.append((lang,suffix,a['published']))
    pages_path.write_text(json.dumps(pages,ensure_ascii=False))
    for target in [base/'public/sitemap.xml',base/'aliyun/public-overrides/sitemap.xml']:
        sitemap=(target if target.exists() else base/'aliyun/public-overrides/sitemap.xml').read_text()
        # Preserve unrelated URL entries and lastmod values; replace only this collection.
        sitemap=re.sub(r'<url>\s*<loc>[^<]+/(?:zh|en|ru|ja|ko|fr|de)/news/.*?</url>\s*','',sitemap,flags=re.S)
        entries=[]
        for lang,suffix,date in urls:
            alt=''.join(f'<xhtml:link rel="alternate" hreflang="{l}" href="{ORIGIN}/{l}/{suffix}"/>' for l in LANGS)
            entries.append(f'<url><loc>{ORIGIN}/{lang}/{suffix}</loc><lastmod>{date}</lastmod>{alt}<xhtml:link rel="alternate" hreflang="x-default" href="{ORIGIN}/zh/{suffix}"/></url>')
        target.write_text(sitemap.replace('</urlset>','\n'.join(entries)+'\n</urlset>'))
    print('Built 7 news indexes and 7 stories; linked from home, menu and archive. Booking untouched.')

if __name__ == '__main__':
    render_news()
