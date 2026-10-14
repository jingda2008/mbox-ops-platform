const ORIGIN = 'https://mbox.shmbox.com';
const countryLanguages = {CN:'zh',TW:'zh',HK:'zh',MO:'zh',RU:'ru',JP:'ja',KR:'ko',FR:'fr',DE:'de',AT:'de'};
const headers = {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-robots-tag':'noindex, nofollow','x-content-type-options':'nosniff'};
const error = (status, code) => Response.json({error:{code}}, {status,headers});
export async function gateway(request, send = fetch) {
  const url = new URL(request.url);
  if (url.pathname === '/api/language' && request.method === 'GET') {
    const country = request.cf?.country;
    return Response.json({language: countryLanguages[country] || 'en', source:country?'country':'fallback'}, {headers});
  }
  if (!url.pathname.startsWith('/api/public/')) return null;
  const allowed = {
    '/api/public/reservation/session':['POST'],
    '/api/public/reservation/availability':['GET'],
    '/api/public/reservation/performances':['GET'],
    '/api/public/reservations':['POST'],
  };
  const methods = allowed[url.pathname] || (/^\/api\/public\/reservations\/reservation-[a-f0-9-]{36}$/.test(url.pathname)?['GET','DELETE']:[]);
  if (!methods.includes(request.method)) return error(404, 'ROUTE_NOT_FOUND');
  const origin = request.headers.get('origin');
  if ((origin && origin !== url.origin) || (request.method !== 'GET' && origin !== url.origin)) return error(403,'ORIGIN_REJECTED');
  if (request.headers.get('sec-fetch-site') === 'cross-site') return error(403,'ORIGIN_REJECTED');
  const outgoing = new Headers({accept:'application/json'});
  for (const name of ['idempotency-key','x-mbox-guest-device']) {
    const value = request.headers.get(name);
    if (value && value.length <= 512) outgoing.set(name,value);
  }
  // Only this customer's opaque reservation cookie crosses to the booking service.
  const cookie = request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>/^mbox_reservation_session=[A-Za-z0-9_-]+$/.test(v));
  if (cookie) outgoing.set('cookie',cookie);
  let body;
  if (request.method === 'POST') {
    if (!request.headers.get('content-type')?.startsWith('application/json')) return error(415,'JSON_REQUIRED');
    if (Number(request.headers.get('content-length')) > 16384) return error(413,'REQUEST_TOO_LARGE');
    const reader=request.body?.getReader();const chunks=[];let size=0;
    if(reader) for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16384){await reader.cancel();return error(413,'REQUEST_TOO_LARGE');}chunks.push(part.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    body=new TextDecoder().decode(bytes);
    try { JSON.parse(body); } catch { return error(400,'JSON_REQUIRED'); }
    outgoing.set('content-type','application/json');
  }
  const upstream = new URL(url.pathname,ORIGIN);
  for (const key of ['arrivalAt','guestCount','expectedEndAt','date']) if(url.searchParams.has(key)) upstream.searchParams.set(key,url.searchParams.get(key));
  try {
    const response = await send(upstream,{method:request.method,headers:outgoing,body,redirect:'manual',signal:AbortSignal.timeout(12000)});
    if (!response.headers.get('content-type')?.includes('application/json')) return error(502,'BOOKING_SERVICE_UNAVAILABLE');
    const resultHeaders = new Headers(headers);
    const sessionCookie=response.headers.get('set-cookie');
    if(sessionCookie?.startsWith('mbox_reservation_session=')) resultHeaders.set('set-cookie',sessionCookie);
    if(response.headers.has('retry-after')) resultHeaders.set('retry-after',response.headers.get('retry-after'));
    return new Response(response.body,{status:response.status,headers:resultHeaders});
  } catch { return error(502,'BOOKING_SERVICE_UNAVAILABLE'); }
}
