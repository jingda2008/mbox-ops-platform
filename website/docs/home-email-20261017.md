# 首页邮箱可见性

2026-10-17。用户反馈“邮箱首页看不见了”。现网浏览器核查：邮箱仍存在且可见于包场、到店和页脚，未被删除或CSS隐藏；首页开头没有邮箱入口。

新增七语 `.hero-contact`，位于首页介绍与预约按钮之间，复用既有本地化邮箱标签和 `mailto:shmbox@qq.com`。底部联系方式保留。

源码生成器与 pages.json 同步更新；现网运行服务已缓存旧模板，为避免重启或切换服务，app.js 在缺少新块时克隆已有邮箱行加入首页。新静态模板存在时不重复添加。生产存储的 pages.json 也已最小插入，下一次服务启动直接带新块。不把当前已缓存响应称作新块已服务端渲染；该入口当前通过浏览器显示，原有邮箱本来就可直接在HTML读取。

仅更改公开站 app.js、style.css、data/pages.json；125个其他运行文件及公开站/员工容器镜像、启动时间、状态不变。备份 `/opt/mbox-public-site/home-email-20261017-backup`。无数据库写入、预约提交或邮件发送。

验证：38项网站测试全部通过；正式七语首页各有且仅有一个带正确本地化标签的 hero-contact，href均为正确邮箱；390px整页无横向溢出；中文电脑和手机首屏显示已截图核查。

证据目录：`/Users/jingda/mbox/outputs/website-content-20261013/home-email-20261017/`，production-result.json、live-seven-languages.json、live-mobile.png。
