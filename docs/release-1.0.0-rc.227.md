# 1.0.0-rc.227 客人下单紧急修复

继承rc.226身份保存修复，保持principal_id和external_identity_id绑定不可变，不扩大权限。rc.226固定标签CI的数据库回归2710项通过、1项失败；新增付款身份测试暴露未限定schema的pgcrypto digest无法解析。该候选未部署，标签保留。

付款及通知身份关联改用PostgreSQL内建sha256(convert_to(...,UTF8))，与Node SHA256 UTF8哈希一致；受限账号测试固定search_path=pg_catalog，修复前复现相同失败，修复后包含通知接收人越权拒绝的相关98项回归通过。schema242不变，无小程序包变化。

用户已授权紧急上线。固定SHA CI、镜像、备份及生产恢复结果待正式流程完成后记录。详见[故障记录](guest-checkout-incident-20260923.md)。
