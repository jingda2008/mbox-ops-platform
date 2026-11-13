import importlib.util
from pathlib import Path
import unittest
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
spec=importlib.util.spec_from_file_location('cooperation',Path(__file__).with_name('channel-cooperation.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class PatchTest(unittest.TestCase):
 def test_navigation_only(self):
  pages={f'/{lang}/{suffix}':'prefix<nav aria-label="M-BOX"><a href="/menu">菜单</a></nav><footer><div class="footer-bottom">suffix</div></footer>' for lang in module.LABELS for suffix in ['', 'menu/']}
  result=module.update_pages(pages)
  for path,html in result.items():
   label=module.LABELS[path.split('/')[1]]
   self.assertEqual(html.count(f'<a class="cooperation-nav" href="/cooperation/">{label}</a>'),2)
   self.assertEqual(html.replace(f'<a class="cooperation-nav" href="/cooperation/">{label}</a>',''),pages[path])
  with self.assertRaises(ValueError):module.update_pages(result)
 def test_routes_only_in_website_proxy(self):
  original='operations-unchanged\n\treverse_proxy mbox-public-site-www-v26:8080 {\n\t\theader_up X-Mbox-Client-Ip {remote_host}\n\t}\nother-unchanged'
  result=module.update_caddy(original)
  self.assertTrue(result.startswith('operations-unchanged\n'));self.assertTrue(result.endswith('\nother-unchanged'))
  self.assertIn('uri replace /cooperation/api/ /api/cooperation/',result)
  self.assertIn('handle /cooperation/*',result)
  self.assertIn('redir * /cooperation/ 308',result)
  with self.assertRaises(ValueError):module.update_caddy(result)
class HealthProbeTest(unittest.TestCase):
 def probe(self, response):
  seen=[]
  class Handler(BaseHTTPRequestHandler):
   def do_GET(self):
    seen.append((self.path,self.headers.get('Host')))
    self.send_response(response if self.path=='/healthz' and self.headers.get('Host')=='www.shmbox.com' else 421)
    self.end_headers()
   def log_message(self,*args):pass
  server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=Thread(target=server.serve_forever,daemon=True);thread.start()
  try:
   script=module.HEALTH_PROBE.replace('port:8080',f'port:{server.server_port}')
   result=subprocess.run(['node','--input-type=module','-e',script],capture_output=True,timeout=15)
   return result.returncode,seen
  finally:server.shutdown();server.server_close();thread.join()
 def test_health_sends_required_host(self):
  code,seen=self.probe(200);self.assertEqual(code,0);self.assertEqual(seen,[('/healthz','www.shmbox.com')])
 def test_unhealthy_response_never_activates(self):
  code,seen=self.probe(503);self.assertNotEqual(code,0);self.assertEqual(len(seen),20)
if __name__=='__main__':unittest.main()
