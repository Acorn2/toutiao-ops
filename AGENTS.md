# toutiao-ops 本地长文章分支

本仓库基于上游 Node.js/Playwright 项目，当前公开 CLI 支持 auth、publish article 与草稿队列 drafts。产品边界与数据流见 MVP.md、ARCHITECTURE.md、TECH-STACK.md；使用入口见 docs/ARTICLE_PUBLISHER_V1.md。

- cli/index.js：参数和 JSON 输出；cli/src/article-input.js / article-preview.js：纯本地解析与离线 HTML；article-workflow.js：持久化确认与防重复；ego-draft-page.js / ego-worker.js：默认 Ego 草稿入口；article-page.js / article-records.js：兼容平台 UI 和正文证明；account-store.js / account-lock.js / operation-store.js：私有本地状态和共享账号锁。
- CLI 范围限账号、长文章和草稿队列。不要重新接入自动更新、stealth 或通用弹窗屏蔽，也不要用隐藏遮罩的方式处理安全验证。
- 依赖只通过已审计 cli/package-lock.json 安装：`cd cli && npm ci --ignore-scripts --omit=optional`。禁止远程 npx toutiao-ops、无版本发布包安装和自动更新。调整依赖需补充 P0 审计记录。
- 验证命令在 cli/：`npm test`（无需浏览器）、`npm run test:browser`（完全拦截网络的受控页面）、`npm run check`；根目录 `git diff --check`。
- 受控测试使用独立临时目录和非持久化浏览器上下文，不读写真实账号 Profile。没有真实账号授权时，仅可执行 dry-run 与模拟测试。不得自动登录、保存真实草稿、发表或绕过验证。
- 日常 Agent 流程由 [SKILL.md](SKILL.md) 定义，止于指定账号的草稿箱。先在真实账号完成单篇草稿验收，再接入 WorkBuddy。
- 任何写操作须显式账号，提交之前和回查之前都核对稳定账号 ID。找不到身份/列表/上传完成证据就停止。提交状态不明时保留 operations 记录，先查平台，不自动重复提交。
- 每个 Ego Profile 只绑定一个头条号别名。Ego 写入同机串行使用原生剪贴板，Cookie 由各自 Profile 管理。
- 发稿队列止于草稿箱，按账号绑定和稿件签名确定目标及版本。中断和结果不明的任务按编号仅回查。总览为脱敏的本地 HTML 快照，文件与队列记录仅存私有本地目录。
- 别名仅接受小写；旧大小写目录冲突须停止，不自动改名或搬迁。登录、检查、退出和文章操作共用 ~/.toutiao-ops/locks/<alias>.lock，不自动回收残留锁。
- 版本 2 正文证明保留结构、词间空格及代码原字符，图片用完整 HTTPS URL 摘要。旧版仅文本摘要不可自动视为通过；回查成功写记录时须保留 manifest。列表切换必须有激活与完成加载的证据，不能仅等待任意旧列表行出现。
- 新选择器必须用受控页面覆盖失败路径；平台适配没有真实验收时，在 TEST_REPORT 中保留限制说明，不宣称已稳定支持当前头条页面。
- `private: true` 防止误发 npm；现存标签发布工作流未纳入本次修改，不触发它。不提交账号、结果文件、截图或浏览器数据。
