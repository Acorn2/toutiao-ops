# 本地长文章 CLI

本目录为本地源码版，`private: true` 禁止误发 npm。Node.js >=20，macOS 原生运行。禁止远程 npx 或无版本安装原发布包。

```bash
npm ci --ignore-scripts --omit=optional
node index.js publish article --content-file ../examples/article-v1.md --dry-run
node index.js --help
node index.js publish article --help
```

省略 --title 时从 Markdown 文件开头 H1 提取标题；加 --preview-file /existing/directory/preview.html 可在 dry-run 导出内嵌图片的离线预览，不自动打开、不覆盖旧文件。别名须小写；旧大小写冲突和旧版正文摘要都保守停止，不自动迁移。

完整参数、平台副作用、账号身份绑定、退出码和恢复方法见 [ARTICLE_PUBLISHER_V1](../docs/ARTICLE_PUBLISHER_V1.md)。[安全审计](../docs/SECURITY_AUDIT.md) 与 [测试报告](../docs/TEST_REPORT.md) 是安装和验收依据。

当前注册 `auth`、`publish article`、`drafts` 和 `workspace`。长文章入口须显式选择 `--dry-run` 或 `--draft`。所有平台写操作必须显式选择账号，首次绑定还须提供预期数字账号 ID。

存草稿通过 `ego-browser` 连接本机 Ego Lite。每个头条号使用单独的 Ego Profile，登录后执行 `auth bind-ego --account <alias> --profile-id <id> --expect-user-id <数字 ID>`。Markdown 配图写作 `![图片描述](figs/example.png)`，替代文字填入头条原生图片描述栏。有正文配图时默认用第一张作为单图封面。[Ego Lite 安装与命令自检](../README.md#安装-ego-lite-和-ego-browser)

在本目录运行 `node index.js workspace --open` 可启动本机发稿工作台，默认地址为 `http://127.0.0.1:4371`。[工作台搭建与使用](../README.md#在自己的-mac-上搭建发稿工作台)

用 `drafts add --account <alias> --content-file <path>` 登记待存稿，`drafts run --account <alias>` 处理该账号的队列，`drafts open` 刷新并用系统默认浏览器打开总览。加 `--sync` 可只读更新已发布文章。`drafts overview` 只刷新文件并输出 JSON。

操作结果以单个 JSON 写入 stdout。结果不确定时退出码 2，不自动重复提交。只有平台记录与正文确认一致才能返回 verified: true；dry-run 的 validated 只表示本地校验。

```bash
npm test
npm run check
```

日常验证采用离线测试。真实页面验收使用指定账号的 Ego Profile。
