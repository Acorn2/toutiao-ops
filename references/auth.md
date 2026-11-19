# 账号与人工登录（本地 Fork V1）

详细步骤见 [docs/ARTICLE_PUBLISHER_V1.md](../docs/ARTICLE_PUBLISHER_V1.md)。

每个别名独立保存在 ~/.toutiao-ops/accounts/<alias>/。别名仅允许小写。禁止路径分隔符、路径穿越、符号链接及旧大小写目录冲突，不自动迁移。登录、检查、退出与文章操作共享 ~/.toutiao-ops/locks/<alias>.lock。平台操作显式指定 --account，不回退到 default。

首次绑定须提供用户确认的目标主页数字 ID；CLI 不根据昵称确认身份。登录过期会返回错误，不自动扫码或切号。

```bash
node cli/index.js auth list
# 以下为真实账号交互，必须先得到用户授权；ID 为占位符，须替换。
node cli/index.js auth login --account account_a --expect-user-id <A的数字ID>
node cli/index.js auth check --account account_a
```

人工扫码时 stderr 输出 waiting_for_scan、截图路径与提示，stdout 仅一个最终 JSON。二维码不自动刷新，过期或验证码需用户在浏览器内处理。

`auth logout --account <alias>` 仅将本地会话归档到 ~/.toutiao-ops/archive/，不删除或撤销平台会话。归档含凭据，不要提交或共享。不同别名可独立检查，同一账号不要并发操作。
