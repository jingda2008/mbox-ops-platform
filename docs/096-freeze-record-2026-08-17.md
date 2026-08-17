# M-BOX 096 候选冻结提交记录

- 冻结时间：`2026-08-17 22:13 CST`（北京时间）
- 冻结提交：`70af86ab5bfc5929c264eb564bf4973456bb62f7`（短 `70af86a`）
- 分支：`codex/wechat-membership-platform`（基线 `v1.0.0-rc.89`/`9d2c261` + 3 个既有提交）
- 执行者：接手代理（接替 Codex 的 agent 开发纪律；本记录与提交说明共同构成冻结证据）
- 关联清单：`docs/commercialization-pending-checklist.md`（最后更新 `2026-08-17 22:15 CST`，变更记录已追加两行）
- 推送状态：`2026-08-17 22:15 CST` 推送分支 `agent/096-freeze-20260817`（HEAD `52c4d19`），创建 **PR #89**（https://github.com/jingda2008/mbox-ops-platform/pull/89 ），触发固定提交 Linux CI

## 1. 冻结内容

一次提交冻结全部 096 本地候选工作树：**439 个文件，+82760/−2659**。

| 类别 | 内容 |
|---|---|
| 数据库 | `database/normalized-migrations/051..096` 共 46 个新迁移（096 文件 SHA-256 `147404f6cba2571d13f316a8890a912fabfdab8ccae0dbe480439f34f18b926c`） |
| 服务端 | `server/` 规范化领域服务/API/worker：忠诚度、活动、客户体验、推荐、结账升级、隐私治理、桌台位置移动、微信身份/小程序码 |
| 前端 | `src/` 规范化 UI 面板 + `miniprogram/` 会员/积分/条款/活动详情页面与工具 |
| 发布链 | `deploy/aliyun/`（维护链：503 维护态、writer 排空、root-only 备份/恢复、配对回滚）、`scripts/`、`.github/workflows/`（小程序三阶段门禁） |
| 配置 | `package.json`（check 链加入小程序门禁）、`.env.example`（联系方式密钥契约占位）、`.gitignore` |
| 文档 | 两份 PRD、客户体验 V1.1 实现文档、62 行追踪矩阵、小程序发布证据示例 |

## 2. 冻结前置审计（全部通过）

- `.gitignore` 覆盖：node_modules / dist* / .env* / .runtime / artifacts / outputs / tmp / keystore / .DS_Store
- 未跟踪文件中无凭据、私钥、密码类内容（唯一疑似项为权限域测试脚本，属正常代码）
- 已跟踪 `.env*` 仅为模板（`.env.example`、`production.env.template`、`validation.env.template`）
- 无 git 冲突标记、无 >1MB 文件、无文件删除、无未暂存残留

## 3. 验证证据状态

- 2026-08-16 18:54 清单记录（同一工作树状态）：全新 PostgreSQL 001—096 **168 文件/998 项全过**；noDB **152 文件/809 项**（47 文件/341 项按数据库条件跳过）；持续负载 **9/9**；双端类型、lint、架构 test/new/zero、差异检查全过。
- 冻结环境限制：`npm` 在当前沙箱 PATH 不可用，**未能重跑 `npm run check`**；本地数字沿用 2026-08-16 记录，最终证据以**固定提交后的 Linux CI** 为准（这正是清单既有的外部缺口）。
- macOS 本地验证不冒充 Linux `flock` 语义；`release-lock.test.sh` 仅测试脚本本身。

## 4. 未包含（按设计，外部阻塞）

- 真实资金支付/退款/日对账证据（星驿生产公钥与通道确认未取得）
- 正式微信 AppID/合法域名/隐私主体/订阅模板审核/真机证据
- 生产 root-only 维护凭据、libc locale 核验、PITR/每日备份/恢复演练
- 真实维护窗执行（503 维护态→排空→备份→只读候选→切流→回滚演练）
- OWNER/OPS_LEAD/MANAGER 三岗位与真实营业现场验收；table-group 拼桌模型（明确不在本轮）

**商业发布结论维持 `DENY`，未合并、未部署。**

## 5. 冻结后的下一步

1. ✅ 已推送分支 `agent/096-freeze-20260817` 并创建 **PR #89**，触发固定提交 Linux CI（验证 `flock`、正式数据库测试不跳过）。
2. ⏳ 等待 CI 完成，回填全量数字到清单（同一轮工作内更新）。
3. 按外部证据清单推进：生产凭据交付、PITR/备份演练、微信正式资料、星驿真实小额交易、三岗位现场验收。
4. 完成验收后按 `docs/operations-runbook.md` 与 `deploy/aliyun/activate-release.sh` 契约执行真实维护窗发布。
