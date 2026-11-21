# toutiao-ops

用 Markdown 写头条长文章，借助 `ego-browser` 保存到指定头条号的草稿箱并重开核对。也可以在自己的 Mac 上启动发稿工作台，查看多个账号的草稿和已发布文章。

- **存稿与回查**保留 Markdown 排版与图文顺序，处理原生图注、封面和站外裸网址，从草稿箱重新打开核对稿件。
- **多账号管理**为每个头条号绑定独立的 Ego Profile，存稿前核对账号身份。
- **发稿工作台**按账号查看头条草稿箱、本地队列和已发布文章，支持搜索、筛选和分页。

## 快速开始

本项目在 macOS 上运行，需要 Git 和 Node.js 20 或以上。只做 Markdown 校验或离线预览时，完成下面的源码安装即可。使用头条存稿、账号同步或在工作台打开草稿之前，还需要安装 Ego Lite。

```bash
git clone --branch codex/article-publisher-v1 https://github.com/Acorn2/toutiao-ops.git
cd toutiao-ops
npm --prefix cli ci --ignore-scripts --omit=optional
node cli/index.js publish article --content-file examples/article-v1.md --dry-run
```

`--dry-run` 返回 `validated` 表示 Markdown 和本地配图通过校验。省略 `--title` 时，标题取自 Markdown 开头的一级标题。可加 `--preview-file /absolute/path/preview.html` 生成带图的离线预览。

请用仓库锁文件安装依赖。上游 npm 包曾出现供应链投毒，请使用这里的源码命令。[P0 安全审计](docs/SECURITY_AUDIT.md)

## 安装 Ego Lite 和 ego-browser

`ego-browser` 是 Ego Lite 提供的命令行工具。toutiao-ops 用它连接本机正在运行的 Ego Lite，并在已绑定的浏览器 Profile 中操作头条创作后台。安装 Ego Lite 后，首次启动引导会配置该命令。由于登录在目标 Profile 内完成，可以跳过导入其他浏览器的数据。

1. 打开官方下载页，选择 macOS 版本。Apple 芯片和 Intel Mac 都有安装包。[下载 Ego Lite](https://lite.ego.app/download)
2. 打开下载的 `.dmg`，把 Ego Lite 拖到「应用程序」，启动浏览器并完成首次启动引导。
3. 保持 Ego Lite 打开，新开一个终端运行以下命令。看到 `ego-browser ready` 即可继续。

```bash
command -v ego-browser
ego-browser nodejs -e "console.log('ego-browser ready')"
```

如果终端提示找不到命令，确认已完成首次启动引导，再在当前终端临时补上常见的安装路径。

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
```

## 绑定账号并保存草稿

为每个头条号创建一个独立的 Ego Profile，在对应的 Profile 中打开头条创作后台并手动登录。运行下方命令查看 Profile ID。在创作后台打开账号的个人主页，主页链接 `/user/` 后面是绑定时需要的头条号数字 ID。[头条创作后台](https://mp.toutiao.com/)

```bash
ego-browser nodejs -e "console.log(await profiles())"
```

在仓库根目录执行绑定和身份检查。把示例别名和两个 ID 换成自己的值。首次绑定推荐用昵称的小写拼音作别名，词之间用 `-`。已有别名可以继续使用，也可以运行 `node cli/index.js auth list` 查看。

```bash
node cli/index.js auth bind-ego --account tamen-houlai --profile-id 'PROFILE_ID' --expect-user-id 'NUMERIC_USER_ID'
node cli/index.js auth check --account tamen-houlai
```

把下面的别名和文稿路径换成自己的值。正文配图写成 `![图片描述](figs/example.png)`，将图片放在 Markdown 文件所在目录或子目录。默认用第一张正文图作单图封面。

```bash
node cli/index.js publish article --account tamen-houlai --content-file '/absolute/path/article.md' --draft
```

返回 `draft_saved` 且 `verified: true` 时，表示已保存并从草稿箱重开核对。用结果中的 `url` 进入草稿，正式发表由作者在头条后台手动完成。需要管理待存稿时，可以用 `drafts add` 登记，随后用 `drafts run` 存入指定账号。[完整命令与恢复说明](docs/ARTICLE_PUBLISHER_V1.md) · [Agent 工作流](SKILL.md)

## 在自己的 Mac 上搭建发稿工作台

安装源码依赖后，在仓库根目录运行下面的命令。Node.js 会直接启动本地 Web 服务并打开默认浏览器，无需另行构建前端或配置数据库。

```bash
node cli/index.js workspace --open
```

工作台默认使用 `http://127.0.0.1:4371`，仅监听这台 Mac 的回环地址。可以省略 `--open` 后手动打开终端打印的网址。若端口被占用，用 `node cli/index.js workspace --port 4372 --open` 换一个端口。用 `Ctrl+C` 停止服务。

选择已绑定的账号，点「立即同步」，工作台会通过同一台 Mac 上已登录的 Ego Profile 刷新该账号的头条草稿箱和已发布文章。页面打开或切换账号时会先显示已有数据。「本地队列」显示通过 `drafts add` 登记的任务。

点「在 Ego 打开」会核对账号和草稿，在对应的 Ego Profile 中打开编辑页。也可以填入 Markdown 文稿路径，点「复制 Codex 指令」，把带有当前账号的存稿指令贴到 Codex。

### 离线总览

想先试用页面，可以用浏览器打开虚构数据的可交互示例。[下载离线 HTML 示例](docs/overview-demo.html)

运行 `node cli/index.js drafts open` 可生成并打开本机的离线总览，文件位于 `~/.toutiao-ops/draft-queue/overview.html`。加 `--sync` 会通过 Ego 只读刷新各账号的已发布文章。

## 验证状态

默认 Ego 草稿流程已在一个真实账号上完成一次图文稿验收。一次 CLI 调用新建草稿，第三条图注自动保存时收到 `7050`，随后从草稿箱重开，核对了三张正文图、三条图注、一个原生外链和单图封面。当前版本止于草稿箱。[测试报告](docs/TEST_REPORT.md)

```bash
cd cli
npm test
npm run check
```

离线测试使用临时数据和模拟的 Ego 页面。[开发约定](AGENTS.md) · [数据流与存储](ARCHITECTURE.md)

## 来源与许可

基于 [mf-yang/toutiao-ops](https://github.com/mf-yang/toutiao-ops)，原作者为 OpenClaw-CN。[MIT 许可](LICENSE) · [归属说明](NOTICE.md)
