import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { redact, writeResultFile } from '../src/result.js';
import { getAccountDir, ensurePrivateDir, assertLocalPath, writePrivateJson } from '../src/account-store.js';
import { verifyIdentity } from '../src/auth-guard.js';

const dir = mkdtempSync(join(tmpdir(), 'toutiao-security-'));
const preloader = join(dir, 'offline.mjs');
writeFileSync(preloader, `globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };\nimport { syncBuiltinESMExports } from 'node:module';\nimport os from 'node:os';\nos.homedir = () => ${JSON.stringify(dir)};\nimport net from 'node:net';\nimport dns from 'node:dns';\nnet.Socket.prototype.connect = () => { throw new Error('NETWORK_FORBIDDEN'); };\ndns.lookup = () => { throw new Error('DNS_FORBIDDEN'); };\nsyncBuiltinESMExports();\n`);
const invoke = args => {
  const run = spawnSync(process.execPath, ['--import', preloader, resolve('index.js'), ...args], { encoding: 'utf8' });
  return { ...run, result: JSON.parse(run.stdout) };
};
test('CLI dry-run 返回单个 JSON，不访问网络或加载浏览器', () => {
  const run = spawnSync(process.execPath, ['--import', preloader, resolve('index.js'), 'publish', 'article', '--title', '本地测试', '--content', '## 正文\n\n仅本地', '--dry-run'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, 'validated'); assert.equal(result.verified, false); assert.equal(run.stderr, '');
});
test('禁止网络时 CLI 仍能提取文件标题并导出离线 HTML', () => {
  const source = join(dir, 'offline.md');
  const preview = join(dir, 'offline.html');
  writeFileSync(source, '# 完全离线预览\n\n**正文**');
  const run = spawnSync(process.execPath, ['--import', preloader, resolve('index.js'), 'publish', 'article', '--content-file', source, '--dry-run', '--preview-file', preview], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.title, '完全离线预览');
  assert.equal(result.preview_file, preview); assert.equal(result.verified, false);
  assert.match(readFileSync(preview, 'utf8'), /<strong>正文<\/strong>/);
});
test('CLI 参数失败均为 JSON 和非零退出码', () => {
  for (const args of [
    ['publish', 'article', '--dry-run', '--content', '正文'],
    ['publish', 'article', '--title', '测试标题', '--content-file', '/nonexistent/article.md', '--dry-run'],
    ['publish', 'article', '--title', '测试标题', '--content', '正文', '--draft'],
    ['publish', 'article', '--title', '测试标题', '--content', '正文', '--draft', '--publish'],
    ['publish', 'article', '--title', '测试标题', '--content', '正文', '--account', '../a', '--dry-run'],
    ['--account', 'account_a', 'publish', 'article', '--account', 'account_b', '--title', '测试标题', '--content', '正文', '--dry-run'],
    ['publish', 'video'], ['--unknown'],
  ]) {
    const run = invoke(args); assert.equal(run.status, 1, JSON.stringify(args)); assert.equal(run.result.success, false); assert.equal(run.stderr, '');
  }
});
test('--account 支持命令前后，旧发表和浏览器入口在解析时拒绝', () => {
  for (const args of [
    ['--account', 'account_a', 'publish', 'article'],
    ['publish', 'article', '--account', 'account_b'],
  ]) {
    const run = invoke([...args, '--title', '测试标题', '--content', '正文', '--dry-run']);
    assert.equal(run.status, 0); assert.match(run.result.account, /^account_[ab]$/);
  }
  for (const flag of ['--publish', '--confirm-publish', '--headless']) {
    const run = invoke(['publish', 'article', '--account', 'fixture', '--draft', flag]);
    assert.equal(run.status, 1);
    assert.equal(run.result.error_code, 'CLI_ARGUMENT_ERROR');
  }
  assert.equal(invoke(['auth', 'login', '--account', 'fixture']).status, 1);
  assert.equal(invoke(['publish', 'article', '--dry-run', '--browser', 'other']).result.error_code, 'BROWSER_UNSUPPORTED');
});
test('结果文件不覆盖正文、现有文件或符号链接', () => {
  const path = join(dir, 'result.json');
  writeResultFile(path, { success: true });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => writeResultFile(path, { success: false }), { code: 'EEXIST' });
  const run = invoke(['publish', 'article', '--title', '测试标题', '--content', '正文', '--dry-run', '--result-file', path]);
  assert.equal(run.result.error_code, 'RESULT_FILE_EXISTS');
  assert.deepEqual(JSON.parse(readFileSync(path)), { success: true });
});
test('递归日志脱敏覆盖 Cookie、令牌、认证、私钥与 URL', () => {
  const value = { cookie: 'session=abc', nested: [{ Authorization: 'Bearer abc', message: 'GH_TOKEN=123\nhttps://example.com/?access_token=abc' }], more: 'ghp_1234567890 npm_1234567890 Bearer abc', privateKey: 'abc' };
  const text = JSON.stringify(redact(value));
  for (const secret of ['session=abc', 'Bearer abc', 'GH_TOKEN=123', 'access_token=abc', 'ghp_1234567890', 'npm_1234567890']) assert.ok(!text.includes(secret), secret);
});
test('账号目录分离、权限收紧、拒绝符号链接', () => {
  assert.notEqual(getAccountDir('account_a', dir), getAccountDir('account_b', dir));
  const path = ensurePrivateDir(join(dir, 'private'));
  assert.equal(statSync(path).mode & 0o777, 0o700);
  writePrivateJson(join(path, 'meta.json'), { userId: 'fixture' });
  assert.equal(statSync(join(path, 'meta.json')).mode & 0o777, 0o600);
  symlinkSync(path, join(dir, 'alias'));
  assert.throws(() => assertLocalPath(join(dir, 'alias')), { code: 'UNSAFE_SESSION_PATH' });
});
test('稳定 ID 比较，不因昵称相同就放行', () => {
  assert.throws(() => verifyIdentity({ userId: '2', username: '同名' }, { userId: '1', username: '同名' }), { code: 'ACCOUNT_MISMATCH' });
  assert.throws(() => verifyIdentity({ userId: '1' }, null), { code: 'ACCOUNT_UNBOUND' });
  verifyIdentity({ userId: '1' }, { userId: '1' });
});
test('未绑定账号在本地提示绑定 Ego Profile', () => {
  const run = invoke(['auth', 'check', '--account', 'fixture_unbound']);
  assert.equal(run.status, 1);
  assert.equal(run.result.action, 'auth_check');
  assert.equal(run.result.error_code, 'EGO_ACCOUNT_UNBOUND');
});
test('首次绑定限制新别名格式，已有别名仍按原规则核对身份', () => {
  const bind = account => invoke(['auth', 'bind-ego', '--account', account, '--profile-id', 'fixture-profile']);
  for (const account of ['fixture_new', 'fixture--new', 'fixture-', '2fixture']) {
    const run = bind(account);
    assert.equal(run.status, 1, account);
    assert.equal(run.result.error_code, 'INVALID_ACCOUNT', account);
  }
  for (const account of ['fixture', 'fixture-new-2', 'f'.repeat(64)]) {
    assert.equal(bind(account).result.error_code, 'IDENTITY_CONFIRMATION_REQUIRED', account);
  }
  assert.equal(bind('f'.repeat(65)).result.error_code, 'INVALID_ACCOUNT');

  const legacy = 'fixture_legacy';
  const meta = { userId: '100', egoProfileId: 'fixture-profile' };
  const metaPath = join(getAccountDir(legacy, join(dir, '.toutiao-ops')), 'meta.json');
  writePrivateJson(metaPath, meta);
  const rebind = invoke(['auth', 'bind-ego', '--account', legacy, '--profile-id', 'fixture-profile', '--expect-user-id', '200']);
  assert.equal(rebind.result.error_code, 'ACCOUNT_MISMATCH');
  assert.deepEqual(JSON.parse(readFileSync(metaPath, 'utf8')), meta);
});
