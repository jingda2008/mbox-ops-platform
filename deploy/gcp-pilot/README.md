# Google Cloud门店验证环境

该目录只用于受控验证，不是正式商业生产架构。

- Compute Engine运行Caddy、M-Box应用和PostgreSQL 16。
- Caddy通过`sslip.io`域名自动签发HTTPS证书。
- PostgreSQL不开放公网端口；80/443是唯一业务入口。
- 每日`pg_dump`上传到独立Cloud Storage桶，桶生命周期为30天。
- `.env`包含验证口令和密钥，只部署到服务器，不进入Git。
- 正式上线迁移到中国大陆云、托管PostgreSQL和正式域名。

## 当前验证资源

| 资源 | 当前值 |
|---|---|
| Google Cloud项目 | `mbox-pilot-jingda-20260714` |
| 区域/可用区 | 香港`asia-east2` / `asia-east2-a` |
| 计算实例 | `mbox-pilot-1`，`e2-medium`，50GB平衡持久盘 |
| 业务地址 | `https://34-92-223-142.sslip.io/` |
| 镜像仓库 | Artifact Registry `asia-east2-docker.pkg.dev/.../mbox` |
| 备份桶 | `gs://mbox-pilot-jingda-20260714-backups`，30天生命周期 |
| 健康监控 | 每分钟检查HTTPS `/api/live`，连续失败2分钟邮件告警 |
| 成本保护 | 每月50美元预算，50%、90%、100%告警；预算不会自动关机 |

数据库端口不对公网开放，SSH只允许通过Google IAP进入。虚拟机服务账号仅具有拉取镜像、写入日志/指标和写入备份桶所需权限。

## Cloud Run迁移兼容入口

虚拟机上的Caddy使用`Caddyfile.cloud-alias`将旧域名流量转发到当前Cloud Run验证服务，
旧版应用和数据库不再作为对外业务状态源。2026-07-18已完成实体桌码切换、删除旧签名
密钥和旧二维码文件；旧域名只临时兼容员工收藏地址，不再接受旧桌码令牌。停用全部旧
收藏地址后，应关闭该兼容入口并停止虚拟机。

## 部署顺序

1. 运行`startup.sh`安装Docker、cron和Google Cloud Ops Agent。
2. 将本目录中的Compose、Caddy、备份脚本和cron文件部署到`/opt/mbox`。
3. 以权限`600`写入服务器`.env`，不得提交或打印密钥。
4. 迁移数据库、生成干净种子、一次性初始化租户/门店并启动容器。
5. 将`mbox-pilot-backup.cron`安装到`/etc/cron.d/mbox-pilot-backup`，权限`0644`。
6. 验证`/api/live`、`/api/ready`、员工登录、签名桌码和备份上传。

后续版本发布将新版`docker-compose.yml`复制到`/tmp/mbox-docker-compose.yml`，并以
`MBOX_IMAGE`和Base64编码的`MBOX_PILOT_EMPLOYEE_PINS_B64`调用`release.sh`。脚本会备份
现有`.env`、执行数据库迁移、替换应用容器并等待健康检查，不在命令行输出PIN明文。

员工登录冒烟脚本必须在虚拟机内运行，因为它需要以root读取权限为`600`的`.env`：

```bash
gcloud compute scp smoke-staff-logins.sh mbox-pilot-1:/tmp/mbox-smoke-staff-logins.sh \
  --project=mbox-pilot-jingda-20260714 --zone=asia-east2-a
gcloud compute ssh mbox-pilot-1 \
  --project=mbox-pilot-jingda-20260714 --zone=asia-east2-a \
  --command="sudo bash /tmp/mbox-smoke-staff-logins.sh; rm -f /tmp/mbox-smoke-staff-logins.sh"
```

每次发布还要运行`smoke-role-workflows.sh`。该脚本验证店长可读取候补并进入转桌业务校验、服务员不能读取候补或执行转桌，全程不改变营业数据。

每日备份时间为上海时间04:17，保留云端30天、本机3天。每次发布后必须确认`mbox-pilot-app`与`mbox-pilot-db`健康，并执行一次真实桌码服务闭环。

## 暂停验证

预算只告警、不自动停止资源。长时间不验证时可停止`mbox-pilot-1`以减少计算费用；静态IP、磁盘、镜像和对象存储仍可能产生少量费用。恢复后必须重新检查公网IP绑定、HTTPS、容器健康和定时备份。
