"""Update only the seven marketing homepages; preserve all booking and news pages."""
from pathlib import Path
import json, re, html
from international_content import VISITORS
E=html.escape

def section(lang,c):
 cards=''.join(f'<article><h3>{E(title)}</h3><p>{E(body)}</p></article>' for title,body in c['cards'])
 return f'''<section class="section international" id="international" aria-labelledby="international-title"><p class="eyebrow">{E(c['label'])}</p><h2 id="international-title">{E(c['title'])}</h2><p class="international-intro">{E(c['intro'])}</p><div class="international-grid">{cards}</div><p class="international-address" lang="zh-CN">上海市浦东新区浦东南路889号 · 陆家嘴中心穹顶花园 RG05</p><div class="international-actions"><a class="button gold" href="/{lang}/reserve/">{E(c['book'])} ↗</a><a class="button outline" href="/{lang}/menu/">{E(c['menu'])} ↗</a></div></section>'''

def enhance_home(source,lang):
 c=VISITORS[lang]
 source=re.sub(r'<!--international:start-->.*?<!--international:end-->','',source,flags=re.S)
 source=re.sub(r'<a class="international-jump".*?</a>','',source,flags=re.S)
 source=re.sub(r'<p class="fineprint schedule-date-note">.*?</p>','',source,flags=re.S)
 source=source.replace('<section class="section identity"',f'<a class="international-jump" href="#international">{E(c["jump"])} <span aria-hidden="true">↗</span></a><section class="section identity"',1)
 assert source.count('<section class="section visit"')==1
 source=source.replace('<section class="section visit"','<!--international:start-->'+section(lang,c)+'<!--international:end--><section class="section visit"',1)
 if '/international.css' not in source:source=source.replace('</head>','<link rel="stylesheet" href="/international.css"></head>')
 source=re.sub(r'<meta name="description" content="[^"]*">',lambda _:f'<meta name="description" content="{E(c["meta"],quote=True)}">',source,count=1)
 def schema(m):
  data=json.loads(m[1])
  for item in data:
   if item.get('@type') in ['WebPage','BarOrPub']:item['description']=c['meta']
  return '<script type="application/ld+json">'+json.dumps(data,ensure_ascii=False).replace('<','\\u003c')+'</script>'
 source=re.sub(r'<script type="application/ld\+json">(.*?)</script>',schema,source,count=1,flags=re.S)
 def messages(m):
  data=json.loads(m[1]);data.update(staleLabel=c['staleLabel'],staleNote=c['staleNote'])
  return '<script id="performance-messages" type="application/json">'+json.dumps(data,ensure_ascii=False)+'</script>'
 source=re.sub(r'<script id="performance-messages" type="application/json">(.*?)</script>',messages,source,count=1,flags=re.S)
 source=source.replace('<div class="schedule-actions">',f'<p class="fineprint schedule-date-note">{E(c["dateNote"])}</p><div class="schedule-actions">',1)
 return source

def render_international(base):
 path=base/'data/pages.json';pages=json.loads(path.read_text())
 for lang in VISITORS:pages[f'/{lang}/']=enhance_home(pages[f'/{lang}/'],lang)
 path.write_text(json.dumps(pages,ensure_ascii=False))
if __name__=='__main__':render_international(Path(__file__).parent)
