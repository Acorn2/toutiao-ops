# 本地长文章 CLI

本目录为本地源码版，`private: true` 禁止误发 npm。Node.js >=20，建议 Node 24（Node 26 安装浏览器可能解压挂起），macOS 原生运行。禁止远程 npx 或无版本安装原发布包。

```bash
npm ci --ignore-scripts --omit=optional
node index.js publish article --content-file ../examples/article-v1.md --dry-run
node index.js --help
node index.js publish article --help
```

省略 --title 时从 Markdown 文件开头 H1 提取标题；加 --preview-file /existing/directory/preview.html 可在 dry-run 导出内嵌图片的离线预览，不自动打开、不覆盖旧文件。别名须小写；旧大小写冲突和旧版正文摘要都保守停止，不自动迁移。

完整参数、平台副作用、账号身份绑定、退出码和恢复方法见 [ARTICLE_PUBLISHER_V1](../docs/ARTICLE_PUBLISHER_V1.md)。[安全审计](../docs/SECURITY_AUDIT.md) 与 [测试报告](../docs/TEST_REPORT.md) 是安装和验收依据。

当前注册 auth、publish article 和 drafts。没有动作参数时不会默认发布；保存草稿和正式提交不能同时指定。所有平台写操作必须显式选择账号，首次登录还须提供预期数字账号 ID。

草稿默认使用 Ego Lite。每个头条号使用单独的 Ego Profile，登录后执行 `auth bind-ego --account <alias> --profile-id <id> --expect-user-id <数字 ID>`。Markdown 配图写作 `![图片描述](figs/example.png)`，替代文字填入头条原生图片描述栏。正文有 3 处及以上配图时自动使用三图封面。

用 `drafts add --account <alias> --content-file <path>` 登记待存稿，`drafts run --account <alias>` 处理该账号的队列，`drafts open` 刷新并用系统默认浏览器打开总览。加 `--sync` 可只读更新已发布文章。`drafts overview` 只刷新文件并输出 JSON。

stdout 为单个 JSON；人工扫码提示仅写入 stderr。结果不确定时退出码 2，不自动重复提交。只有平台记录与正文确认一致才能返回 verified: true；dry-run 的 validated 只表示本地校验。

```bash
npm test
npm run test:browser
npm run check
```

浏览器测试使用独立非持久化上下文、拦截所有网络；无需真实登录。浏览器需另外安装，不能把 Mock 通过当作真实平台验收。
