# M-BOX 1.0.0-rc.250 发布记录

后端/Web已于 **2026-10-06 02:48:46 CST** 部署，schema264。修复相同授权心跳导致岗位重复加载和盘点选择丢失，并在保留线上Android build9原合同的前提下补齐混合预约共享容量校验；承接rc249中接待、联系方式、金融因果顺序、付款锁序及视觉修复。rc249未激活，原标签与资产保持不变。

## 精确身份与发布结果

- PR347合并及不可变 `v1.0.0-rc.250`：`a3ccec909243378460e9fc577a324fe5738cb38e`。
- 标签对象：`5132a58f24d35cf0ab2bbe71a20b45e1b77ed5df`。
- 镜像摘要：`sha256:72f7ec639761d8070c114d128b7672e05e5a853fc97f88af11791ef2d30a6db5`。
- 平台/容器镜像：`sha256:fafd46c904a11b05562562fa551a69e0d45e9590412abf9302e6f087dde71f54`。
- [准确标签CI](https://github.com/jingda2008/mbox-ops-platform/actions/runs/37353954488)、[Release流水线](https://github.com/jingda2008/mbox-ops-platform/actions/runs/37353954753)、[不可变发布资产](https://github.com/jingda2008/mbox-ops-platform/releases/tag/v1.0.0-rc.250)均成功。26个资产及16个部署脚本与配置的哈希、字节和源码身份已核验。
- 标准 `./deploy/aliyun/deploy-release.sh` exit0；备份、迁移/候选、OSS预部署/部署/完成回读和四路HTTP/真实Chromium通过：`/`、`/guest?table=W01`、`/reserve`、`/staff/live`。

## 修复与验证

同一员工/会话且授权内容不变的心跳更新租约而不重置岗位操作；真实身份、会话、权限、导航或双方均提供且变化的营业日/时区仍及时处理。旧代码受控复现库存/盘点GET各1→2、选择1→0；修后44单元、6定向浏览器及正式全组通过。

新接待创建默认false：build9的native table-bound v1与公共预约legacy新建保持原权限、表锁、指纹及永久原回执恢复；已有protocol1读取、真实整组入座及完成守卫不降级。Web按能力关闭新增登记，原意图仍可恢复；仅明确CREATE_DISABLED/not_committed才清未提交意图。未来开启true须先独立验证兼容客户端。本版实际canonical、发布配置、容器及编译parser均核实false，preflight旧native创建为true。

共享名额以policy→table顺序锁定并核验，过期native物理hold不误占位；原成功回执不重验当下日期/容量。固定247源码确实缺共享总量核验，候选旁路检查的双201受控反例不等于生产发生超售。受限PG专项94、配置/app64、generator/normalizer、Web36单元与10隔离浏览器通过。

正式标签PG351文件3170项通过，零跳过/未处理错误，真实HTTP通过；主浏览器136通过/36条件跳过，三屏18、会员8，全部零实际重试。嵌套130项已在3170内；不同专项不相加为去重覆盖率。启动首次员工/顾客各30成功样本，员工p95/p99=252.8/258.1ms，顾客324.4/331.5ms，原500/1000ms和零错误门槛不变。逐attempt摘要及脱敏raw完整保留。

## 线上只读回读

精确SHA、镜像、schema264与worker健康通过；实际受限runtime LOGIN使用repeatable-read/read-only并ROLLBACK，核验261—264迁移校验和、金融私有序列/ACL/函数/触发器、接待RLS/约束/触发器及263联系方式3—500边界，全部通过。只查元数据，不创建生产测试性资金或库存业务。

备份：`/opt/mbox/backups/mbox-20261005T184352Z-yF1yt3.dump`，OSS回读通过。旧应用容器：`mbox-app-rollback-a3ccec9-20261006-024844`，原生产SHA393be68b。canonical原配置备份为`/opt/mbox/secrets/app.env.before-rc250-a3ccec9-reception-gate`，其他配置行原样保留。保留材料不等于生产恢复演练；旧应用回滚会带回已修的付款锁序风险。

Android仍0.4.0-rc.4/build9，stable feed SHA256为`a244d1b6067e0e351acbe4755e21c68f0bd93d0a8d58445fa2b40332f548c4da`且部署前后字节一致。按用户最新范围，build10/11与PR346保留、版本/推送/设备工作递延，本轮未发布APK。iOS与采购退货仍排除。

## 首失败与交付边界

rc249首次顾客startup p95 554.4ms超500，重试334.5ms未抹去首失败；补齐shared-cart诊断并保留每attempt原样本，不削弱身份/桌次锁追求耗时。PR347首轮135通过/1失败/36跳过，原轮和重试均为全页status同时命中成功通知和新建关闭提示；仅限定到该顾客确认通知，原业务读回/到店隔离断言保持，本地原用例首次通过，随后准确第二轮及标签全CI通过。后续结果没有覆盖原日志与trace。

当前版本双小程序平台上传/审核/发布、实体机、真实渠道资金、POS/现金交接、纸票及整班营业仍分别验收。24组中21组当前实现修复不等于所有软件需求或商业验收完成；55条旧成本流水和原历史事实未自动修复，没有证实生产重复扣退款或现金损失。

独立复核既有18份JSON及固定标签源码，迁移校验和、8个运行时函数体及13条可本地核对的OSS对象哈希/字节全部一致；未新增生产业务动作。见[部署独立回读](../../outputs/system-audit-20261005/rc250-independent-deployment-readback.md)。

证据：[最终线上回读](../../outputs/system-audit-20261005/rc250-deployment-final-readback.json)、[实际远端回执目录](../../outputs/system-audit-20261005/deployment-rc250)、[正式浏览器回读](../../outputs/system-audit-20261005/rc250-tag-browser-readback/readback.md)、[正式数据库回读](../../outputs/system-audit-20261005/rc250-tag-database-readback/readback.json)、[首轮保留](../../outputs/system-audit-20261005/pr347-first-ci-readback.json)、[24项矩阵](../../outputs/system-audit-20261005/audit-24-implementation-matrix.md)。outputs为本机归档，不冒称全部公开托管。
