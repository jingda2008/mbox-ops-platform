const LEGACY = 'mbox-shanghai-preview-20261013.jingda2008.chatgpt.site';
const PUBLIC = 'https://www.shmbox.com';
export function canonicalDomain(request) {
 const url = new URL(request.url);
 if (url.hostname !== LEGACY || !['GET','HEAD'].includes(request.method)) return null;
 const path = url.pathname;
 if (path === '/robots.txt') return new Response(request.method === 'HEAD' ? null : 'User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: '+PUBLIC+'/sitemap.xml\n', {headers:{'content-type':'text/plain; charset=utf-8'}});
 if (path === '/sitemap.xml') return new Response(null,{status:308,headers:{location:PUBLIC+path,'cache-control':'public, max-age=300'}});
 if (!/^\/(?:index\.html)?$/.test(path) && !/^\/(zh|en|ru|ja|ko|fr|de)(?:\/(?:menu(?:\/(?:index\.html)?)?|index\.html)?)?\/?$/.test(path)) return null;
 let target = path.replace(/index\.html$/, '');
 if (!target.endsWith('/')) target += '/';
 return new Response(null,{status:308,headers:{location:PUBLIC+target,'cache-control':'public, max-age=300'}});
}
