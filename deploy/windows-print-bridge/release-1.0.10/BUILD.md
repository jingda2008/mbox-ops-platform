# PrintBridge 1.0.10-r1

本版使用用户确认的结账/支付抬头r4；生成包SHA256：
`412b3ee4fd61030da7a37214049feb8809b82bce4bebab6b7c6e7ec7efdf9fe3`。

构建入口为 `scripts/build-print-bridge-110-upgrade.py`，从固定1.0.9升级包和r4确认包重建并校验源代码。
`patch-checkout-print-venue.mjs`、`checkout-venue-bitmap.json` 保存本次实际结构化打印样式；顶层旧文本桥只作为兼容回退，不是本包原生排版。

所需输入集中归档为 `PrintBridge-1.0.10-BuildInputs.zip`，随rc.209发布资产保存；内含：

- `MBOX-PrintBridge-1.0.9-OneClick-r1.zip`，SHA256 `4a8d72f736d26a26af5c406f81510534cdfbd4b0e99a4cafb03f746157213e00`
- `MBOX-Checkout-Preview-Test-20260919-r4.zip`，SHA256 `55203d664e85d4ccfac6b1c76a6785dbb6e66d7f65e0c95c9af26e7c715c3b70`
- `fixtures.json`，SHA256 `411ae9a6e4538d03c87b70acb71bb3f1f487e84dbf9bfbc599adf40d510e410f`

完整解压构建输入，在已安装Node及PowerShell的环境运行：

```sh
python3 scripts/build-print-bridge-110-upgrade.py \
  --previous-package INPUTS/MBOX-PrintBridge-1.0.9-OneClick-r1.zip \
  --approved-package INPUTS/MBOX-Checkout-Preview-Test-20260919-r4.zip \
  --fixtures INPUTS/fixtures.json \
  --pwsh /ABSOLUTE/PATH/TO/pwsh
```

输出在 `artifacts/print-bridge-one-click-1.0.10-r1/`；构建不会安装服务、发布后台或访问打印机。
门店使用 `MBOX-OneClick-Upgrade.cmd`，试打使用 `MBOX-Test-Only.cmd`。自动备份/恢复与配置保留来自原固定包升级流程；未知混装拒绝覆盖。Windows/UAC和实际纸票需门店验收。
