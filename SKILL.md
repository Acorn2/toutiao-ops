---
name: 今日头条长文章草稿助手
description: 本地预览头条号长文章，使用指定账号的 Ego 浏览器 Profile 将稿件保存到草稿箱并核对正文。
version: 1.0.2-article-v1
---

# 头条号草稿工作流

先读 docs/SECURITY_AUDIT.md、docs/ARTICLE_PUBLISHER_V1.md、docs/TEST_REPORT.md 和 AGENTS.md。

1. 根据用户给的稿件和素材整理标题、段落和图片位置。保留原稿，另存 UTF-8 Markdown，首个非空块可用一级标题。正文配图引用稿件目录内的本地文件。默认从正文自动选择封面，用户指定单图封面时传 `--cover`。素材缺失时如实说明。
2. 由 Agent 调用本仓库的 `node cli/index.js` 执行 `--dry-run`。先验证整理后的稿件和配图，按需用 `--preview-file` 生成可打开的离线预览。依赖从 `cli/package-lock.json` 安装，使用 `npm ci --ignore-scripts --omit=optional`。禁用远程 npx 和原发布包。
3. 为每个头条号使用单独的 Ego Profile。已有有效会话可用 `auth bind-ego` 绑定；新别名优先用昵称的小写拼音，词间用 `-`，重名可加 `-2`，不加通用前缀。首次绑定核对预期数字账号 ID。已有别名保持原样。登录失效或出现安全验证时由用户处理。
4. 用户指定稿件、账号和存草稿动作后，显式执行 `--draft`，默认使用 Ego。将 Markdown 作为富文本粘贴，按原位置上传本地正文图片。每张图的 Markdown 替代文字填写到头条的图片描述栏，空白时取文件名，最多 50 字。有正文配图时默认用第一张作为单图封面，所有配图按原位置保留。存稿失败时保持原操作记录。Agent 流程止于草稿箱。
5. 只有 `status: draft_saved` 且 `verified: true` 才报告已存草稿。返回账号别名、标题和可用的草稿入口。出现 `unverified` 时，先核对后台是否已有草稿，禁止改用正式提交或重复新建。客户端首次接入前，先完成一次真实账号的单篇草稿验收。

默认 Ego 流程使用头条的「外部链接」工具处理 Markdown 识别出的站外裸网址。保留段落位置和引导文字，核对原生链接的目标地址后移除重复的裸网址。头条生成显示标题。重开回查核对链接地址和位置，失败的任务标为待处理。

用户需要跨账号总览时，通过 `drafts add --account <alias> --content-file <path>` 将稿件登记进队列。获得存稿授权后，按账号执行 `drafts run`。用 `drafts overview` 刷新本地总览。按任务编号恢复结果不明的任务时，仅回查平台记录。

以下命令供 Agent 执行。使用实际的稿件、可选封面和小写账号别名。

```bash
node cli/index.js publish article --content-file /absolute/path/article.md --dry-run
node cli/index.js auth bind-ego --account tamen-houlai --profile-id '<Ego Profile ID>' --expect-user-id '<头条号数字 ID>'
node cli/index.js publish article --account tamen-houlai --content-file /absolute/path/article.md --draft
```

stdout 是最终 JSON，诊断和操作记录仅存本机。来源与 MIT 归属见 NOTICE.md 和 LICENSE。
