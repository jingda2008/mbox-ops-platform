# M-BOX 096 候选冻结提交记录

- 冻结时间：`2026-08-17 22:13 CST`（北京时间）
- 冻结提交：`70af86ab5bfc5929c264eb564bf4973456bb62f7`（短 `70af86a`）
- 分支：`codex/wechat-membership-platform`（基线 `v1.0.0-rc.89`/`9d2c261` + 3 个既有提交）
- 执行者：接手代理（接替 Codex 的 agent 开发纪律；本记录与提交说明共同构成冻结证据）
- 关联清单：`docs/commercialization-pending-checklist.md`（最后更新 `2026-08-17 22:15 CST`，变更记录已追加两行）
- 推送状态：`2026-08-17 22:15 CST` 推送分支 `agent/096-freeze-20260817`（HEAD `52c4d19`），创建 **PR #89**（https://github.com/jingda2008/mbox-ops-platform/pull/89 ），触发固定提交 Linux CI
- **CI 结果：`2026-08-18 01:34 CST` 全绿**（HEAD `40a5240`，运行 32050445057）：quality / normalized_database（998/998 测试含恢复演练、http acceptance 负载门禁）/ normalized_browser / performance / verify 全部 SUCCESS。未合并、未部署

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
- 冻结环境限制：`npm` 在当前沙箱 PATH 不可用，**未能重跑 `npm run check`**；本地数字沿用 2026-08-16 记录。
- **✅ 固定提交 Linux CI 已全绿（2026-08-18，PR #89，HEAD `40a5240`）**：quality（`npm run check` 全家桶 + release:system:test + miniprogram 门禁）、normalized_database（全新库 001—096 迁移 + 998/998 事务/RLS 测试 + http acceptance 负载门禁 + 架构门禁）、normalized_browser、performance、verify 全部通过。
- CI 迭代修复记录（9 轮，均为生产代码真实改进）：① loyalty 策略测试硬编码切换点时间炸弹（改为相对时间）；② restore 证据捕获 search_path 会话不对称（固定 `search_path=pg_catalog`）；③ `docker exec` 不继承宿主机环境变量导致 `PGOPTIONS` 失效（wrapper 显式转发，顺带修复 capture 从未真正只读的缺口）；④ claim 过期时间双 `clock_timestamp()` 竞态（CTE 单次求值）；⑤ 证据 mismatch 诊断块 `exit 1` 破坏 ERR-trap 回滚语义（改 `false`）；⑥ http acceptance kdsPrepareComplete 单轮 runner 抖动（重跑通过）。
- macOS 本地验证不冒充 Linux `flock` 语义；`release-lock.test.sh` 仅测试脚本本身。

## 4. 未包含（按设计，外部阻塞）

- 真实资金支付/退款/日对账证据（星驿生产公钥与通道确认未取得）
- 正式微信 AppID/合法域名/隐私主体/订阅模板审核/真机证据
- 生产 root-only 维护凭据、libc locale 核验、PITR/每日备份/恢复演练
- 真实维护窗执行（503 维护态→排空→备份→只读候选→切流→回滚演练）
- OWNER/OPS_LEAD/MANAGER 三岗位与真实营业现场验收；table-group 拼桌模型（明确不在本轮）

**商业发布结论维持 `DENY`，未合并、未部署。**

## 5. 冻结后的下一步

1. ✅ 已推送分支 `agent/096-freeze-20260817` 并创建 **PR #89**。
2. ✅ **固定提交 Linux CI 全绿**（2026-08-18，运行 32050445057）。
3. ⏳ 待决策：PR #89 合并入 `main`（合并=候选基线正式进入主分支，仍不部署；须按 AGENTS.md 由负责人确认）。
4. 按外部证据清单推进：生产凭据交付、PITR/备份演练、微信正式资料、星驿真实小额交易、三岗位现场验收。
5. 完成验收后按 `docs/operations-runbook.md` 与 `deploy/aliyun/activate-release.sh` 契约执行真实维护窗发布。
