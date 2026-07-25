# M-Box 商业V1发布证据说明

记录日期：2026-07-15。

## 证据来源

发布检查不得手工填写测试数、revision或仓储结论。执行：

```bash
MBOX_EVIDENCE_GCP_PROJECT=mbox-ops-jingda-20260715 \
MBOX_EVIDENCE_CLOUD_RUN_SERVICE=mbox-ops-validation \
MBOX_EVIDENCE_GCP_REGION=asia-east1 \
npm run evidence:capture
```

命令会先执行完整`npm run check`和`npm audit --omit=dev`，再读取当前Git commit、工作树状态、实际承接100%流量的Cloud Run revision、不可变镜像摘要、专用服务账号、仓储方式、流量和`/api/ready`结果，并核对云端声明的commit与镜像摘要。

阿里云验证环境使用：

```bash
MBOX_EVIDENCE_PLATFORM=aliyun-ecs \
MBOX_EVIDENCE_DEPLOYMENT_URL=https://139.224.254.60 \
MBOX_EVIDENCE_EXPECTED_SHA=<完整Commit> \
MBOX_EVIDENCE_EXPECTED_DIGEST=sha256:<镜像摘要> \
npm run evidence:capture
```

该模式直接读取阿里云`/api/ready`并核对Commit、镜像摘要、PostgreSQL读取路径和应用就绪状态，不再依赖Google Cloud。

- 可审阅结果：`.runtime/release-evidence.generated.md`
- 机器可读结果：`.runtime/release-evidence.json`（本地生成，不提交密钥）
- 经营整改复核：`docs/operational-system-audit-2026-07-15.md`
- 商业完成矩阵：`docs/commercial-readiness.md`

## 当前工程证据

具体测试数量、提交、镜像摘要、承接流量的revision和线上就绪状态只以对应GitHub Release、服务器发布清单和同次采集生成的`.runtime/release-evidence.generated.md`、`.runtime/release-evidence.json`为准，本文不再复制会过期的数字。Postar工程主链路已完成，但没有真实商户/KYC参数时必须保持禁用；物理POS和现金可用于影子运行，不得把人工报送伪装为渠道成功。

## 正式上线阻断

1. 支付服务商商户参数与小额真金白银支付、退款、查单、账单对账证据。
2. 小程序/服务号/企微AppID、合法域名、ICP备案、隐私协议、模板ID和真机审核。
3. 正式高可用数据库、PITR、告警、正式域名证书、独立恢复和密钥轮换演练。
4. 正式桌台、人员、权限、菜单、SLA、订金、库存初盘和歌手排班导入，并完成两晚影子运行签字。
5. 渗透测试、隐私评估、数据保留期和供应商数据协议。

满足上述证据前，当前版本只标记为“工程验证/影子运行候选”，不标记为“正式商业营业上线”。
