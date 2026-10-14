# MBOX 正式域名修复与收录结果

时间：2026-10-14 13:19 CST。正式宣传域名：https://www.shmbox.com 。

## 公网连接故障

初期仅凭8次独立路径成功而归因本机TUN是不充分的；随后独立路径也复现，已撤回这一判断。源站抓包看到相同公网NAT来源的SYN重复到达但服务器不发SYNACK，而换TCP时间戳的连接成功。服务器内核3.10，`tcp_tw_recycle=1`、`tcp_timestamps=1`，PAWSPassive=17151。

仅将 `net.ipv4.tcp_tw_recycle` 改为0，保留 timestamps/reuse，未重启主机或业务容器；同步修正/etc/sysctl.conf（99-sysctl.conf为其软链）并新增单项持久配置，原配置已备份。此参数属于主机共享网络设置，会作用于所有新连接，但不改预约与员工业务逻辑。阿里云说明：https://www.alibabacloud.com/help/tc/ecs/support/common-kernel-network-parameters-of-ecs-linux-instances-and-faq 。

修后本机默认路径20/20 HTTP200、证书验证通过；独立审查另测默认10/10、独立通道10/10、源站5/5通过，PAWSPassive与ListenDrops不再增加。支持本轮主要故障为旧参数与NAT/逐连接时间戳的冲突，不等于全球所有网络永久可达。

## 域名、内容与预约

- Sites v14，源码69fe1fcb614e58b260463db0dc43e639279e0521，部署appgdep_6acf0e4782f48191a5fbe4f13d514e23。
- 旧预览站根、七语主页、菜单、sitemap精确308到www；丢弃查询参数，不转发身份数据。POST/DELETE、未知路径、员工域名不重定向。
- 原七语reserve页保留同源查询、JS、API和原浏览器凭证，noindex并添加迁移提示。www七语预约页有返回旧站查原预约的链接。
- www此前遗漏动态菜单接口（404）且静态内容落后，本次恢复SSR及API；七语菜单均187款，菜单失败不伪装成功。
- 阿里云独立容器mbox-public-site-www-v14、目录/opt/mbox-public-site/releases/20261014-www-canonical-v14，Caddy仅更换www上游，不更改mbox.shmbox.com业务路由。
- 原宣传容器保留；Caddy备份/opt/mbox-public-site/Caddyfile.before-www-v14。
- 业务mbox-app镜像ID9b854bc…、StartedAt 2026-10-13T17:58:18.380129469Z保持不变；ready rc256/c78ebfd/schema265/worker healthy。没有创建、取消或清理任何真实预约。
- 本地旧站路由/菜单/预约恢复21测试通过；阿里云runtime9测试通过，服务器候选及可复现包各通过9测试。独立复审验证匿名私有预约读取仍401。未冒充本轮进行了真实顾客下单或员工人工接单。

## 收录：分别记录状态

- Bing Sitemap **Success**，已发现22网址，无错误/警告；这不是22页全部已收录。
- Bing中文首页 **Indexing requested**，尚未看到实际索引结果。
- IndexNow更新后15个公开首页/菜单URL提交HTTP **200**；不含预约记录/API。此前202已被本次成功回执更新。
- Google在网络参数修复后再次HTML验证仍提示连接超时；本机/源站验证文件200，但日志未发现本次Google验证请求。尚不能确认其外部连接/解析问题，未完成Google验证与sitemap提交，不宣称收录。
- 百度站长入口本轮浏览器导航再次超时，未取得提交回执。
- 既有北京时间16:00复查保留，重点检查Google验证及Bing索引变化。不保证AI推荐或引用。

证据：after-tcp-fix-20.json、final-pages.json、tcp-fix.txt、tcp-persistence.txt、cutover-result.txt、runtime-tests.txt、bing-success-22.png、bing-index-requested.png、indexnow-status.txt。初期失败采样仍保留，不能引用为修后结果。
