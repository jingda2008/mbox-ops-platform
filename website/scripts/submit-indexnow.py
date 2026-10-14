"""Notify IndexNow of the deployed sitemap. Run only after successful publication."""
import json, urllib.request, urllib.error, xml.etree.ElementTree as ET
from urllib.parse import urlparse
from pathlib import Path
from datetime import datetime, timezone
import argparse
parser=argparse.ArgumentParser();parser.add_argument('--report',required=True);args=parser.parse_args()
base=Path(__file__).resolve().parent.parent
config=json.loads((base/'data/search-indexing.json').read_text());origin=config['origin'];keyfile=config['indexNowKeyFile'];key=keyfile.removesuffix('.txt')
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
opener.addheaders=[("User-Agent","MBOX-IndexNow-Submission/1.0")]
with opener.open(origin+'/'+keyfile,timeout=30) as r: assert r.status==200 and r.read().decode().strip()==key
with opener.open(origin+'/sitemap.xml',timeout=30) as r: sitemap=ET.fromstring(r.read())
urls=[x.text for x in sitemap.findall('{http://www.sitemaps.org/schemas/sitemap/0.9}url/{http://www.sitemaps.org/schemas/sitemap/0.9}loc')]
assert urls and len(urls)<=10000
assert all(urlparse(u).netloc==urlparse(origin).netloc and not urlparse(u).query and not urlparse(u).path.startswith('/api/') for u in urls)
body={'host':urlparse(origin).netloc,'key':key,'keyLocation':origin+'/'+keyfile,'urlList':urls}
req=urllib.request.Request('https://api.indexnow.org/indexnow',data=json.dumps(body).encode(),headers={'Content-Type':'application/json; charset=utf-8'},method='POST')
try:
 with opener.open(req,timeout=45) as r: status=r.status;response=r.read().decode()
except urllib.error.HTTPError as e: status=e.code;response=e.read().decode()
report={'submitted_at':datetime.now(timezone.utc).isoformat(),'endpoint':'https://api.indexnow.org/indexnow','status':status,'url_count':len(urls),'urls':urls,'response':response,'meaning':'Received; key validation pending' if status==202 else 'Submitted successfully; not proof of crawling or indexing' if status==200 else 'Submission not confirmed'}
Path(args.report).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k!='urls'}));assert status in (200,202)
