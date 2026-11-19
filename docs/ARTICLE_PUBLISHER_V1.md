# 长文章 CLI V1 使用与验收

本版本已执行本地单测和受控页面验证。真实账号的扫码绑定、身份回查及草稿箱读取已验证。保存与重新打开的验收结果见 [测试报告](./TEST_REPORT.md)。真实账号操作须获得授权，正式发表还需单独批准。

日常存稿默认使用 Ego Lite。用户提供稿件和已绑定的账号别名，Agent 调用下文命令预览、保存并回查。真实草稿验收通过后，再把同一流程接入 WorkBuddy。[Agent 调用规则](../SKILL.md)

## 安装与本地预览

macOS 原生，Node.js >=20，npm，独立账号浏览器目录；不使用 Docker、数据库、Web 后台或全局 npm 包。先读 [安全审计](SECURITY_AUDIT.md)。

```bash
cd cli
npm ci --ignore-scripts --omit=optional
node index.js publish article --content-file ../examples/article-v1.md --dry-run
```

本地预览将 Markdown 转成安全 HTML，随 JSON 的 preview.html 返回，可检查标题、段落、链接和图片位置。图片显示为带摘要的占位说明；不读登录态、不启动浏览器、不访问网络，也不生成平台草稿。如需可直接打开的页面，加 --preview-file /existing/directory/preview.html，输出文件 0600、不覆盖旧文件；图片内嵌，脚本和外部资源由 CSP 禁用，总图片引用大小最多 20 MiB，不能与 --result-file 使用同一路径，也不能用于平台写操作。不会自动打开页面。没有此参数时不生成 HTML 文件；如需保存 JSON 结果，可用 `--result-file /existing/directory/preview.json` 新建文件。

默认草稿入口需要已安装并打开的 Ego Lite，以及终端可执行的 `ego-browser`。下列 Chromium 安装命令用于 Playwright 兼容入口或受控浏览器测试：

```bash
node node_modules/playwright/cli.js install --dry-run chromium
PLAYWRIGHT_SKIP_BROWSER_GC=1 /opt/homebrew/opt/node@24/bin/node node_modules/playwright/cli.js install chromium
```

上例 Node 24 路径是本机已确认存在的 Homebrew 可执行文件；其他机器请换成自己的 Node 24 绝对路径，不必安装全局 npm 包或改系统配置。Node 26 解压问题参考 [Playwright #40724](https://github.com/microsoft/playwright/issues/40724)。设置 PLAYWRIGHT_SKIP_BROWSER_GC=1 以保留其他项目浏览器缓存。

当前固定 Playwright 1.56.1，对应 Chromium 141.0.7390.37 / revision 1194；下载源为 cdn.playwright.dev，回退域名 playwright.download.prss.microsoft.com。版本固定用于审计和复现，不能长期代替安全更新；升级需重新审计、锁版本及复跑测试。禁止远程 npx toutiao-ops 或无版本安装原发布包。若曾执行恶意 1.2.4，请先按安全审计末尾的说明处理环境可信性。

## 参数与副作用

| 参数 | 行为 |
| --- | --- |
| --account alias | 写入必须显式指定；命令之前/之后均可。重复指定不同别名报错 |
| --title text | 单行 2–30 个 Unicode 字符；可省略以读取文件开头 H1，不会截断；显式传入优先 |
| --content-file path | 有效 UTF-8 文件，最大 2 MiB；优先于内联正文，不改写源文件 |
| --content text | 兼容内联正文；保留字面量反斜杠，不把代码中的 `\n` 偷换为换行 |
| --format markdown | 默认 Markdown；兼容 text；不接受任意 HTML 输入格式 |
| --cover path | 本地 PNG/JPEG/WebP，最大 10 MiB；Ego 选指定图片为单图封面，图片内容须与正文中的一张图一致 |
| --cover-mode single/none | 显式 single 需提供封面，none 不得带封面；Ego 未指定时按正文配图数量自动选择 |
| --dry-run | 纯本地校验与 JSON 预览；可省略账号 |
| --preview-file path | 仅 dry-run：新建离线 HTML，内嵌图片，0600；父目录须存在 |
| --draft | 默认使用已绑定的 Ego Profile，粘贴富文本正文，上传配图并填写图注，等待自动保存并重开核对 |
| --browser ego/playwright | 草稿默认 `ego`；首发、合集、声明等设置沿用 `playwright` 兼容入口 |
| --publish / --confirm-publish | Playwright 正式提交的显式开关，可能进入审核；两者等价 |
| --result-file path | 将脱敏 JSON 写入**新文件**，0600；拒绝覆盖，父目录须事先存在 |
| --headless | Playwright 无头模式；Ego 存稿始终使用可见会话 |
| --first-publish / --collection / --declaration | 复用编辑器可见选项；无法确认就停止，不静默忽略 |
| --no-weitoutiao | 兼容旧参数；Ego 存草稿依赖自动保存，微头条开关仅在 Playwright 兼容入口中检查 |

三个动作必须且只能选择一个；省略动作会报错，绝不默认正式发表。--publish 与 --confirm-publish 同时提供仍是同一动作，但与 --draft / --dry-run 互斥。

不传 --title 时，只识别 Markdown 文件第一个非空块的 H1（支持内联加粗等文本），并从正文去掉该标题；提取后仍须有正文。显式标题不改写文件内的 H1。内联 --content 或 frontmatter 暂不自动提取标题，不支持的标题实体需显式 --title。源文件保持只读。

支持二级标题、加粗、列表、引用、代码块、链接、表格及图文顺序。平台可能降级样式，代码块不带额外语法高亮。原始 HTML 转义为文本；拒绝 javascript 等危险链接、携带 URL 用户密码的链接。正文图片只允许 Markdown 所在目录及子目录的本地文件，符号链接也不能逃逸；拒绝远程/data URL/SVG，最多 100 处图片。

Ego 使用头条编辑器的小标题样式渲染 Markdown 小标题。图片可放在正文段落中，建议单独成行。图片格式写作 `![图片描述](figs/example.png)`，替代文字进入图片下方的原生图片描述栏，空白时使用不带扩展名的文件名，最多 50 字。1–2 处正文配图默认用第一张作为单图封面，3 处及以上配图默认取前 3 张不同图片作为三图封面。所有正文配图按原顺序保留。表格等样式若被编辑器改动，回查结果标为待处理。图片上传和三图封面的实账号端到端验收见 [测试报告](TEST_REPORT.md)。

Ego 逐张上传正文图，按页面状态等待图片插入正文。确认图片保存后直接填写并核对图注，再插入下一张。

Markdown 识别出的站外 HTTP(S) 裸网址由 Ego 通过头条「外部链接」工具插到原位置，显示标题由头条生成。保存和重开都核对链接目标与段落位置。带显示文字的 Markdown 链接沿用富文本渲染。旧稿的回查如果显示 `external_links_need_update`，表示旧记录缺少原生外链的验证证据，CLI 保留原草稿供处理。

Playwright 兼容入口复用重复图片的上传结果，并独立处理指定封面。两种入口都在文件校验后变化或上传无法确认时停止并保留操作记录。

## 真实账号草稿验收

为每个头条号使用单独的 Ego Profile。在各自 Profile 登录对应头条号后，从创作者后台的个人主页链接核对 `/user/` 后的数字 ID。可用本机 `ego-browser nodejs` 的 `profiles()` 查看可选 Profile ID。以下命令中的占位符应替换成实际 ID。

```bash
node index.js auth list
node index.js auth bind-ego --account account_a --profile-id '<A 的 Ego Profile ID>' --expect-user-id '<A 的头条号数字 ID>'
node index.js auth bind-ego --account account_b --profile-id '<B 的 Ego Profile ID>' --expect-user-id '<B 的头条号数字 ID>'
node index.js auth check --account account_a
node index.js auth check --account account_b
```

不同 Ego Profile 的头条登录 Cookie 独立保存。同一个 Profile 的标签页共用登录态，适合只登录一个头条号。项目拒绝把同一 Profile 或同一头条号绑定到多个别名。每次编辑、等待保存和回查在该账号的同一个 Ego 任务空间完成，写入前与回查前都核对数字账号 ID。不同账号逐个运行，以避免原生粘贴并行占用系统剪贴板。

每个别名存放于 `~/.toutiao-ops/accounts/<alias>/`。`meta.json` 记录头条数字 ID 和 Ego Profile ID，`operations` 保存防重复记录。Ego Profile 自己保存 Cookie。`auth logout` 会归档项目里的账号绑定和兼容浏览器会话，Ego 登录继续由对应 Profile 管理。目录权限为 0700，元信息和操作记录权限为 0600。账号级互斥锁在 `~/.toutiao-ops/locks/<alias>.lock`。旧大小写冲突和残留锁需人工核查。

Playwright 兼容入口可继续使用 `auth login --account <alias> --expect-user-id <数字ID>`。人工扫码最长等待 5 分钟，提示与截图路径写入 stderr，stdout 输出单个结果 JSON。

获得**真实草稿测试授权**后，先用一个账号和一篇测试稿。确认草稿能回查并重新打开，检查归属、正文、封面和图片顺序。后续可增加账号验证会话隔离。下面是供 Agent 使用的两种命令示例。

```bash
node index.js publish article --account account_a --title "草稿验收示例甲" --content-file /absolute/path/text.md --draft
node index.js publish article --account account_b --title "草稿验收示例乙" --content-file /absolute/path/article.md --cover /absolute/path/cover.png --draft --browser playwright
```

日常草稿工作流到此完成。已审阅草稿可在头条号后台人工发表。CLI 的正式提交入口留作独立测试，需要另行明确批准。

验收记录至少包含：系统/Node/Chromium 版本、仓库 commit 与本地 diff、脱敏命令、目标别名、后台实际结果、文章/草稿 ID、诊断路径及问题。不要用 CLI 输出代替后台检查。

## 发稿总览

绑定 Ego Profile 后，按「一篇稿件 × 一个账号」登记。队列接受 Markdown 图文稿和纯文本。下列命令从仓库根目录执行。

```bash
node cli/index.js drafts add --account account_a --content-file /absolute/path/article.md
node cli/index.js drafts run --account account_a
node cli/index.js drafts open
node cli/index.js drafts open --sync
```

从侧栏选账号，点昵称右侧的「账号主页」打开公开主页。草稿队列和已发布文章都能搜索、排序、翻页或输入页码跳转。草稿还可按核对状态筛选，范围为已登记到本地队列的稿件。未接入 Ego 的本地别名可在侧栏展开。

普通 `drafts open` 从本地数据生成 HTML。加 `--sync` 时逐个核对 Ego 账号身份，沿「文章 → 已发布」分页只读同步标题、时间和公开链接，再打开同一份 HTML。已发布列表按后台返回的时间顺序保存。同步失败时保留上次成功快照并标记状态，换绑后清楚区分账号数据。

`add` 本地校验并保留稿件版本与账号绑定。相同账号和版本重复登记返回原任务。纯文本文件可传 `--format text --title '标题'`。`run` 按登记顺序处理该账号的待存稿，遇到异常停止本次执行。处理完异常后，可用 `drafts run --account account_a --id '<任务编号>'` 单独处理。结果不明或中断的任务按编号运行时仅回查，账号绑定或源稿已变化时停止。

`open` 刷新 `~/.toutiao-ops/draft-queue/overview.html`，然后用 macOS 的默认浏览器打开。`overview` 刷新文件并返回所有账号和队列任务的 JSON。登记和执行也会刷新同一个总览文件。已绑定表示本地关联有效，在线登录态在运行时核对。总览只读取队列结果，过往由其他入口执行的记录仍见原操作记录。

队列没有正式提交入口。真实双账号验收通过后，再单独考虑正式提交。

## 结果与恢复

stdout 单个 JSON，文章字段稳定：success、action、account、title、status、verified、article_id、url、message、request_id。失败追加 error_code / stage，诊断仅给本地截图路径，不输出堆栈、Cookie、Authorization、storageState 或原始平台响应。

| status | 含义 | success / verified |
| --- | --- | --- |
| validated | 本地校验通过，不代表平台接受 | true / false |
| draft_saved | 已在独立页面回查草稿记录与完整内容 | true / true |
| submitted_for_review | 已确认平台记录处于审核，尚未公开 | true / true |
| published | 记录明确显示已公开，正文匹配 | true / true |
| unverified | 编辑器可能自动保存或提交结果不确定 | false / false |
| failed | 本地输入、身份或前置检查失败 | false / false |

退出码：0 成功（含本地校验），1 失败，2 状态不确定。--help / --version 为常规文本。若指定结果文件写入失败，stdout 追加 result_file_error，平台结果不因此被改写，调用方应保存 stdout。

操作记录以账号和标题/排版/图片字节/封面/选项的 SHA-256 签名隔离，保留提交意图、原始请求信息和版本 2 正文/链接摘要；正文保留段落、标题、词间空格、代码原字符及图文顺序，允许 p/div、strong/b 等等价表示。图片身份取完整 HTTPS URL 摘要，不再无条件删除查询参数，不保存正文或 URL 明文。签名参数变化也会导致未验证，需人工核验，不能据此重复创建。回查成功仍保留 manifest。普通 unverified 与异常都会保存诊断、阶段和只含枚举/ID/布尔值的回查摘要。

版本 1 的仅文本摘要无法证明段落或代码保真；不会自动视为版本 2 成功，也不会删除旧记录或强制重新创建。旧记录需要人工核查，相关结果保持 unverified。每次运行先查平台，即使本地记录曾成功也要重新验证。相同签名重跑可以恢复已确认结果；查不到时不再点保存/发表。

| 错误码 | 处理 |
| --- | --- |
| ACCOUNT_REQUIRED / INVALID_ACCOUNT / ACCOUNT_CONFLICT / ACCOUNT_ALIAS_COLLISION | 显式且一致地指定小写别名；旧目录冲突需人工核查，不自动迁移 |
| IDENTITY_CONFIRMATION_REQUIRED / ACCOUNT_UNBOUND / EGO_ACCOUNT_UNBOUND | 确认数字 ID 后执行 `auth bind-ego`，或在 Playwright 兼容入口执行 `auth login` |
| EGO_NOT_INSTALLED / EGO_PROFILE_UNAVAILABLE / EGO_PROFILE_ALREADY_BOUND | 核对已安装的 Ego Lite、独立 Profile ID 及现有别名绑定 |
| AUTH_REQUIRED / ACCOUNT_MISMATCH / IDENTITY_UNAVAILABLE / AUTH_STATE_UNAVAILABLE | 人工检查是否过期/混号/页面改版，停止写操作 |
| DRAFT_SAVE_UNAVAILABLE / DRAFT_LIST_UNAVAILABLE | 未识别到明确的草稿保存方式或草稿箱入口，可检查本地诊断截图 |
| DRAFT_SAVE_REJECTED | 平台拒绝自动保存，结果中显示返回码。先核对后台提示和草稿箱，操作记录用于后续只读回查 |
| IMAGE_UPLOAD_FAILED / IMAGE_UPLOAD_TIMEOUT / COVER_UPLOAD_FAILED / UPLOAD_PREVIEW_AMBIGUOUS | 先处理图片或 UI 适配；不提交不完整内容 |
| DUPLICATE_TITLE / RECONCILIATION_REQUIRED / PERSISTENCE_UNVERIFIED | 人工回查所有同标题记录及后台状态，不换标题盲目重发 |
| LIST_VIEW_UNVERIFIED / LIST_UNAVAILABLE / LIST_STRUCTURE_UNRECOGNIZED / PAGINATION_UNAVAILABLE / LIST_LIMIT_REACHED | 未确认全部列表，不新建；V1 最多读取 20 页 |
| ACCOUNT_BUSY | 查看共享锁的 PID/操作/时间，核对进程及后台结果；只有确认无运行命令后，才由用户明确处理该锁；不自动清理 |
| MANUAL_VERIFICATION_REQUIRED / BROWSER_CLOSED / PAGE_TIMEOUT / PROFILE_BUSY / BROWSER_NOT_INSTALLED | 交给用户完成验证或检查浏览器，再回查已有记录 |

诊断截图屏蔽部分身份区域，但仍可能含正文或其他个人信息，只在本地保存，绝不提交。unknown 操作可能没有足够的正文摘要用于恢复，需人工核查；不要删除 operations 或复制账号 Profile 来强制重试。同一账号的登录、检查、退出、文章操作会相互阻断。当前列表适配要求目标标签的 aria-controls/aria-selected 与可见 tabpanel、aria-busy=false 等完成证据；真实页面不满足时会返回 LIST_VIEW_UNVERIFIED，必须在授权验收后按实际 UI 调整，不放宽为任意旧列表行。

## 验证与回退

在 cli/ 执行 npm test、npm run test:browser、npm run check；在根目录执行 git diff --check。浏览器测试对所有请求从内存返回，使用独立非持久化上下文，不触碰真实账号目录。可用 TOUTIAO_TEST_BROWSER 指定受信任浏览器可执行文件做额外兼容测试；生产入口不使用该变量。

本次在独立开发分支保留本地未提交改动，没有提交、推送、PR 或改 main。回退时先保存本分支 diff 与未跟踪源码，在独立目录检出基线 commit `de89bba5ec820d8709ca8feec0241423f3d2bede` 进行只读对比；不要直接用旧版默认发布行为操作真实账号。依赖或选择器回退后重跑测试；不要删除用户会话或操作记录。

auth logout 采用归档而非递归删除，保存于 ~/.toutiao-ops/archive/。它不撤销服务端登录；归档仍含凭据。若要恢复某别名，先确认所有相关浏览器已关闭、目标别名目录不存在，再由用户明确选择对应归档恢复；不自动覆盖其他账号。
