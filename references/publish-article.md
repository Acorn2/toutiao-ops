# 长文章入口（本地 Fork V1）

当前参数和验收要求以 [docs/ARTICLE_PUBLISHER_V1.md](../docs/ARTICLE_PUBLISHER_V1.md) 为准。

必须指定 --dry-run 或 --draft，写操作显式 --account。Ego 草稿模式等待原生编辑器自动保存。草稿只有回查 ID、正文、图片位置与封面后才能认定成功。

```bash
node cli/index.js publish article --title "离线预览" --content-file /absolute/path/article.md --dry-run
```

两个真实账号的验收稿已接续补齐并重开核对，默认 Ego 流程已完成一次完整图文稿新建与回查。选择器不匹配时保守退出；请勿用正式发表测试草稿问题。

省略 --title 可读取 Markdown 文件开头 H1；--dry-run --preview-file /existing/directory/preview.html 可新建离线 HTML。版本 2 正文验证保留结构与代码原字符，旧版摘要不自动升级。
