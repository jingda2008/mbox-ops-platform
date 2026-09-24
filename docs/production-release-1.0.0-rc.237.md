# rc.237 桌台名单与旧桌码兼容正式发布

2026-09-25 03:18:13 CST标准发布完成切换，公网HTTP与浏览器复验通过；03:19:28 CST完成独立审计桌号事务，03:19:29读回通过。生产ready、writeEnabled=true，schema248，无新增迁移。

| 项目 | 已验证结果 |
|---|---|
| 发布提交 | `5c4b630b5b6c3649abd08caaf912eba20be9f2d9`；PR [#305](https://github.com/jingda2008/mbox-ops-platform/pull/305) |
| 版本及镜像 | `v1.0.0-rc.237`；`mbox-normalized:1.0.0-rc.237-5c4b630` |
| 镜像摘要 | `sha256:c33c950de1b5974d77098cfa81dd2fa9a67c8732abbe5f9d0629a857d9b12e5a` |
| 平台镜像摘要 | `sha256:45e7606953b646175ef77cbdea87c82f15d3469475ac9595d86eae0a52337b3b` |
| PR CI | [36042575852](https://github.com/jingda2008/mbox-ops-platform/actions/runs/36042575852)：2747项PG、107项浏览器主流程（27项按条件跳过）、17项专项检查通过 |
| 标签 CI / 发布 | [36044710770](https://github.com/jingda2008/mbox-ops-platform/actions/runs/36044710770) / [36044710826](https://github.com/jingda2008/mbox-ops-platform/actions/runs/36044710826)，均success |
| 备份 | `/opt/mbox/backups/mbox-20260924T191620Z-3e7cg7.dump`，OSS上传及读回已验证 |
| 保留旧容器 | `mbox-app-rollback-5c4b630-20260925-031811`，旧版本rc.236 |
| 标准发布 | 独立不可变工作区运行 `./deploy/aliyun/deploy-release.sh`；预检、候选、备份、OSS及完成证据、公网浏览器均通过 |

## 数据结果与限制

配置v27目标68桌全部available；27张新增、28张原位改名、15张空旧桌停用。11张遗漏旧桌仍有未结束桌次：666、888、BAR1、BAR2、BAR3、L01、L03、S3、S5、S6、S7，保持原状态，因此可用总数79。原67桌及本次新增27桌的94个ID全部保留；原容量、区域、布局及二维码数量读回一致。没有移动或关闭桌次、修改订单或收退款。

最初改名后补查发现旧H5 URL提示会因W01/W1严格比较被拒绝，已先恢复旧内部编号保护入口。最终发布顺序为：配置同步用renameFrom识别原ID、保留旧code；兼容前端上线且全部发布检查通过后，再执行默认回滚预演及显式提交。最后事务恰好28个改名、没有新增或额外停用；同事务重放变化0。H5初次识别、等待刷新和真实菜单回归覆盖旧提示，错桌提示仍拒绝，服务器继续认证二维码凭证。此记录不把此前临时改名窗口描述为已验证无影响。

新27桌及G1/G2共29桌仍无固定桌码及现场地图坐标；旧→新物理对应尚未确认，不猜测移单或地图位置。SYS-385继续开放。数字身份及浏览器回归不等于现场扫码/张贴验收。

改号后若需要回退rc.236，须先审计恢复本次28个原内部编号，保留新显示名、桌ID和所有业务数据，再执行标准应用回退；不能仅凭部署清单的application_image模式认定旧H5仍兼容新编号，也不能用全库恢复覆盖期间营业数据。当前没有执行回退。

## 三屏只读复核

三屏、后厨批次和数量售后开关均true。后厨当前pending/batch均0；会话和设备授权有效，但在线租约在2026-09-25 01:42:36 CST已到期，早于本次部署，因此canPrepare/canStart/actionSessionValid为false。KDS/取餐的口令轮换独立策略和原会话、设备、在线、岗位校验仍在；不伪造心跳或制作来制造通过结果。SYS-384现场制作验收仍独立保留。

私有证据位于`outputs/table-roster-20260925/`（目录0700、文件0600）：deploy-rc237.log、final-preview.json、final-applied.json、final-current.json、final-verification.json、final-ready.json、final-kitchen-flags.json、final-kitchen-session-timing.json、final-rotation-policy.json；不向Git提交凭据或业务明细。
