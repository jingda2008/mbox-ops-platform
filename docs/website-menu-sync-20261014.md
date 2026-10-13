# 宣传站菜单同步候选（2026-10-14）

## 代码与契约

GET /api/public/website/menu，固定启动配置scope，不接受查询参数，不认证或创建顾客。输出data.schemaVersion=1、version（公开投影sha256）、checkedAt（实际读取时间）、currency=CNY、products；meta.complete=true及count。价格为有效standard，隐藏/下架/隐藏分类/非顾客渠道不公开，sold_out保留但标不可供应。无成本/利润/客户/员工数据。

单SQL上限2001，超过2000返回503，拒绝半份菜单；数据库readOnly/repeatable-read、statement_timeout5秒、在途请求合并。图片只接受已审核公开媒体或/menu路径。既有顾客菜单includeSoldOut默认false保持原行为；仅新接口true。

## 网站与启用门槛

网站源码 /Users/jingda/mbox/outputs/website-content-20261013/site。默认 WEBSITE_MENU_SYNC_ENABLED 未设置或false，仍显示标注日期的静态资料。等后端发布获用户授权、部署固定提交并验证新接口后，网站运行环境设置 WEBSITE_MENU_SYNC_ENABLED=true，使首页、菜单和预算数据来自同一份快照；错误时明确不可用、不回退已知旧菜单。回退应优先关闭入口或修复接口，不能在已确认下架后把旧静态目录重新当当前菜单使用。

七种语言有分类、状态、查询、错误说明；译名只接受productId+当前原名一致的人工核实映射，当前待绑定新接口真实ID，未核实商品显示原名。新接口上线后先导出对照核实，不能将联调UUID用于生产。

## 验证与状态

后端5新增单元+64既有顾客API测试=69通过，9项既有DB用例未在此单元运行中执行。单独隔离PG测试 website-menu.integration.test.ts 通过：新建独立DB和受限runtime role，schema265，188条fixture涵盖跨店、guestVisible、标准对会员价格、售罄、下架、改价、隐藏父分类、不创建客户，测试后DB/role清理。服务器tsc通过。网站28tests、七语390px手机无溢出、搜索/空结果与小数价格浏览器验收通过。审查智能体最终通过。

后端未推送、未部署，未改生产商品。员工后台与阿里云迁移继续暂停。宣传站可发布候选代码但不得启用新菜单同步开关。
