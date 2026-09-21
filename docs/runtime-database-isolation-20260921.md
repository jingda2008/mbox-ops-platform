# SYS-310：生产数据库登录隔离

本报告记录原阶段开发与本地验证边界；没有执行生产身份变更或部署。SYS-310须在正式维护流程中核验实际会话及业务，不能仅因代码通过标记生产关闭。具体部署现状和角色能力保存在受控运维证据中，以下为代码契约与验收要求。

## 身份约束

`DATABASE_URL` 必须显式指定独立 LOGIN。生产 API 启动、独立 worker 连接池启动和 `/api/ready` 使用实际连接核对 `session_user=current_user=URL登录名`，拒绝管理员登录后 `SET ROLE`。检查登录及全部可到达成员角色：禁止超级用户、BYPASSRLS、CREATEDB、CREATEROLE、REPLICATION；成员仅允许本登录和 NOLOGIN 的 `mbox_runtime`，必须立即继承其权限。禁止拥有当前数据库/任何 schema、表或函数，禁止建 schema 或在已有非临时 schema 创建对象。可调用的非系统 SECURITY DEFINER 函数必须在 `mbox` 且固定 `search_path=pg_catalog, mbox`；这不代替每个函数内部业务授权审计。

维护密码、PGPASSFILE、PGSERVICEFILE 等不能进入生产应用配置。不存在跳过生产数据库身份检查的开关；健康检查只返回通用失败原因，不返回数据库用户名或口令。就绪检查发现后续权限漂移也会失败。

## 迁移与备份

API/worker 只使用运行 `DATABASE_URL`。发布的迁移兼容检查、迁移与发布数据配置命令在短生命周期维护容器中执行，通过 `--maintenance-service=<服务名>` 从 root 所有、600、非符号链接的 `pg_service.conf` 和 `.pgpass` 读取独立管理凭据；管理 URL 仅在进程内存，不写回 `app.env`。容器只读根文件系统、无 capabilities，只有必要配置与密钥只读挂载。永久服务没有这些维护挂载。

维护连接须与实际低权限运行连接指向同一数据库，登录不同；管理员本身也必须 `session_user=current_user`。备份仍走现有 host libpq service；发布同时核对运行、备份、迁移三者实际登录互不相同。运行、备份都不能替代管理服务。旧 schema 可能还未给运行账号元数据读权，因此**迁移前的兼容检查使用管理连接并设置只读**，不会要求先手改元数据权限。

service 的受支持字段是 `host, port, dbname, user, sslmode, sslrootcert, connect_timeout, application_name`。必须显式指定 `sslmode=disable|require|verify-ca|verify-full`；网络链路的证书要求由实际运维环境决定。生产远程数据库使用经验证的证书设置，若配置 `sslrootcert`，证书必须在 `/opt/mbox/secrets` 内且由 root 所有，按原绝对路径只读挂载。禁止 service 内嵌 `password/passfile/options` 或重复字段。不支持的配置会明确阻断预检，不能静默降级。

## 回滚门禁与首次切换阻塞

发布在迁移之前，用当前候选镜像的身份 guard 代码通过标准输入送入旧应用容器执行。旧容器从自身环境读取数据库 URL，分别新建 API/worker 连接，并同时通过旧镜像和候选镜像的身份校验；密码不会被导出。证据绑定旧容器 ID、完整 SHA、镜像 digest 与环境摘要。旧镜像必须带 `restricted-login/v1` 契约，不能把仅改 URL 的 rc.216 视作合格基线，因为旧版本仍有两处事实表行锁缺权，`ready` 不能证明退款兼容。

普通迁移在切流前再次实际校验。需要停止旧 writer 的 contract 迁移在 drain 前再次实际校验，切流前只验证同一容器/镜像/环境及停止状态，不会为验权重启 writer。任何自动回滚在旧应用恢复后、恢复流量前再次实际验权；contract 数据库恢复还须通过旧版本 private ready。失败保留停流状态，不恢复高权限密码。

**首次切换的原阶段资格条件仍未满足，不因本地验证解除阻塞。** 必须准备包含必要权限兼容修复的恢复基线，并有精确镜像/SHA、目标schema对应的真实低权限退款（含无奖励账分支）、不可变回执、库存制作、worker与scope回归日志。身份契约与ready不是完整业务验收；本轮没有生成表示生产业务已通过的证据。旧环境的实际账号权限及适配结果仅在受控报告中保留。

## 切换前的独立运维工作

以下仅是准备方案，本轮没有执行：

1. 管理员确认现有 owner、运行、备份职责，以及生产存量 SECURITY DEFINER 函数和 schema 权限。新运行账号不能拥有数据库对象；只继承 `mbox_runtime`。保持原 owner/迁移管理员，不把对象所有权转给运行账号。
2. 通过受保护会话创建运行登录（示意名 `mbox_app`）：`CREATE ROLE mbox_app LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT mbox_runtime TO mbox_app;`。使用交互式密码设置或既有密钥管理流程，不把真实密码写到 SQL 文档、shell 历史或输出证据。
3. 配置独立迁移与备份登录及 root:600 服务文件；迁移账号保有更新现有对象的管理能力，备份账号按现有备份手册只读和 RLS 完整备份要求配置。三个实际登录不同。先审计公共 schema 的 CREATE 权限；若旧数据库仍允许 PUBLIC CREATE，先评估其它应用后单独治理，不能为了通过检查给运行账号增权。
4. 制作待发布 `app.env` 只放受限 `DATABASE_URL`，校验新旧候选均能用受限账号运行。只有迁移/备份维护容器能读管理文件。
5. 按既有正式发布脚本执行。候选的真实身份预检失败时，停在写库和切流之前。227 迁移补充运行的两张元数据表 SELECT 与 `stores.updated_at` 列级 UPDATE；后者只为保留 worker 的 `FOR KEY SHARE`，没有开放门店配置字段写权限。
6. 读取正式 API/worker 的真实会话身份、ready、scope 隔离、库存/退款/日切及备份恢复证据，再决定生产验收。回滚也必须沿用已验证的低权限登录；如果旧二进制需高权限才能运行，不能把恢复高权限密码当作已验收回滚方案。

## 本地验证与边界

集成测试 `server/normalized/runtime-database-identity.integration.test.ts` 需要外部准备好的**临时、已迁移** PostgreSQL 库、管理员测试连接 `TEST_NORMALIZED_DATABASE_URL`，以及只继承 `mbox_runtime` 的真实低权限登录 `TEST_NORMALIZED_RUNTIME_DATABASE_URL`。测试会用管理员为该唯一测试登录暂时增权后恢复，验证 guard 拒绝权限漂移；严禁把生产连接传给它。没有运行连接时跳过，不会尝试用管理员 SET ROLE 伪装低权。

本轮另外将库存、后厨、逐份售后、支付与权限现有测试复制到独立证据目录，只把业务事务连接池改为真实受限 LOGIN，管理员仅用于合成 fixture 与证据读取，保留业务断言。脚本、日志、数据库清理记录位于 `outputs/audit-remediation-20260921/security/`（工作树父目录的输出区）。核心和已配置 adapter worker 在空队列合成门店下完成一轮；没有发起外部支付、打印、微信或通知。空队列通过不能代替真实订单量、外部通道、硬件与门店验收。

运行身份区别依据 PostgreSQL 官方 [session_user/current_user 与 pg_has_role](https://www.postgresql.org/docs/16/functions-info.html)，维护文件参照 [service file](https://www.postgresql.org/docs/16/libpq-pgservice.html) 和 [password file](https://www.postgresql.org/docs/16/libpq-pgpass.html)。
