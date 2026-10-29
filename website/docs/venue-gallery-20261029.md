# 宣传照片与座位图发布 — 2026-10-29

## 交付

- 正式入口：https://www.shmbox.com/zh/#space；座位图：https://www.shmbox.com/zh/#seating。
- zh/en/ru/ja/ko/fr/de 七语首页新增独立空间展示：三张夜间氛围优化照片、完整座位图及现有预约入口。
- 选用门店实拍基础上的最终 v3：01 舞台全景、04 品牌绿与金色细节、06 舒适卡座与吧台。沿用已经制作的图片，本次只转 WebP 压缩，未继续修改场景。三张合计 510,378 字节。
- 用户提供的 941×1672 座位图保留原 PNG，另提供 WebP 展示版；点击可查看原图。
- 七语均标明照片经 AI 氛围优化，细节可能不同；座位图为布局参考，不代表实时空位。未推断容量、价格、桌位可订或室外必定开放。
- `build_venue.py` 只增强七个首页，重复执行结果一致；`build.py` 已接入生成步骤。独立 `venue.css` 不影响其他页面样式。

## 验证与发布

- 网站测试 44/44；运行层测试 11/11，本地与新服务器容器均通过。
- 七语 390px 手机布局均无水平溢出；中文桌面展示与布局原图加载通过。点击新预约按钮进入现有表单，备注字段存在；未提交测试预约。
- 发布来自现网 v21 的完整副本，补丁仅 7 个运行文件：`data/pages.json`、独立 CSS 和 5 个图片文件。其中 JSON 只改变七个首页值，其他 7 个菜单页面值不变。
- 542 个其他已有运行文件逐字节一致，包括全部预约页、预约脚本、gateway、server 和菜单/排期运行逻辑。
- 新版 `mbox-public-site-www-v22`，路径 `/opt/mbox-public-site/releases/20261029-venue-v22`，loopback 8813；容器健康。
- Caddy 仅将原公开站 upstream `mbox-public-site-www-v21a:8080` 替换为 v22 并平滑重载；旧容器及 `/opt/mbox-public-site/venue-v22/Caddyfile.before` 保留，失败回读自动回退。
- 员工后台镜像、启动时间、健康状态前后相同；readiness 中 status、schemaVersion、commitSha、releaseImageDigest、runtimeRole、writeEnabled 全部一致。readiness 完整 JSON 含动态字段，不以全文相等作为验收条件。
- 20 个匿名公网 URL 回读通过：7 首页、7 预约页、CSS、5 图片。预约页与发布前字节一致，全部新静态文件哈希与本地一致。
- 不涉及数据库、预约数据、员工后台部署、小程序发布，也不代表新的搜索索引或 AI 引用。

## 证据

本机 `outputs/website-content-20261013/venue-gallery-20261029/`：`baseline.json`、`manifest.json`、`local-verification.json`、`website-tests.txt`、`runtime-tests.txt`、`browser-mobile-checks.json`、`prepare-result.txt`、`activate-result.txt`、`health-result.txt`、`public-verification.json`、`live-seating-desktop.png`。

## 用户文案修订（2026-10-29，v23）

用户要求去掉“AI优化”等说明，作为正式对外宣传。七语首页已移除新照片的制作过程说明和座位图的免责式段落；首屏与外景图改为简洁品牌图注（中文分别为“把下一次相聚，约在歌声里。”“上海的夜，留给相聚。”），首页页脚去掉同类说明。保留预约备注偏好、工作人员联系确认等实用信息，未添加“未经处理实拍”等真实性承诺。上文 v22 为历史发布记录。

v23 只改 data/pages.json 的七个首页值，图片不变；548 个其他现有运行文件保持一致，预约和后台不变。44 网站测试及 11 新容器运行测试通过；七语首页公网逐段匹配新文案，七个预约页与发布前相同。沿用独立公开站发布方式，只将 www 代理 upstream 从 v22 切到 v23（loopback 8814）；旧版保留可回退。员工后台镜像、启动时间、健康状态与 readiness 关键字段保持一致。

证据：`outputs/website-content-20261013/venue-copy-20261029/` 中 manifest.json、baseline.json、tests.txt、prepare-result.txt、activate-result.txt、public-checks.json。
