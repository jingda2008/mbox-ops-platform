"""Add an idempotent gallery only to the seven public homepages."""
from pathlib import Path
import html, json, re, sys
from venue_content import VENUE, PROMO_CAPTIONS
E=html.escape
ASSETS='/assets/venue-20261029/'
PHOTOS=['stage.webp','green-gold.webp','booths-bar.webp']
def enhance_home(source,lang):
 c=VENUE[lang]
 source=re.sub(r'<!--venue:start-->.*?<!--venue:end-->','',source,flags=re.S)
 source=re.sub(r'<a class="venue-jump"[^>]*>.*?</a>','',source,flags=re.S)
 cards=''.join(f'<figure><a href="{ASSETS}{file}" target="_blank" rel="noopener"><img src="{ASSETS}{file}" alt="{E(c["photos"][i],quote=True)}" width="1448" height="1086" loading="lazy" decoding="async"></a><figcaption><span>0{i+1}</span>{E(c["photos"][i])}</figcaption></figure>' for i,file in enumerate(PHOTOS))
 section=f'''<!--venue:start--><section class="section venue-gallery" id="space" aria-labelledby="space-title"><div class="venue-heading"><div><p class="eyebrow">{E(c['label'])}</p><h2 id="space-title">{E(c['title'])}</h2></div><p>{E(c['intro'])}</p></div><div class="venue-photos">{cards}</div><div class="venue-layout" id="seating"><a class="venue-plan" href="{ASSETS}seating-plan.png" target="_blank" rel="noopener" aria-label="{E(c['zoom'],quote=True)}"><img src="{ASSETS}seating-plan.webp" alt="{E(c['alt'],quote=True)}" width="941" height="1672" loading="lazy" decoding="async"></a><div class="venue-layout-copy"><p class="eyebrow">MBOX · LIVEHOUSE LAYOUT</p><h3>{E(c['layout'])}</h3><p>{E(c['body'])}</p><div class="venue-actions"><a class="button gold" href="/{lang}/reserve/">{E(c['book'])} ↗</a><a class="text-link light" href="{ASSETS}seating-plan.png" target="_blank" rel="noopener">{E(c['zoom'])} ↗</a></div></div></div></section><!--venue:end-->'''
 marker='<section class="section why"'
 assert source.count(marker)==1,lang
 source=source.replace(marker,section+marker,1)
 # Discoverable early, without widening the existing seven-language navigation.
 marker='<section class="section identity"'
 source=source.replace(marker,f'<a class="venue-jump" href="#space">{E(c["jump"])} <span aria-hidden="true">↗</span></a>'+marker,1)
 if '/venue.css' not in source:source=source.replace('</head>','<link rel="stylesheet" href="/venue.css"></head>',1)
 # Keep captions promotional, with no new claims of photographic authenticity.
 hero, exterior, footer = PROMO_CAPTIONS[lang]
 def caption(match, text):
  block=re.sub(r'alt="[^"]*"', lambda _: 'alt="'+E(text,quote=True)+'"', match[0], count=1)
  return re.sub(r'<figcaption>.*?</figcaption>',lambda _: '<figcaption>'+E(text)+'</figcaption>',block,count=1,flags=re.S)
 source=re.sub(r'<figure class="hero-visual">.*?</figure>',lambda m:caption(m,hero),source,count=1,flags=re.S)
 source=re.sub(r'<section class="exterior"><figure>.*?</figure>',lambda m:caption(m,exterior),source,count=1,flags=re.S)
 source=re.sub(r'(<div class="footer-bottom"><span>.*?</span><span>).*?(</span></div>)',lambda m:m[1]+E(footer)+m[2],source,count=1,flags=re.S)
 return source

def render_venue(base):
 path=base/'data/pages.json';pages=json.loads(path.read_text())
 for lang in VENUE:pages[f'/{lang}/']=enhance_home(pages[f'/{lang}/'],lang)
 path.write_text(json.dumps(pages,ensure_ascii=False))
if __name__=='__main__':render_venue(Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).parent)
