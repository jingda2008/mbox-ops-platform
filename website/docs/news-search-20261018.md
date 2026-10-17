# 七语活动文章搜索复查与标题修正

2026-10-18。Bing实时测试提示英文<title>74字符、建议小于70；全语种检查另发现俄75、法93、德87。增加独立search_title，七语标题改为21—57字符，保留活动品牌、节目、上海与M-BOX。正文、可见主副标题、OG分享标题、JSON-LD、视频与所有预约/后台逻辑不变。

公开站v20原地原子替换7个静态文章文件，未重启服务。备份：/opt/mbox-public-site/backups/news-title-20261018。每个文件先校验旧SHA，再替换；其他535个运行文件与Caddy SHA不变，两容器Image/StartedAt不变。匿名七语SHA与本地产物一致，预约入口及后端ready均200。

检查：node --test tests/news.test.mjs（2/2）；临时目录运行生成器，7文章与产物逐字节一致。生产证据目录：/Users/jingda/mbox/outputs/website-content-20261013/bing-ai-news-20261018/。

Bing sitemap Success/43。7文章的Bing Index仍为旧抓取未收录；中文实时可索引，英文标题提示已经据此修正，00:06英文平台复测已明确允许索引且No SEO/GEO issues found。IndexNow仅发送7个真正发生标题变化的URL，返回200，不是重复催交旧内容。Jina Reader七语正文完整可读，本会话web读取工具仍失败，不能声称所有AI已收录/引用。Bing AI报表只覆盖到10月16日，早于文章发布日期，不能据其0引用判断新文章结果。
