# PrintBridge 1.0.11-r1：仅放大制作单备注

只将`bar_production`、`kitchen_production`的商品备注及整单备注从ESC/POS字号0改为17（两倍宽高，与制作商品字号一致）。粗细、对齐、文字、品名、数量、桌号、Logo、其他票种、通讯、编码、切纸和防重复机制不变。长备注沿用原换行函数，纸长按内容自然增加。未改后台或网页HTML模板。

本版仅接受完整原版1.0.10或已安装的相同1.0.11；保留原升级器事务、备份和失败恢复机制，未知改动/更高版本拒绝覆盖。门店最后上报1.0.10（2026-09-21 01:52 CST），不是本版已安装的证明。

输入：rc.209发布资产`MBOX-PrintBridge-1.0.10-OneClick-r1.zip`，SHA256 `412b3ee4fd61030da7a37214049feb8809b82bce4bebab6b7c6e7ec7efdf9fe3`。

```sh
python3 scripts/build-print-bridge-111-upgrade.py \
  --previous-package /ABSOLUTE/PATH/MBOX-PrintBridge-1.0.10-OneClick-r1.zip \
  --pwsh /ABSOLUTE/PATH/pwsh
```

输出：`artifacts/print-bridge-one-click-1.0.11-r1/MBOX-PrintBridge-1.0.11-OneClick-r1.zip`，SHA256 `b7b6af7fae7b1e470487e4e835e8557374d9a0b4fee8fd7ca967cecfd97ba9d7`。

验证：30组原/新渲染器对比（10种票据×空/短/长备注），只有两种制作单备注size改变；15样例×3打印配置共45组字节生成，非目标票据39组与1.0.10哈希完全相同。原升级核心15项故障/恢复场景、实际升级器5项基线/篡改/降级校验通过。58/80mm共10张原生字节预览无超宽且各有一次终止切纸。预览使用本机字形，不冒充原打印机字库/实际纸票。

完整解压后先运行`MBOX-Test-Only.cmd`试打制作单，空闲时运行`MBOX-OneClick-Upgrade.cmd`。原配对、队列、配置及防重复记录保留；核对新心跳1.0.11和实物备注。本次未访问Windows服务或真实打印机，需现场安装才生效；不需要部署后台。
