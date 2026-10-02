#!/usr/bin/env python3
"""List native page sources for human acceptance; never infer UI success from source presence."""
import re
from pathlib import Path
root=Path(__file__).resolve().parents[1]
source=root/'android/app/src/main/java/com/mbox/staff'
rows=[]
for path in sorted(source.glob('*.kt')):
    text=path.read_text()
    names=re.findall(r'@Composable\s+(?:(?:private|internal)\s+)?fun\s+(\w+)',text)
    pages=[name for name in names if name.endswith(('View','Screen','Picker')) or name in ('StaffApp','More','Tables','Cashier','Orders')]
    if pages:
        rows.append((path.name,', '.join(pages),str(text.count('OutlinedTextField(')),str(text.count('safeDrawingPadding()')),str(text.count('imePadding()'))))
header='''# Android 页面源码清点与设备验收边界

本表由 scripts/inventory-android-pages.py 生成。仅清点页面函数和源码标记，不能证明布局正确、键盘未遮挡或读屏顺序正确。AlertDialog 使用系统对话框布局，安全区/键盘计数为0也不直接判定缺陷。

每页仍需在真实设备核验：正常/空白/无权/离线/未知结果，大字与横屏，键盘和返回操作；拍照/扫码/语音还须真实设备及权限拒绝核验。任何一项不能仅凭构建通过标为完成。

| 源码 | 页面/选择器 | 文本输入 | 安全区标记 | 键盘标记 |
| --- | --- | --- | --- | --- |
'''
body='\n'.join('| '+' | '.join(row)+' |' for row in rows)
(root/'evidence/android-completion-20261001/PAGE_SOURCE_INVENTORY.md').write_text(header+body+'\n')
print(f'{len(rows)} native page source files inventoried; visual acceptance remains independent.')
