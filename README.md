# toutiao-ops

面向今日头条长文章的本地 CLI。用 Markdown 准备稿件，在独立的 Ego 浏览器会话中存草稿并重开核对，再通过离线总览管理多个账号。

- **存稿与回查**保留 Markdown 排版与图文顺序，处理原生图注、封面和站外裸网址，从草稿箱重新打开核对稿件。
- **多账号管理**为每个头条号绑定独立的 Ego Profile，存稿前核对账号身份。
- **发稿总览**按账号查看草稿队列和已发布文章，支持搜索、筛选和分页。

## 发稿总览

[下载可交互的 HTML 示例](docs/overview-demo.html)。用浏览器打开本地文件，即可试用账号切换、草稿筛选、文章搜索和分页。示例使用虚构数据。

在仓库根目录运行以下命令，查看自己的总览。

```bash
node cli/index.js drafts open
node cli/index.js drafts open --sync
```

`drafts open` 从本机数据生成并打开 `~/.toutiao-ops/draft-queue/overview.html`。`--sync` 同时通过已登录的 Ego Profile 只读刷新各账号的已发布文章。草稿栏显示已登记到本地队列的稿件。

## 快速开始

需要 macOS 和 Node.js 20 或以上。默认存稿还需要已安装并可从终端调用的 Ego Lite。请使用锁文件安装本地源码依赖。上游 npm 包曾出现供应链投毒，避免用远程 `npx` 或未固定版本的发布包替代本仓库。[P0 安全审计](docs/SECURITY_AUDIT.md)

```bash
npm --prefix cli ci --ignore-scripts --omit=optional
node cli/index.js publish article --content-file examples/article-v1.md --dry-run
```

`--dry-run` 在本地解析和校验稿件，可用 `--preview-file` 另存内嵌图片的预览。省略 `--title` 时，标题取自 Markdown 开头的一级标题。

正式提交、Playwright 兼容入口和受控浏览器测试需要单独安装 Chromium。[Chromium 安装与兼容版本](docs/ARTICLE_PUBLISHER_V1.md)

## 绑定与存稿

在 Ego 的独立 Profile 中登录目标头条号。把下方的 Profile ID 和数字账号 ID 换成实际值，账号别名使用小写。

```bash
node cli/index.js auth bind-ego --account account_a --profile-id 'PROFILE_ID' --expect-user-id 'NUMERIC_USER_ID'
node cli/index.js auth check --account account_a
node cli/index.js drafts add --account account_a --content-file /absolute/path/article.md
node cli/index.js drafts run --account account_a
node cli/index.js drafts open
```

单篇稿件也可直接用 `node cli/index.js publish article --account account_a --content-file /absolute/path/article.md --draft` 存稿。正式提交需要显式选择 `--publish`，通过 Playwright 兼容入口执行。[完整命令与恢复说明](docs/ARTICLE_PUBLISHER_V1.md) · [Agent 工作流](SKILL.md)

## 验证状态

两个真实账号各有一条试稿，都是分步补齐后从草稿箱重开核对通过。默认流程从头连续创建完整图文稿和正式提交仍待真实账号验收。最近一次代码核查通过了 65 项单测和 36 项受控浏览器测试。[测试报告](docs/TEST_REPORT.md)

```bash
cd cli
npm test
npm run test:browser
npm run check
```

受控浏览器测试在隔离上下文中拦截网络。[开发约定](AGENTS.md) · [数据流与存储](ARCHITECTURE.md)

## 来源与许可

基于 [mf-yang/toutiao-ops](https://github.com/mf-yang/toutiao-ops)，原作者为 OpenClaw-CN。[MIT 许可](LICENSE) · [归属说明](NOTICE.md)
