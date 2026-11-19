#!/usr/bin/env node
import { Command } from 'commander';
import { publishArticle } from './src/publish-article.js';
import { redact, failureResult, validateResultFile, writeResultFile } from './src/result.js';
import { validateAccount } from './src/account-store.js';
import { fail, OperationError } from './src/errors.js';

function parseAccount(value, previous) {
  validateAccount(value);
  if (previous && previous !== value) fail('ACCOUNT_CONFLICT', '多次指定的 --account 不一致，停止操作');
  return value;
}

const program = new Command();
program.exitOverride().configureOutput({ writeErr: () => {} });
program.name('toutiao-ops').description('今日头条长文章 CLI（本地源码版）').version('0.1.4-article-v1')
  .option('--account <alias>', '显式指定账号别名', parseAccount);

async function run(fn, options, command) {
  const opts = { ...options, account: command.optsWithGlobals().account };
  let result;
  if (command.parent?.name() === 'auth') opts.action = `auth_${command.name()}`;
  try {
    if (options.account && program.opts().account && options.account !== program.opts().account) fail('ACCOUNT_CONFLICT', '命令前后的 --account 不一致，停止操作');
    validateResultFile(opts.resultFile); result = await fn(opts);
  }
  catch (error) { result = failureResult(opts, error); }
  result = redact(result);
  try { writeResultFile(opts.resultFile, result); }
  catch { result.result_file_error = '结果文件未写入；不会覆盖已有文件，请以 stdout 为准'; }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.success === false) process.exitCode = result.status === 'unverified' ? 2 : 1;
}

const auth = program.command('auth').description('人工登录与账号隔离');
for (const [name, method, description] of [
  ['login', 'doLogin', '仅显式调用时打开浏览器，人工扫码并绑定身份'],
  ['bind-ego', 'bindEgo', '核对并绑定独立的 Ego 浏览器 Profile'],
  ['check', 'checkLogin', '只读核对登录态与绑定身份'],
  ['logout', 'doLogout', '将本地会话归档（不删除，不撤销服务端会话）'],
  ['list', 'listAccounts', '列出本地别名，不启动浏览器'],
]) {
  const command = auth.command(name).description(description)
    .option('--account <alias>', '账号别名（也可放在命令之前）', parseAccount)
    .option('--result-file <path>', '将脱敏结果写入新文件');
  if (name === 'check') command.option('--headless', '无头模式');
  if (name === 'login' || name === 'bind-ego') command.option('--expect-user-id <id>', '首次绑定必填：预期平台主页数字账号 ID');
  if (name === 'bind-ego') command.option('--profile-id <id>', 'Ego 浏览器 Profile ID');
  command.action(async (opts, cmd) => run(async options => {
    if (name !== 'list') {
      if (!options.account) fail('ACCOUNT_REQUIRED', '账号操作必须显式指定 --account');
      validateAccount(options.account);
    }
    const module = await import('./src/auth.js');
    return module[method](options);
  }, opts, cmd));
}

const drafts = program.command('drafts').description('登记待发稿、存草稿与查看总览');
for (const [name, description] of [
  ['add', '登记一篇稿件的待存草稿任务'],
  ['run', '依次处理指定账号的待存草稿任务'],
  ['overview', '刷新离线发稿总览 HTML 并输出 JSON'],
  ['open', '刷新总览并在系统默认浏览器打开'],
]) {
  const command = drafts.command(name).description(description).option('--result-file <path>', '将 JSON 结果写入新文件');
  const needsAccount = name === 'add' || name === 'run';
  if (needsAccount) command.option('--account <alias>', '显式指定目标账号', parseAccount);
  if (name === 'add') command.requiredOption('--content-file <path>', 'UTF-8 稿件路径')
    .option('--title <text>', '标题；默认读取 Markdown 开头 H1').option('--format <format>', 'markdown / text', 'markdown');
  if (name === 'run') command.option('--id <uuid>', '处理或回查指定任务');
  if (name === 'open') command.option('--sync', '只读刷新 Ego 账号昵称并逐页同步已发布文章');
  command.action(async (opts, cmd) => run(async options => {
    if (needsAccount && !options.account) fail('ACCOUNT_REQUIRED', '稿件操作必须显式指定账号');
    const { createDraftQueue } = await import('./src/draft-queue.js');
    return createDraftQueue()[name](options);
  }, opts, cmd));
}

program.command('publish').command('article').description('校验、保存草稿或正式提交长文章（必须选择动作）')
  .option('--account <alias>', '写操作必须显式指定账号', parseAccount)
  .option('--title <text>', '2–30 字符标题；省略时尝试读取文件开头 H1')
  .option('--content <text>', '兼容内联正文，优先使用文件')
  .option('--content-file <path>', 'UTF-8 Markdown 文件，优先于 --content')
  .option('--format <format>', 'markdown / text', 'markdown')
  .option('--cover <path>', '本地 PNG/JPEG/WebP 封面')
  .option('--cover-mode <mode>', 'single / none；Ego 默认按正文配图数量选择封面')
  .option('--first-publish', '勾选头条首发')
  .option('--collection <name>', '合集名称')
  .option('--declaration <items>', '作品声明，逗号分隔')
  .option('--no-weitoutiao', '兼容旧参数；V1 始终关闭同步微头条')
  .option('--dry-run', '仅本地校验，输出 HTML 预览')
  .option('--preview-file <path>', 'dry-run：将含图片的离线 HTML 写入新文件')
  .option('--draft', '保存真实草稿并回查正文')
  .option('--browser <engine>', '草稿浏览器 ego（默认）/ playwright（兼容）')
  .option('--publish', '明确授权正式提交（可能进入审核）')
  .option('--confirm-publish', '--publish 的等价别名')
  .option('--headless', '无头模式')
  .option('--result-file <path>', '将脱敏结果写入新文件')
  .action(async (opts, cmd) => { delete opts.weitoutiao; await run(publishArticle, opts, cmd); });

try { await program.parseAsync(); }
catch (error) {
  if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') process.exitCode = 0;
  else {
    const result = error instanceof OperationError ? failureResult({}, error) : failureResult({}, { code: 'CLI_ARGUMENT_ERROR' }, { message: '命令或参数无效，请使用 --help 查看支持的入口' });
    process.stdout.write(JSON.stringify(redact(result), null, 2) + '\n');
    process.exitCode = 1;
  }
}
