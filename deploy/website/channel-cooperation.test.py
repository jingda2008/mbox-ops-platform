import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('cooperation',Path(__file__).with_name('channel-cooperation.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class PatchTest(unittest.TestCase):
 def test_navigation_only(self):
  pages={f'/{lang}/{suffix}':'prefix<nav aria-label="M-BOX"><a href="/menu">菜单</a></nav>suffix' for lang in module.LABELS for suffix in ['', 'menu/']}
  result=module.update_pages(pages)
  for path,html in result.items():
   label=module.LABELS[path.split('/')[1]]
   self.assertEqual(html.replace(f'<a class="cooperation-nav" href="/cooperation/">{label}</a>',''),pages[path])
  with self.assertRaises(ValueError):module.update_pages(result)
 def test_routes_only_in_website_proxy(self):
  original='operations-unchanged\n\treverse_proxy mbox-public-site-www-v25:8080 {\n\t\theader_up X-Mbox-Client-Ip {remote_host}\n\t}\nother-unchanged'
  result=module.update_caddy(original)
  self.assertTrue(result.startswith('operations-unchanged\n'));self.assertTrue(result.endswith('\nother-unchanged'))
  self.assertIn('uri replace /cooperation/api/ /api/cooperation/',result)
  self.assertIn('handle /cooperation/*',result)
  self.assertIn('redir * /cooperation/ 308',result)
  with self.assertRaises(ValueError):module.update_caddy(result)
if __name__=='__main__':unittest.main()
