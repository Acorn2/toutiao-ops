# P0 静态安全审计

审计日期：2026-11-17。基线 commit：`de89bba5ec820d8709ca8feec0241423f3d2bede`。

## 结论

**通过，仅允许本地源码开发、锁定依赖安装与隔离测试。** 当前 Git 源码未发现已知投毒特征或无法解释的外传负载；不代表运行环境、浏览器、未来依赖或真实平台流程已获安全证明。P0 完成之前没有执行项目代码或安装依赖。

## 来源与检查范围

- origin：`https://github.com/Acorn2/toutiao-ops.git`；GitHub API 返回 `fork: true`，parent/source 均为 `mf-yang/toutiao-ops`；未配置 upstream，远端 API license 为 null，与本地缺少 LICENSE 一致。
- 初始分支 `main`，唯一未跟踪目录 `.idea/`，未读取或覆盖其内容；开发分支 `codex/article-publisher-v1`。
- 阅读全部 `cli/index.js`、`cli/src/*.js`、`cli/package.json`、README、相关 references、`.gitignore`、`.github/workflows/publish.yml`；不存在根 package.json、lockfile、项目 .npmrc、scripts/ 或项目 AGENTS.md。
- 入口 7,833 bytes，源码可读。检索安装钩子、进程启动、动态执行、环境变量、网络端点和凭据文件操作；没有 bun、混淆入口、GitHub/云密钥采集或加密外传逻辑。
- 原有数据请求主要是头条页面内 fetch/响应拦截；会话保存在用户目录。自动更新模块请求 npm registry，仅检查版本，但建议无版本全局安装，有供应链风险。
- CI 使用 npm/GitHub 发布令牌及标签触发发布，是可解释的发布流程；本次不修改、不触发 CI，不创建标签或推送。
- README/package 声明 MIT，但仓库没有 LICENSE 文件。保留作者 `OpenClaw-CN`、来源和 MIT 声明，补齐许可证文本与归属说明。
- 常见全局安装路径与当前 cli/node_modules 未发现本包；未对整台 Mac 或历史 npm 缓存取证，不能据此排除历史感染。

## 风险与处置

| 位置（基线） | 发现 | 处置 |
| --- | --- | --- |
| cli/package.json:34 | postinstall 使用 npx，未锁版本、吞掉安装失败 | 移除钩子，仅用已审计本地 Playwright 命令 |
| cli/package.json dependencies | 全部使用 ^，无 lockfile；stealth 引入多层间接依赖 | 删除 stealth/extra，固定三个直接依赖并提交 lockfile |
| .gitignore | 排除 lockfile | 改为跟踪 lockfile |
| cli/src/update-check.js / index.js | 每次命令请求 registry，提示无版本全局安装 | 先从 CLI 移除调用，定版清理时删除无调用方的检查模块 |
| browser.js getAccountDir / auth.js logout | 别名可路径穿越，目录权限宽，删除范围不安全 | 校验别名、拒绝符号链接、0700/0600；退出采用归档 |
| publish-article.js | 草稿无提交即成功、发布只看点击、标题截断、图片错误被吞 | 验证持久化记录，状态不明保守返回，输入预检与停止上传失败 |

## 依赖静态核查和安装策略

原依赖：commander ^12.1.0、marked ^17.0.5、playwright ^1.50.0、playwright-extra ^4.3.6、puppeteer-extra-plugin-stealth ^2.11.2；原间接依赖不可复现，不安装该未锁定集合。

选定精简集合如下，使用系统 curl（TLS 验证开启）读取 npm 官方 metadata 与 tarball，在内存中校验 SHA-512 integrity、检查 manifest 和 JavaScript 风险关键字，没有解包执行。

| 包 | 固定版本 | 运行时依赖 / 安装钩子 |
| --- | --- | --- |
| commander | 12.1.0 | 无 / 无 |
| marked | 17.0.5 | 无 / 无；要求 Node >=20 |
| playwright | 1.56.1 | playwright-core 1.56.1；可选 fsevents 2.3.2 / 无 |
| playwright-core | 1.56.1 | 无 / 无 |
| fsevents（不安装） | 2.3.2 | 无 / node-gyp rebuild；通过 --omit=optional 排除 |

Playwright 的 detached 命中逐处核对：cdpRelay 启动用户浏览器，outofprocess 启动 driver，processLauncher 为浏览器进程组清理设置 detached；均为可解释的浏览器生命周期行为。未见恶意包的环境变量采集或 GitHub 外传链路。此检查属于人工静态风险核查，不是第三方全量源码形式化审计。

npm bulk advisory 对以上五个确定版本查询返回 `{}`。新 lockfile 只能解析这五个已核查包，安装前再次核对 resolved 域名、版本、integrity。先 `npm install --package-lock-only --ignore-scripts --omit=optional` 生成锁，再 `npm ci --ignore-scripts --omit=optional`，最后 npm audit。禁止安装 `@openclaw-cn/toutiao-ops` 发布包。浏览器二进制仅在检查 Playwright browsers.json 下载版本/来源后单独准备。

首次 urllib 请求遇到本机 Python CA 缺失，改用系统 curl；没有关闭 TLS 验证或修改系统配置。

## 外部证据

- [GitLab GMS-2026-373](https://advisories.gitlab.com/npm/@openclaw-cn/toutiao-ops/GMS-2026-373/)：明确受影响版本 `=1.2.4`。
- [上游 Issue #2](https://github.com/mf-yang/toutiao-ops/issues/2)：维护者确认账号被入侵，投毒包有约 499 KB 混淆入口、bun preinstall。
- [上游 Issue #3](https://github.com/mf-yang/toutiao-ops/issues/3)：草稿假成功；本地源码也独立证实该分支没有提交动作。
- [npm registry](https://registry.npmjs.org/commander/12.1.0)、[Playwright](https://registry.npmjs.org/playwright/1.56.1)、[Marked](https://registry.npmjs.org/marked/17.0.5)：版本及完整性来源。

## 安装与最终验证补充

- 已逐项检查生成的 lockfile：仅上述五个包，resolved 均为 registry.npmjs.org，具 SHA-512 integrity；本项目自身不在依赖图中，不会解析到恶意 1.2.4。
- 已执行 npm ci --ignore-scripts --omit=optional，实际安装四个包，排除 fsevents；最终 npm audit --omit=optional --json 为零已知漏洞。
- 本地 Playwright install --dry-run 已确认官方 CDN 与 revision 1194；Node 26 解压挂起后仅停止本次安装进程，使用机器已有 Node 24 完成同一本地安装命令。后一次设置 PLAYWRIGHT_SKIP_BROWSER_GC=1，保留其他项目缓存。没有改全局运行时、禁用 TLS 或修改第三方依赖源码。
- 首轮为 33 项单测和 8 项受控页面测试；本轮可靠性修复后为 46 项单测和 14 项受控页面测试，均通过。未增加依赖或改变安装来源；真实平台尚未验证。完整结果见 TEST_REPORT.md。

## 未验证风险

没有真实登录、Cookie 导出、草稿或正式发文；当前头条页面选择器及编辑器能力待人工授权验收。依赖公告查询是时间点结果，不保证不存在未知漏洞。若后续确认这台机器曾执行恶意 1.2.4，必须停止登录/发布，在可信环境排查并轮换可能暴露的凭据，单纯卸载不足以恢复可信状态。

## 2026-11-20 Ego 草稿版依赖变更

从安装清单和锁文件移除 Playwright、playwright-core 及其可选依赖 fsevents。保留的 commander 12.1.0 与 marked 17.0.5 沿用既有锁文件的版本、下载地址和完整性摘要。使用禁用安装脚本的离线 npm ci 重新安装，npm ls 核对安装树只有这两项。Ego Lite 为单独安装的本机运行时。

## Vue 工作台依赖

新增 `@vue/runtime-dom` 3.5.45，传递依赖为同版本的 `@vue/runtime-core`、`@vue/reactivity`、`@vue/shared` 及 `csstype` 3.2.4。核对了 npm registry 下载地址、SHA-512 完整性摘要、上游仓库及 MIT 许可证。新增包未声明 preinstall、install 或 postinstall。使用 `npm ci --ignore-scripts --omit=optional` 安装后，`npm audit --omit=optional` 报告零条已知漏洞。工作台只对浏览器提供锁定的 Vue 运行时文件。
