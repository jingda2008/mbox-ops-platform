# 1.0.0-rc.233 入会手机号释放列权限

包含已合并的 PR #298（`b6060dd3cb963abfd19904a02f8c8f18317b5874`）。生产 `POST /api/public/mini/membership/enroll-with-phone` 因 `mbox.customer_verified_contacts` 缺少 `processing_status`、`revocation_reason_code` 的列级 UPDATE 而返回 500。schema 247 把同一条授权留在仓库里：

`GRANT UPDATE (processing_status, revocation_reason_code) ON TABLE mbox.customer_verified_contacts TO mbox_runtime`

不授予整表 UPDATE，不收回已有的 `revoked_at`。重复执行该 GRANT 是空操作。2026-09-24 18:02 CST 生产热修已对 `mbox_runtime` 执行同一语句；本标签让后续发布和重建库仍带这两列授权。迁移成功后 schema 版本写为 247。

同一次提交还让员工隐私草稿接受裁剪前或裁剪后的摘要，入库保存裁剪后正文及其摘要。不向 `privacy_policy_releases` 写入发布行，不代填批准人或员工身份。SYS-201 继续开放。SYS-378 的列权限热修已复核，真机入会仍待发布后验收，本文件不把它记成已关闭。

最低 schema 247。服务端发布包只含员工网页、规范化服务和数据库，明确排除微信小程序。本候选按入会列权限修复发布，不把微信界面上传当作本标签的发布条件，也不把未上传记成已上传。

经营 TC 登记仍按既有口径保持未执行/阻塞，不把本候选写成全部 P0/P1 已通过。标签 CI、不可变产物和生产切换另记；本文件建立时尚未部署。
