# M-BOX 七语网站与预约

七语首页、菜单和独立预约页；菜单从公开后端同步；2026-10-14验收快照为187项，并非固定数量。7款商品已有核实译名，其他商品保留原名。宣传页面允许搜索和 AI 爬虫抓取，提供七语 sitemap.xml；平台访问模式本次改为 public。预约接口继续保留访客会话校验、no-store 与 noindex，不公开客户数据。公开不保证收录或推荐。后端 rc256 和网站 v13 已部署，员工现场接单与提醒效果仍需独立验收。

## 构建与检查

```sh
npm run install:ci
python3 build.py
./node_modules/.bin/esbuild reservation/booking.ts --bundle --minify --format=esm --target=es2022 --outfile=public/booking.js
node --test tests/*.test.mjs
npm run build
npm start -- --port 4187
```

Vinext / Cloudflare Worker：`public/`为页面与媒体源，`lib/mbox/gateway.js`为仅允许公开预约路由的同源代理。预约使用现有 `https://mbox.shmbox.com` 后台，无员工凭据。会话 Cookie 隔离，跨来源写入拒绝；不透传工作人员 Cookie 或 Authorization。

## 预约

首页、顶部及手机浮动按钮进入 `/语言/reserve/`，流程参照小程序：时间人数 → 演出位置 → 确认提交。读取实时余量、演出与费用规则；提交后显示预约编号和状态，待确认不表示已有座位。持久化同一请求编号和幂等键，网络未知结果先查询，避免重复建单。自助取消遵守服务端 `canCancelSelf`。

包场独立电话沟通，不冒充普通座位预约。后台员工全量列表的权限要求为 `reservation.view.all`；具体员工账号可见性、联系方式解密展示和通知送达仍须独立验收，不能用顾客回执替代。

## 语言与素材

明确语言链接不强制跳转。首次根路径访问采用手动偏好 → 支持的浏览器语言 → IP所属国家提示 → 英文；中国境内的外语游客保留其浏览器语言。没有第三方IP查询，不返回原始IP。

用户提供 `8.mp4` 已替换演出视频，截取8秒画面作封面。外景根据用户实拍，经许可改变人物、灯光与景观以表现氛围；七种语言均标明艺术演绎，不承诺真实座位、布置或景观。详见 `ASSET-PROVENANCE-v5.md`。

邮箱待店方提供。品牌历史1999为品牌起点报道口径，非陆家嘴店开业年；演出片段不代表当日阵容。公开上线前仍需门店信息确认、母语审校及员工接单闭环验收。

## Search discovery maintenance

- Keep the Google/Bing verification files and `data/search-indexing.json` with the Site source. They establish this site's search-console ownership and IndexNow scope; do not replace them on routine builds.
- After publishing changed public URLs, run `python3 scripts/submit-indexnow.py --report /absolute/path/indexnow-result.json`. It verifies the deployed key and uses only public URLs from the deployed sitemap. A 200/202 is receipt, not proof of indexing.
- Google Search Console uses this exact HTTPS URL-prefix property and `/sitemap.xml`. Request key-page indexing there; do not use the Google job/broadcast Indexing API for this venue site.
- Search inclusion and AI citations remain search-engine decisions. No fabricated ratings, review counts, opening hours, event dates, or external identity links are added.

## GitHub 源码副本

本目录导入当前线上 v13 的源码提交 `d40ce60b36e005d65f6dcc09115331a104f63e62`，位于 `jingda2008/mbox-ops-platform` 的 `feat/mbox-public-website-20261014` 分支。保留完整源码、锁文件、七语内容、测试和公开图片/视频；未复制依赖、构建产物、环境变量或本机开发锁文件。`SOURCE-SNAPSHOT.json` 记录来源及文件校验值。README和忽略规则是副本的交接补充，业务源码保持一致。

从仓库根目录先 `cd website`。需要 Node >=22.13 和 Python 3。上述构建命令不依赖本机 Codex 插件路径；`npm start -- --port 4187` 使用本地 Worker。

生产运行环境需要设置 `WEBSITE_MENU_SYNC_ENABLED=true` 才启用动态菜单；本地可在未跟踪的 `.dev.vars` 中设置。接口为 `https://mbox.shmbox.com/api/public/website/menu`，不需要私密凭据。缺失开关使用有日期标记的资料模式，不能将该默认值直接用于替换已启用同步的生产站点。服务端缓存与浏览器轮询可能累计接近10分钟。

`.openai/hosting.json` 保留既有 Sites 项目身份，不是登录凭据。搜索引擎验证文件及 IndexNow key 均为站点本已公开的所有权验证素材。GitHub 分支不会自动部署；本次仅上传源码，不改变线上版本、域名或员工后台。迁移域名时须同步更改 canonical、hreflang、sitemap、搜索控制台及源站限制，不能直接复制静态资源替代 Worker。
