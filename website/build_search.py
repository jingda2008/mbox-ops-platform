"""Idempotent discovery improvements without replacing existing editorial content."""
from pathlib import Path
import html
import json
import re

E = html.escape

def enhance_home(source, lang, copy):
    source = re.sub(r'<title>.*?</title>', lambda _: '<title>'+E(copy['title'])+'</title>', source, count=1)
    source = re.sub(r'<!--visit-facts:start-->.*?<!--visit-facts:end-->', '', source, flags=re.S)
    cards = ''.join('<div><dt>'+E(copy[key+'Title'])+'</dt><dd>'+E(copy[key])+'</dd></div>' for key in ['address', 'contact', 'prices', 'hours'])
    facts = f'''<!--visit-facts:start--><section class="section visit-facts" id="visit-facts" aria-labelledby="visit-facts-title"><p class="eyebrow">{E(copy['identity'])}</p><h2 id="visit-facts-title">{E(copy['factsTitle'])}</h2><dl>{cards}</dl><div class="facts-actions"><a class="button outline" href="/{lang}/menu/">{E(copy['menuLink'])} ↗</a><a class="button gold" href="/{lang}/reserve/">{E(copy['rulesLink'])} ↗</a></div></section><!--visit-facts:end-->'''
    source = source.replace('<section class="section visit"', facts+'<section class="section visit"', 1)
    source = source.replace(f'href="/{lang}/#visit"', f'href="/{lang}/#visit-facts"')
    if '/search.css' not in source:
        source = source.replace('</head>', '<link rel="stylesheet" href="/search.css"></head>', 1)
    def messages(match):
        data = json.loads(match[1])
        data.update({key: copy[key] for key in ['dateHeading','dateLink','latestLink','fixedDateNote','dateEmpty','dateUnavailable']})
        return '<script id="performance-messages" type="application/json">'+json.dumps(data,ensure_ascii=False).replace('<','\\u003c')+'</script>'
    return re.sub(r'<script id="performance-messages" type="application/json">(.*?)</script>', messages, source, count=1, flags=re.S)

def clean_recovery(source):
    return re.sub(r'(<div id="booking-recovery"[^>]*>)<p[^>]*>.*?</p>', r'\1<p id="booking-recovery-note"></p>', source, count=1, flags=re.S)

def render_search(base):
    copy = json.loads((base/'data/search-content.json').read_text())
    path = base/'data/pages.json'
    pages = json.loads(path.read_text())
    for lang, c in copy.items():
        pages[f'/{lang}/'] = enhance_home(pages[f'/{lang}/'], lang, c)
        for root in [base/'public', base/'aliyun/public-overrides']:
            page = root/lang/'reserve/index.html'
            if page.exists(): page.write_text(clean_recovery(page.read_text()))
    path.write_text(json.dumps(pages, ensure_ascii=False))
    for root in [base/'public', base/'aliyun/public-overrides']:
        sitemap = root/'sitemap.xml'
        if not sitemap.exists(): continue
        # This is the content-change date, not the date on which a build happens.
        def modified(match):
            return match[1]+'<lastmod>2026-11-13</lastmod>'
        text = re.sub(r'(<url><loc>https://[^<]+/(?:zh|en|ru|ja|ko|fr|de)/(?:reserve/)?</loc>)(?:\s*<lastmod>[^<]*</lastmod>)?', modified, sitemap.read_text())
        sitemap.write_text(text)

if __name__ == '__main__': render_search(Path(__file__).parent)
