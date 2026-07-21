# Cloud Run 不可变发布运行手册

## 一次性配置

GitHub 环境 `production` 需要审批保护，并配置：

- Variables: `GCP_PROJECT_ID`、`GCP_REGION`、`GCP_CLOUD_RUN_SERVICE`、`GCP_ARTIFACT_REPOSITORY`、`GCP_MIGRATION_JOB`
- Secrets: `GCP_WORKLOAD_IDENTITY_PROVIDER`、`GCP_DEPLOY_SERVICE_ACCOUNT`
- Workload Identity Provider 必须用仓库属性条件限制到本仓库；禁止上传服务账号 JSON 密钥。
- `GCP_MIGRATION_JOB` 是预配置的 Cloud Run Job，复用生产数据库、Cloud SQL 连接和 `DATABASE_URL` secret，只运行 `server/migrate.ts`。

## 自动发布

1. `main` 的 `ci` 全部通过后触发发布。
2. 用完整 Git commit SHA 构建并推送镜像。
3. 从 Artifact Registry 取得 `sha256` 摘要，后续只使用摘要，不使用可变 tag。
4. 迁移 Job 先执行仅向后兼容的数据库迁移。
5. 新 revision 以 0% 流量和候选 tag 部署。
6. 候选地址必须通过就绪、Git SHA、镜像摘要、PostgreSQL 与规范化投影一致性验证。
7. 验证后把 100% 流量切到候选 revision，再从正式地址复验。
8. 切流后复验失败，工作流自动把 100% 流量切回上一 revision。
9. 每次尝试都上传 JSON 与 Markdown 发布证据，保留 90 天。

## 人工回滚

在 `deploy-cloud-run` 工作流选择 `rollback`，填写已经验证过的完整 Cloud Run revision 名称。工作流只调整流量，不重新构建镜像。

## 发布纪律

- 禁止从本地未提交文件直接部署。
- 禁止用 `latest` 或仅 tag 作为生产发布依据。
- 数据库迁移只能增加兼容结构；删除字段或不可逆变更必须先完成两阶段迁移。
- 发布成功的定义是正式地址返回正确 Git SHA、镜像摘要、数据投影 revision 与经营状态 revision 一致。
