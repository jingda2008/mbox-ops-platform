import type { FastifyPluginAsync } from 'fastify';
export interface WechatServiceAccountSubscribeConfig {
  appId:string
  appSecret:string
  activityTemplateId:string
  couponTemplateId:string
  codeTemplateId:string
  miniProgramAppId:string
  publicOrigin:string
  stateSecret:string
}
interface Options {config:WechatServiceAccountSubscribeConfig; now?:()=>number; fetchImpl?:typeof fetch}
type Payload={access_token?:string; expires_in?:number; ticket?:string; openid?:string; errcode?:number; errmsg?:string; error?:{message?:string}};
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token';
const TICKET_URL = 'https://api.weixin.qq.com/cgi-bin/ticket/getticket';
const OAUTH_TOKEN_URL = 'https://api.weixin.qq.com/sns/oauth2/access_token';
const BIZSEND_URL = 'https://api.weixin.qq.com/cgi-bin/message/subscribe/bizsend';
export const wechatServiceAccountSubscribePlugin: FastifyPluginAsync<Options> = async (app, options)=>{
    const config = options.config;
    assertConfig(config);
    app.addHook('onSend',async(_request,reply,payload)=>{reply.header('Cache-Control','no-store');return payload});
    const now = options.now ?? Date.now;
    const fetchImpl = options.fetchImpl ?? fetch;
    const tokens = new TokenHelper(config, fetchImpl, now);
    app.get<{Querystring: Record<string,unknown>}>('/wechat/service-account/subscribe', async (request, reply)=>{
        const query = request.query;
        const code = asString(query.code);
        const state = asString(query.state);
        if (code === null) {
            const nextState = signState(config.stateSecret, `subscribe:${now()}`);
            const redirectUri = encodeURIComponent(`${config.publicOrigin}/api/wechat/service-account/subscribe`);
            const oauth = `https://open.weixin.qq.com/connect/oauth2/authorize` + `?appid=${encodeURIComponent(config.appId)}` + `&redirect_uri=${redirectUri}` + `&response_type=code&scope=snsapi_base` + `&state=${encodeURIComponent(nextState)}#wechat_redirect`;
            return reply.redirect(oauth);
        }
        if (state === null || !verifyOAuthState(config.stateSecret, state,now())) {
            return reply.code(403).type('text/html; charset=utf-8').send(errorPage('授权状态无效，请从服务号菜单重新进入。'));
        }
        let openId;
        try {
            openId = await exchangeOpenId(config, code, fetchImpl);
        } catch  {
            return reply.code(502).type('text/html; charset=utf-8').send(errorPage('微信授权失败，请返回服务号菜单重试。'));
        }
        const openIdToken = signOpenId(config.stateSecret, openId, now());
        return reply.type('text/html; charset=utf-8').send(subscribePage({
            appId: config.appId,
            activityTemplateId: config.activityTemplateId,
            couponTemplateId: config.couponTemplateId,
            codeTemplateId: config.codeTemplateId,
            openIdToken,
            configUrl: `${config.publicOrigin}/api/wechat/service-account/subscribe/jssdk-config`,
            sendUrl: `${config.publicOrigin}/api/wechat/service-account/subscribe/send-test`
        }));
    });
    app.get<{Querystring: Record<string,unknown>}>('/wechat/service-account/subscribe/result', async (request, reply)=>{
        const query = request.query;
        const action = asString(query.action);
        const templateId = asString(query.template_id);
        const openId = asString(query.openid);
        const reserved = asString(query.reserved);
        if (action !== 'confirm' || templateId === null || openId === null) {
            return reply.type('text/html; charset=utf-8').send(errorPage('未完成授权，请返回服务号菜单重试。'));
        }
        let sessionOpenId:string;
        try {
            if(reserved===null)throw new Error('Missing signed identity');
            sessionOpenId=verifyOpenIdToken(config.stateSecret,reserved,now());
            if(sessionOpenId!==openId)throw new Error('Identity mismatch');
        }catch { return reply.code(403).type('text/html; charset=utf-8').send(errorPage('授权身份无效，请重新进入页面。')); }
        const sends = [];
        try {
            const accessToken = await tokens.accessToken();
            if (isConfiguredTemplate(config, templateId)) {
                try {
                    await bizSend(fetchImpl, accessToken, buildBizSendBody(config, sessionOpenId, templateId, now()));
                    sends.push({ templateId, ok: true });
                } catch (error) {
                    sends.push({
                        templateId,
                        ok: false,
                        error: error instanceof Error ? error.message : 'send failed'
                    });
                }
            }
        } catch (error) {
            return reply.type('text/html; charset=utf-8').send(errorPage(error instanceof Error ? error.message : '发送失败，请稍后重试'));
        }
        const ok = sends.some((item)=>item.ok);
        const message = ok ? '授权成功，测试通知已发送，请返回微信查看。' : `授权已记录，但发送失败：${sends[0]?.error ?? '未知错误'}`;
        return reply.type('text/html; charset=utf-8').send(errorPage(message));
    });
    app.get<{Querystring: Record<string,unknown>}>('/wechat/service-account/subscribe/jssdk-config', async (request, reply)=>{
        const query = request.query;
        const pageUrl = asString(query.url);
        if (pageUrl === null || !isSubscribePageUrl(pageUrl,config.publicOrigin)) {
            return reply.code(400).send({
                error: {
                    code: 'INVALID_URL',
                    message: '页面地址无效'
                }
            });
        }
        try {
            const ticket = await tokens.jsapiTicket();
            const timestamp = String(Math.floor(now() / 1000));
            const nonceStr = randomBytes(8).toString('hex');
            const signature = createHash('sha1').update(`jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${pageUrl}`).digest('hex');
            return {
                appId: config.appId,
                timestamp,
                nonceStr,
                signature,
                jsApiList: ['checkJsApi'],
                openTagList: [
                    'wx-open-subscribe'
                ]
            };
        } catch (error) {
            return reply.code(502).send({
                error: {
                    code: 'JSSDK_CONFIG_FAILED',
                    message: error instanceof Error ? error.message : 'JS-SDK 配置失败'
                }
            });
        }
    });
    app.post<{Body: Record<string,unknown>}>('/wechat/service-account/subscribe/send-test', async (request, reply)=>{
        const body = request.body ?? {};
        const openIdToken = asString(body.openIdToken);
        const accepted = Array.isArray(body.acceptedTemplateIds) ? body.acceptedTemplateIds.filter((item)=>typeof item === 'string') : [];
        if (openIdToken === null) {
            return reply.code(400).send({
                error: {
                    code: 'OPENID_REQUIRED',
                    message: '缺少授权身份'
                }
            });
        }
        let openId;
        try {
            openId = verifyOpenIdToken(config.stateSecret, openIdToken, now());
        } catch  {
            return reply.code(403).send({
                error: {
                    code: 'OPENID_INVALID',
                    message: '授权已过期，请重新进入页面'
                }
            });
        }
        const sends = [];
        const accessToken = await tokens.accessToken();
        for (const templateId of accepted){
            if (!isConfiguredTemplate(config, templateId)) continue;
            try {
                await bizSend(fetchImpl, accessToken, buildBizSendBody(config, openId, templateId, now()));
                sends.push({
                    templateId,
                    ok: true
                });
            } catch (error) {
                sends.push({
                    templateId,
                    ok: false,
                    error: error instanceof Error ? error.message : 'send failed'
                });
            }
        }
        return {
            openIdBound: true,
            sends
        };
    });
};
class TokenHelper {
    config:WechatServiceAccountSubscribeConfig;
    fetchImpl:typeof fetch;
    now:()=>number;
    access: {accessToken:string;expiresAtMs:number}|null = null;
    ticket: {ticket:string;expiresAtMs:number}|null = null;
    constructor(config:WechatServiceAccountSubscribeConfig, fetchImpl:typeof fetch, now:()=>number){
        this.config = config;
        this.fetchImpl = fetchImpl;
        this.now = now;
    }
    async accessToken() {
        if (this.access && this.access.expiresAtMs > this.now() + 60_000) return this.access.accessToken;
        const url = `${TOKEN_URL}?grant_type=client_credential` + `&appid=${encodeURIComponent(this.config.appId)}` + `&secret=${encodeURIComponent(this.config.appSecret)}`;
        const response = await this.fetchImpl(url,{signal:AbortSignal.timeout(8000)});
        const payload = await response.json() as Payload;
        if (!payload.access_token || !payload.expires_in) {
            throw new Error(payload.errmsg ?? 'access_token missing');
        }
        this.access = {
            accessToken: payload.access_token,
            expiresAtMs: this.now() + payload.expires_in * 1000
        };
        return payload.access_token;
    }
    async jsapiTicket() {
        if (this.ticket && this.ticket.expiresAtMs > this.now() + 60_000) return this.ticket.ticket;
        const accessToken = await this.accessToken();
        const url = `${TICKET_URL}?access_token=${encodeURIComponent(accessToken)}&type=jsapi`;
        const response = await this.fetchImpl(url,{signal:AbortSignal.timeout(8000)});
        const payload = await response.json() as Payload;
        if (!payload.ticket || !payload.expires_in) {
            throw new Error(payload.errmsg ?? 'jsapi_ticket missing');
        }
        this.ticket = {
            ticket: payload.ticket,
            expiresAtMs: this.now() + payload.expires_in * 1000
        };
        return payload.ticket;
    }
}
async function exchangeOpenId(config:WechatServiceAccountSubscribeConfig, code:string, fetchImpl:typeof fetch) {
    const url = `${OAUTH_TOKEN_URL}?appid=${encodeURIComponent(config.appId)}` + `&secret=${encodeURIComponent(config.appSecret)}` + `&code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    const response = await fetchImpl(url,{signal:AbortSignal.timeout(8000)});
    const payload = await response.json() as Payload;
    if (!payload.openid) throw new Error(payload.errmsg ?? 'openid missing');
    return payload.openid;
}
async function bizSend(fetchImpl:typeof fetch, accessToken:string, body:Record<string,unknown>) {
    const response = await fetchImpl(`${BIZSEND_URL}?access_token=${encodeURIComponent(accessToken)}`, {
        method: 'POST',
        signal:AbortSignal.timeout(8000),
        headers: {
            'content-type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    const payload = await response.json() as Payload;
    if ((payload.errcode ?? 0) !== 0) {
        throw new Error(`${payload.errcode ?? 'unknown'}:${payload.errmsg ?? 'bizsend failed'}`);
    }
}
function isConfiguredTemplate(config:WechatServiceAccountSubscribeConfig, templateId:string) {
    return templateId === config.activityTemplateId
        || templateId === config.couponTemplateId
        || templateId === config.codeTemplateId;
}
function buildBizSendBody(config:WechatServiceAccountSubscribeConfig, openId:string, templateId:string, nowMs:number) {
    if (templateId === config.couponTemplateId) {
        return {
            touser: openId,
            template_id: templateId,
            page: 'pages/profile-coupons/index',
            miniprogram_state: 'formal',
            lang: 'zh_CN',
            data: {
                thing1: { value: '欢迎饮品兑换凭证' },
                time2: { value: formatWechatTime(nowMs + 14 * 24 * 3600_000) },
                thing3: { value: '到店出示会员码核销' },
                thing4: { value: '欢迎饮品兑换凭证' },
            },
        };
    }
    if (templateId === config.codeTemplateId) {
        return {
            touser: openId,
            template_id: templateId,
            page: 'pages/profile/index',
            miniprogram_state: 'formal',
            lang: 'zh_CN',
            data: {
                number1: { value: '482916' },
                thing3: { value: '5分钟' },
                thing2: { value: '寄存取走' },
            },
        };
    }
    return {
        touser: openId,
        template_id: templateId,
        page: 'pages/community/index',
        miniprogram_state: 'formal',
        lang: 'zh_CN',
        data: {
            thing1: { value: '超嗨M-BOX陆家嘴店' },
            thing2: { value: '周五现场驻唱' },
            time3: { value: formatWechatTime(nowMs + 2 * 3600_000) },
            thing4: { value: '请提前到店入座' },
        },
    };
}
function assertConfig(config:WechatServiceAccountSubscribeConfig) {
    if (!/^wx[A-Za-z0-9_-]{4,126}$/.test(config.appId)) throw new TypeError('service account appId invalid');
    if (config.appSecret.length < 16) throw new TypeError('service account appSecret invalid');
    if (config.activityTemplateId.length < 8) throw new TypeError('activity template invalid');
    if (config.couponTemplateId.length < 8) throw new TypeError('coupon template invalid');
    if (config.codeTemplateId.length < 8) throw new TypeError('code template invalid');
    if (!/^wx[A-Za-z0-9_-]{4,126}$/.test(config.miniProgramAppId)) throw new TypeError('mini program appId invalid');
    if (!/^https:\/\/[A-Za-z0-9.-]+/.test(config.publicOrigin)) throw new TypeError('publicOrigin invalid');
    if (config.stateSecret.length < 16) throw new TypeError('stateSecret invalid');
}
function asString(value:unknown) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
function signState(secret:string, payload:string) {
    const body = Buffer.from(payload, 'utf8').toString('base64url');
    const signature = createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${signature}`;
}
function verifyState(secret:string, state:string) {
    const parts = state.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
    const expected = createHmac('sha256', secret).update(parts[0]).digest('base64url');
    const left = Buffer.from(parts[1], 'utf8');
    const right = Buffer.from(expected, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
}
function signOpenId(secret:string, openId:string, nowMs:number) {
    return signState(secret, `openid:${openId}:${nowMs}`);
}
function verifyOpenIdToken(secret:string, token:string, nowMs:number) {
    if (!verifyState(secret, token)) throw new Error('invalid');
    const body = Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8');
    const match = /^openid:(wx[A-Za-z0-9_-]+):(\d+)$/.exec(body) ?? /^openid:([A-Za-z0-9_-]{10,64}):(\d+)$/.exec(body);
    if (!match) throw new Error('invalid payload');
    const createdAt = Number(match[2]);
    if (!Number.isSafeInteger(createdAt) || Math.abs(nowMs - createdAt) > 30 * 60_000) {
        throw new Error('expired');
    }
    return match[1]!;
}
function formatWechatTime(ms:number) {
    const date = new Date(ms);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${y}年${m}月${d}日 ${hh}:${mm}`;
}
function errorPage(message:string) {
    return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>订阅提醒</title></head><body style="font-family:sans-serif;padding:24px;color:#222">
<h1 style="font-size:20px">订阅提醒</h1><p>${escapeHtml(message)}</p></body></html>`;
}
function subscribePage(input:{
  appId:string
  activityTemplateId:string
  couponTemplateId:string
  codeTemplateId:string
  openIdToken:string
  configUrl:string
  sendUrl:string
}) {
  const clientScript = [
    'const openIdToken = ' + JSON.stringify(input.openIdToken) + ';',
    'const sendUrl = ' + JSON.stringify(input.sendUrl) + ';',
    'const configUrl = ' + JSON.stringify(input.configUrl) + ';',
    'const activityTemplateId = ' + JSON.stringify(input.activityTemplateId) + ';',
    'const couponTemplateId = ' + JSON.stringify(input.couponTemplateId) + ';',
    'const codeTemplateId = ' + JSON.stringify(input.codeTemplateId) + ';',
    'const expectedAppId = ' + JSON.stringify(input.appId) + ';',
    'const status = document.getElementById("status");',
    'const actions = document.getElementById("actions");',
    'const NL = String.fromCharCode(10);',
    'let openTagError = "";',
    'let settled = false;',
    'function setStatus(text){ status.textContent = text; }',
    'document.addEventListener("WeixinOpenTagsError", function(event){',
    '  const detail = (event && event.detail) || {};',
    '  openTagError = detail.errMsg || JSON.stringify(detail) || "WeixinOpenTagsError";',
    '  failHelp("开放标签错误：" + openTagError);',
    '});',
    'function parseAccepted(detail){',
    '  const raw = (detail && detail.subscribeDetails) || "{}";',
    '  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;',
    '  return Object.keys(parsed).filter(function(id){',
    '    const item = parsed[id];',
    '    const statusText = typeof item === "string" ? (JSON.parse(item).status || "") : (item && item.status);',
    '    return statusText === "accept";',
    '  });',
    '}',
    'async function sendAccepted(accepted){',
    '  if(accepted.length === 0){ setStatus("未选择允许，授权未完成"); return; }',
    '  setStatus("授权成功，正在发送测试通知...");',
    '  const sendResponse = await fetch(sendUrl, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ openIdToken: openIdToken, acceptedTemplateIds: accepted }) });',
    '  const result = await sendResponse.json();',
    '  if(!sendResponse.ok){ throw new Error((result.error && result.error.message) || "发送失败"); }',
    '  const okCount = (result.sends || []).filter(function(item){ return item.ok; }).length;',
    '  const fail = (result.sends || []).filter(function(item){ return !item.ok; });',
    '  if(okCount > 0 && fail.length === 0){ setStatus("已发送 " + okCount + " 条测试通知，请返回微信查看"); }',
    '  else if(okCount > 0){ setStatus("部分发送成功：" + fail.map(function(item){ return item.error; }).join("；")); }',
    '  else { setStatus("发送失败：" + (fail[0] && fail[0].error || "未知错误")); }',
    '}',
    'function bindSubscribe(id){',
    '  const button = document.getElementById(id);',
    '  if(!button) return;',
    '  button.addEventListener("success", async function(event){',
    '    try { await sendAccepted(parseAccepted((event && event.detail) || {})); }',
    '    catch(error){ setStatus(error && error.message ? error.message : "处理失败"); }',
    '  });',
    '  button.addEventListener("error", function(event){',
    '    const detail = (event && event.detail) || {};',
    '    setStatus("授权组件失败：" + (detail.errMsg || detail.errCode || "未知错误"));',
    '  });',
    '}',
    'function buildTag(id, templateId, label){',
    '  const host = document.createElement("wx-open-subscribe");',
    '  host.setAttribute("template", templateId);',
    '  host.setAttribute("id", id);',
    '  const styleScript = document.createElement("script");',
    '  styleScript.type = "text/wxtag-template";',
    '  styleScript.setAttribute("slot", "style");',
    '  styleScript.text = "<style>.subscribe-btn{display:block;width:100%;box-sizing:border-box;border:0;border-radius:999px;padding:14px 18px;background:#07c160;color:#fff;font-size:16px;text-align:center}</style>";',
    '  const bodyScript = document.createElement("script");',
    '  bodyScript.type = "text/wxtag-template";',
    '  bodyScript.text = "<button class=\\"subscribe-btn\\">" + label + "</button>";',
    '  host.appendChild(styleScript);',
    '  host.appendChild(bodyScript);',
    '  return host;',
    '}',
    'function mountButtons(){',
    '  actions.innerHTML = "";',
    '  actions.appendChild(buildTag("subscribe-activity", activityTemplateId, "订阅活动通知"));',
    '  actions.appendChild(buildTag("subscribe-coupon", couponTemplateId, "订阅优惠通知"));',
    '  actions.appendChild(buildTag("subscribe-code", codeTemplateId, "订阅取酒验证码"));',
    '  bindSubscribe("subscribe-activity");',
    '  bindSubscribe("subscribe-coupon");',
    '  bindSubscribe("subscribe-code");',
    '}',
    'function diagnoseButtons(){',
    '  const nodes = document.querySelectorAll("wx-open-subscribe");',
    '  let iframeCount = 0;',
    '  for(let i = 0; i < nodes.length; i += 1){ iframeCount += nodes[i].querySelectorAll("iframe").length; }',
    '  return { count: nodes.length, iframeCount: iframeCount };',
    '}',
    'function failHelp(extra){',
    '  settled = true;',
    '  setStatus([extra, "开放标签未生效（需服务号 JS 安全域名）。", "请登录【服务号】超嗨Mbox（AppID " + expectedAppId + "）→ 设置与开发 → 公众号设置 → 功能设置 → JS接口安全域名，填写 mbox.shmbox.com。", "校验文件：https://mbox.shmbox.com/MP_verify_5OK1MZLXrbfZkIkh.txt", "注意：公众号校验文件不能替代服务号。", openTagError ? ("错误：" + openTagError) : ""].filter(Boolean).join(NL));',
    '}',
    'setTimeout(function(){ if(!settled){ const info = diagnoseButtons(); if(info.iframeCount === 0) failHelp("当前检测：组件" + info.count + "个，iframe " + info.iframeCount + "个。"); } }, 2500);',
    'async function boot(){',
    '  try{',
    '    setStatus("正在检查微信环境...");',
    '    if(typeof wx === "undefined"){ failHelp("微信 JS 未加载。"); return; }',
    '    setStatus("正在获取签名配置...");',
    '    const pageUrl = location.href.split("#")[0];',
    '    const controller = new AbortController();',
    '    const timer = setTimeout(function(){ controller.abort(); }, 8000);',
    '    const response = await fetch(configUrl + "?url=" + encodeURIComponent(pageUrl), { signal: controller.signal });',
    '    clearTimeout(timer);',
    '    const config = await response.json();',
    '    if(!response.ok){ throw new Error((config.error && config.error.message) || "配置失败"); }',
    '    setStatus("正在注入微信配置...");',
    '    wx.config({ debug:false, appId:config.appId, timestamp:config.timestamp, nonceStr:config.nonceStr, signature:config.signature, jsApiList:["checkJsApi"], openTagList:["wx-open-subscribe"] });',
    '    wx.ready(function(){',
    '      mountButtons();',
    '      setTimeout(function(){',
    '        const info = diagnoseButtons();',
    '        if(info.iframeCount > 0){ settled = true; setStatus("请点击绿色按钮完成授权"); }',
    '        else { failHelp("config 成功但按钮未渲染。当前检测：组件" + info.count + "个，iframe " + info.iframeCount + "个。"); }',
    '      }, 600);',
    '    });',
    '    wx.error(function(error){ failHelp("微信配置失败：" + (error && error.errMsg ? error.errMsg : "未知错误")); });',
    '  }catch(error){ failHelp(error && error.message ? error.message : "初始化失败"); }',
    '}',
    'boot();',
  ].join(String.fromCharCode(10))

  return [
    '<!doctype html>',
    '<html><head>',
    '<meta charset="utf-8"/>',
    '<meta name="viewport" content="width=device-width,initial-scale=1"/>',
    '<title>订阅活动、优惠与取酒验证码</title>',
    '<script src="https://res.wx.qq.com/open/js/jweixin-1.6.0.js"></script>',
    '<style>',
    'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1a14;color:#f4f7f3}',
    '.wrap{max-width:420px;margin:0 auto;padding:28px 20px 48px}',
    'h1{font-size:24px;margin:0 0 8px}',
    'p{line-height:1.6;color:#c9d5cc}',
    '.card{margin-top:20px;padding:16px;border:1px solid #2c4638;border-radius:14px;background:#16251d}',
    '.status{margin-top:16px;min-height:24px;color:#9ad7b3;white-space:pre-wrap}',
    '.hint{font-size:13px;color:#8ea397}',
    '.actions{margin-top:16px}',
    'wx-open-subscribe{display:block;width:100%;margin-top:12px;min-height:48px}',
    '</style></head><body>',
    '<div class="wrap">',
    '<h1>订阅提醒</h1>',
    '<p>开启后可接收活动开始、优惠到账与取酒验证码通知。每次授权可发送一次，可随时再次订阅。</p>',
    '<div class="card">',
    '<div class="hint">请点击下方绿色按钮，在微信弹窗中选择允许。三个都点一次即可各收一条测试通知。取酒前请先点「订阅取酒验证码」。</div>',
    '<div class="actions" id="actions"></div>',
    '<div class="status" id="status">正在准备授权组件...</div>',
    '</div></div>',
    '<script>',
    clientScript,
    '</script></body></html>',
  ].join('')
}

function escapeHtml(value:string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function isSubscribePageUrl(value:string,origin:string):boolean {try{const u=new URL(value);return u.origin===origin&&!u.username&&!u.password&&u.pathname==='/api/wechat/service-account/subscribe'}catch{return false}}
function verifyOAuthState(secret:string,state:string,now:number):boolean{if(!verifyState(secret,state))return false;const match=/^subscribe:(\d+)$/.exec(Buffer.from(state.split('.')[0]!, 'base64url').toString());if(!match)return false;const timestamp=Number(match[1]);return Number.isSafeInteger(timestamp)&&timestamp<=now&&now-timestamp<=10*60_000}
