# M-BOX 发布证据索引

此路径曾保存会随部署过期的单一云端快照，现已停止作为最新发布依据。

每个版本的有效证据必须同时包含：

1. 对应GitHub Release及其标签、Commit和CI结果。
2. 阿里云服务器上的版本化发布清单、镜像摘要和数据库备份校验值。
3. 部署后`/api/ready`返回的`releaseSha`和`releaseImageDigest`。
4. 候选验证、切流后健康检查和回滚容器记录。

本地执行`npm run evidence:capture`后，可审阅结果生成在`.runtime/release-evidence.generated.md`，机器可读结果生成在`.runtime/release-evidence.json`。两者均为本次采集产物，不提交为跨版本“最新”结论。
